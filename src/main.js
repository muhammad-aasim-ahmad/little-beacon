// Boot, main loop, screen transitions and save orchestration.
import { loadAssets } from './assets.js';
import * as M from './model.js';
import { step, STEP } from './simulation.js';
import { Renderer } from './render.js';
import { createUI } from './ui.js';
import * as Store from './storage.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG_FAST = Math.max(1, Math.min(50, Number(params.get('fast')) || 1)); // testing only
const MAX_STEPS = 5 * DEBUG_FAST;
const AUTOSAVE_EVERY = 15;

const app = {
  w: null, assets: null, renderer: null, ui: null,
  settings: Store.loadSettings(),
  storageOk: true, dirty: false, sinceSave: 0,
  view: { tool: null, buildType: null, moveRoomId: null, moveType: null, hover: null, hoverOk: false, hoverReason: '', cursor: null, selected: null, paletteOpen: false, reducedMotion: false },
};
window.littleBeacon = app; // handy for debugging in the console

// ---------- commands ----------
app.command = (fn, ...args) => {
  if (!app.w) return { ok: false, reason: 'No run' };
  const r = fn(app.w, ...args);
  if (!r.ok) app.ui.announce(r.reason, true);
  else app.markDirty();
  flushEvents();
  app.ui.refresh(true);
  return r;
};
app.markDirty = () => { app.dirty = true; };

app.togglePause = () => {
  const s = app.w?.s;
  if (!s || s.phase === 'results' || s.phase === 'review') return;
  s.paused = !s.paused;
  app.ui.announce(s.paused ? 'Paused' : 'Resumed');
  if (s.paused) app.saveNow(false);
  app.ui.refresh(true);
};
app.setSpeed = (v) => {
  const s = app.w?.s;
  if (!s || s.phase !== 'playing') return;
  s.speed = v;
  app.ui.refresh(true);
};

app.saveNow = (manual) => {
  if (!app.w) return;
  const ok = Store.saveRun(app.w.s, app.assets.balance);
  app.storageOk = ok;
  if (ok) { app.dirty = false; app.sinceSave = 0; }
  if (manual) app.ui.announce(ok ? 'Saved' : 'Could not save to browser storage. Use Export.', !ok);
};
app.exportSave = () => { if (app.w) Store.exportRun(app.w.s); };

app.openPause = () => {
  const s = app.w?.s;
  if (!s) return;
  if (s.phase === 'playing' || s.phase === 'rescue') s.paused = true;
  app.ui.refresh(true);
  $('d-pause').showModal();
};

function flushEvents() {
  const w = app.w;
  if (!w || !w.events.length) return;
  const evs = w.events.splice(0);
  for (const e of evs) {
    if (e.save) app.dirty = true;
    if (e.fx) app.renderer.addFx(e.fx.kind, 192 + 32 * e.fx.c + 8, 128 + 32 * e.fx.d + 8, w.s.simTime);
  }
  app.ui.handleEvents(evs);
  if (evs.some((e) => e.save)) app.saveNow(false);
  if (evs.some((e) => e.type === 'results')) showResults();
}

// ---------- runs ----------
function startWorld(state) {
  const B = app.assets.balance;
  app.w = M.createWorld(B, state || undefined);
  M.computePower(app.w.s, B);
  app.ui.reset();
  app.view.cursor = { a: 'S', c: 1, r: 0, inGrid: true };
  $('app').hidden = false;
  closeDialogs();
  app.ui.refresh(true);
  resize();
}

function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); }

function confirmDialog(title, bodyNodes, yesLabel = 'Confirm') {
  return new Promise((resolve) => {
    const d = $('d-confirm');
    $('c-title').textContent = title;
    $('c-body').replaceChildren(...bodyNodes);
    $('c-yes').textContent = yesLabel;
    const done = (v) => { d.close(); $('c-yes').onclick = $('c-no').onclick = null; resolve(v); };
    $('c-yes').onclick = () => done(true);
    $('c-no').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    d.showModal();
  });
}
const p = (text) => { const el = document.createElement('p'); el.textContent = text; return el; };

async function newRun() {
  const existing = Store.loadRun(app.assets.balance).state;
  if (existing && !existing.rescued) {
    const yes = await confirmDialog('Start a new run?', [p('This replaces your current saved run in this browser. Export it first if you want to keep it.')], 'Start new run');
    if (!yes) { showTitle(); return; }
  }
  startWorld(null);
  app.saveNow(false);
  app.view.selected = { a: 'U', c: 1, r: 0 };
  app.view.cursor = { a: 'U', c: 1, r: 0, inGrid: true };
  app.ui.showHint('start');
  app.ui.refresh(true);
  $('world').focus();
}

function continueRun() {
  const r = Store.loadRun(app.assets.balance);
  if (!r.state) {
    showTitle(r.error ? `Your saved run could not be loaded (${r.error}). Import a save or start a new run.` : 'No saved run found.');
    return;
  }
  r.state.paused = r.state.phase === 'playing' || r.state.phase === 'rescue';
  startWorld(r.state);
  if (r.source === 'backup') app.ui.announce(`The latest save was damaged (${r.error}); restored the backup.`, true);
  if (r.state.phase === 'results') showResults();
  else if (r.state.paused) app.ui.announce('Loaded. Press Space or Resume to continue.');
}

function showTitle(notice = '') {
  closeDialogs();
  const r = Store.hasRun() ? Store.loadRun(app.assets.balance) : { state: null };
  const cont = $('t-continue');
  cont.disabled = !r.state && !r.error;
  cont.textContent = r.state?.rescued ? 'Review Outpost' : 'Continue';
  $('title-notice').hidden = !notice;
  $('title-notice').textContent = notice;
  $('d-title').showModal();
}

function showResults() {
  const s = app.w.s;
  const mins = Math.floor(s.activeSeconds / 60), secs = Math.floor(s.activeSeconds % 60);
  const rows = [
    ['Active time', `${mins} min ${String(secs).padStart(2, '0')} s`],
    ['Blocks mined', s.stats.blocks], ['Meals', s.stats.meals + s.stats.pastes], ['Rests', s.stats.rests],
  ];
  $('r-stats').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
  closeDialogs();
  $('d-results').showModal();
}

async function importSave() {
  const input = $('import-file');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let state;
    try { state = await Store.readImport(file, app.assets.balance); } catch (e) {
      app.ui?.announce(`Import failed: ${e.message}`, true);
      showTitle(`Import failed: ${e.message}`);
      return;
    }
    const mins = Math.floor(state.activeSeconds / 60);
    const yes = await confirmDialog('Import this save?', [
      p(`${state.rescued ? 'Rescued run' : 'Run in progress'}, ${mins} min active play.`),
      p(`Scrap ${state.inv.scrap}, regolith ${state.inv.regolith}, carbide ${state.inv.carbide}, rations ${state.inv.ration}. Blocks mined: ${state.stats.blocks}.`),
      p('It replaces the run saved in this browser.'),
    ], 'Import');
    if (!yes) { if (!app.w) showTitle(); return; }
    state.paused = state.phase === 'playing' || state.phase === 'rescue';
    startWorld(state);
    app.saveNow(false);
    if (state.phase === 'results') showResults();
  };
  input.click();
}

// ---------- loop ----------
let acc = 0, last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const w = app.w;
  if (w && !document.hidden) {
    const s = w.s;
    const live = (s.phase === 'playing' || s.phase === 'rescue') && !s.paused && !document.querySelector('dialog[open]');
    if (live) {
      s.activeSeconds += dt;
      acc += dt * s.speed * DEBUG_FAST;
      let n = 0;
      while (acc >= STEP && n < MAX_STEPS) { step(w, STEP); acc -= STEP; n++; }
      if (n === MAX_STEPS) acc = 0; // drop backlog after a stall
      app.sinceSave += dt;
      if (app.dirty && app.sinceSave >= AUTOSAVE_EVERY) app.saveNow(false);
    }
    flushEvents();
    app.view.reducedMotion = app.settings.reducedMotion;
    app.renderer.draw(w, app.view);
    app.ui.refresh();
  }
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  acc = 0;
  const s = app.w?.s;
  if (!s) return;
  if (document.hidden) {
    if (s.phase === 'playing' || s.phase === 'rescue') s.paused = true;
    app.saveNow(false);
  } else if (s.paused && (s.phase === 'playing' || s.phase === 'rescue') && !document.querySelector('dialog[open]')) {
    app.openPause();
  }
});

// ---------- layout ----------
function resize() {
  const canvas = $('world');
  const wrap = $('canvas-wrap');
  const avail = Math.max(240, wrap.parentElement.clientWidth - 4);
  const availH = Math.max(320, window.innerHeight - 250);
  let scale = 3;
  while (scale > 1 && (480 * scale > avail || 320 * scale > availH)) scale--;
  if (480 * scale > avail) scale = avail / 480; // fractional fallback on very narrow screens
  canvas.style.width = `${Math.floor(480 * scale)}px`;
  canvas.style.height = `${Math.floor(320 * scale)}px`;
  app.renderer.ctx.imageSmoothingEnabled = false;
}
window.addEventListener('resize', resize);

// ---------- dialogs ----------
function wireDialogs() {
  $('d-title').addEventListener('cancel', (e) => e.preventDefault());
  $('d-results').addEventListener('cancel', (e) => e.preventDefault());
  $('t-new').addEventListener('click', () => { $('d-title').close(); newRun(); });
  $('t-continue').addEventListener('click', continueRun);
  $('t-import').addEventListener('click', importSave);
  $('t-settings').addEventListener('click', () => openSettings($('d-title')));
  $('p-resume').addEventListener('click', () => { $('d-pause').close(); });
  $('d-pause').addEventListener('close', () => {
    const s = app.w?.s;
    if (s && (s.phase === 'playing' || s.phase === 'rescue')) s.paused = false;
    acc = 0; app.ui.refresh(true);
  });
  $('p-save').addEventListener('click', () => app.saveNow(true));
  $('p-export').addEventListener('click', app.exportSave);
  $('p-import').addEventListener('click', () => { $('d-pause').close(); if (app.w) app.w.s.paused = true; importSave(); });
  $('p-settings').addEventListener('click', () => openSettings($('d-pause')));
  $('p-title-btn').addEventListener('click', () => { app.saveNow(false); if (app.w) app.w.s.paused = true; $('d-pause').close(); app.w.s.paused = true; showTitle(); });
  $('r-review').addEventListener('click', () => {
    app.w.s.phase = 'review'; app.saveNow(false); $('d-results').close(); app.ui.refresh(true);
    app.ui.announce('Reviewing the outpost. Start a new run from the Menu.');
  });
  $('r-new').addEventListener('click', () => { $('d-results').close(); startWorld(null); app.saveNow(false); app.ui.showHint('start'); });
  $('s-motion').addEventListener('change', (e) => {
    app.settings.reducedMotion = e.target.checked;
    document.body.classList.toggle('reduced', e.target.checked);
    Store.saveSettings(app.settings);
  });
}

function openSettings(from) {
  const d = $('d-settings');
  $('s-motion').checked = app.settings.reducedMotion;
  from.close();
  if (from.id === 'd-pause' && app.w) app.w.s.paused = true;
  $('s-close').onclick = () => { d.close(); from.showModal(); if (from.id === 'd-pause' && app.w) app.w.s.paused = true; };
  d.oncancel = (e) => { e.preventDefault(); $('s-close').onclick(); };
  d.showModal();
}

// ---------- boot ----------
async function boot() {
  $('retry').hidden = true;
  $('loading-text').textContent = 'Loading Little Beacon…';
  try {
    app.assets = await loadAssets();
  } catch (e) {
    $('loading-text').textContent = `Loading failed: ${e.message}. Serve the folder over HTTP and retry.`;
    $('retry').hidden = false;
    return;
  }
  app.renderer = new Renderer($('world'), app.assets);
  app.ui = createUI(app);
  document.body.classList.toggle('reduced', app.settings.reducedMotion);
  wireDialogs();
  $('loading').hidden = true;
  showTitle();
  requestAnimationFrame(frame);
}
$('retry').addEventListener('click', boot);
boot();
