// DOM views, input handling, inspector, job list, hints and announcements.
import * as M from './model.js';
import { pointerCell } from './render.js';
import { COLS } from './path.js';

const $ = (id) => document.getElementById(id);

// Small element helper; text is always set with textContent.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('data-') || k.startsWith('aria-') || ['type', 'title', 'disabled', 'style', 'role'].includes(k)) el.setAttribute(k, v === true ? '' : v);
    else el[k] = v;
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const fmt = (sec) => {
  sec = Math.max(0, Math.ceil(sec));
  return sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec} s`;
};
const cellName = (a, c, r) => (a === 'S' ? (r === 0 ? `ground floor, column ${c + 1}` : `floor ${r}, column ${c + 1}`) : `depth ${r}, column ${c + 1}`);

const UNIQUE_TEXT = {
  rock: 'Echo geode: in the rock', geode: 'Raw echo geode', separating: 'Geode in the sifter',
  crystal: 'Echo crystal', building: 'Crystal reserved for beacon', installed: 'Crystal installed',
};

const HINTS = {
  start: 'Press Mine (M) and click a grey block at depth 0, or Build (B) a workshop next to the shelter. One astronaut does the queued jobs in order.',
  workshop: 'Workshop complete. Build a sifter to turn regolith into carbide, and a solar panel on a slot with open sky for power.',
  carbide: 'First carbide! Select the workshop and choose Improve drill to unlock depths 1 to 3.',
  drill: 'Drill improved. Dig down the centre shaft. The echo geode waits at depth 3.',
  hunger: 'Hungry. Eat a ration (E) at the shelter or greenhouse. With no rations, the shelter makes emergency paste with a 2 minute cooldown. Below 20, work slows.',
  energy: 'Tired. Rest (R) in the shelter bed or a bunk. Machines keep running while the astronaut sleeps. Below 15, work slows.',
  geode: 'You found the echo geode! Select the sifter and choose Separate echo crystal.',
  crystal: 'The echo crystal is ready. Build the distress beacon on a surface slot with open sky.',
  beacon: 'Beacon built. Select it and press Activate. The 90 second broadcast needs 3 free power.',
};

export function createUI(app) {
  const { assets } = app;
  const B = assets.balance;
  const frames = assets.atlases.icons.frames;
  const canvas = $('world');
  const live = $('live');
  let hintQueue = [];
  let lastInspector = '', lastJobs = '', lastStations = '', lastCards = '', lastChain = '';

  // ---------- icons ----------
  document.documentElement.style.setProperty('--icons', `url("${assets.iconsUrl}")`);
  function paintIcon(el) {
    const f = frames[el.dataset.icon];
    if (f) { el.style.setProperty('--x', f[0]); el.style.setProperty('--y', f[1]); }
  }
  const icon = (id) => { const el = h('span', { class: 'ico', 'data-icon': id, 'aria-hidden': 'true' }); paintIcon(el); return el; };
  document.querySelectorAll('.ico[data-icon]').forEach(paintIcon);

  // ---------- HUD ----------
  const resList = $('resources');
  const resEls = {};
  for (const [k, ic, label] of [['scrap', 'scrap', 'Scrap'], ['regolith', 'regolith', 'Regolith'], ['carbide', 'carbide', 'Carbide'],
    ['unique', 'geode', ''], ['ration', 'ration', 'Rations'], ['power', 'power', 'Power']]) {
    const num = h('span', { class: 'num' });
    const lbl = h('span', { class: 'lbl', text: label });
    const ico = icon(ic);
    resList.append(h('li', { title: label || 'Echo item' }, ico, num, lbl));
    resEls[k] = { num, lbl, ico };
  }

  function updateHud(s) {
    for (const k of ['scrap', 'regolith', 'carbide', 'ration']) resEls[k].num.textContent = s.inv[k];
    const u = resEls.unique;
    u.ico.dataset.icon = ['crystal', 'building', 'installed'].includes(s.unique) ? 'crystal' : 'geode';
    paintIcon(u.ico);
    u.num.textContent = '';
    u.lbl.textContent = UNIQUE_TEXT[s.unique];
    const p = s.power;
    resEls.power.num.textContent = `${p.used}/${p.cap}`;
    resEls.power.lbl.textContent = p.demand > p.used ? `Power (needs ${p.demand}, some rooms off)` : 'Power used/capacity';
    resEls.power.num.classList.toggle('bad', p.demand > p.used);
    const a = s.astro;
    $('m-hunger').value = a.hunger; $('v-hunger').textContent = Math.floor(a.hunger);
    $('m-energy').value = a.energy; $('v-energy').textContent = Math.floor(a.energy);
    const fh = $('f-hunger'), fe = $('f-energy');
    fh.textContent = a.hunger < B.hunger.lowAt ? 'Hungry: work slowed' : a.hunger <= B.hunger.autoAt ? 'Hungry' : '';
    fh.classList.toggle('crit', a.hunger < B.hunger.lowAt);
    fe.textContent = a.energy < B.energy.lowAt ? 'Tired: work slowed' : a.energy <= B.energy.autoAt ? 'Tired' : '';
    fe.classList.toggle('crit', a.energy < B.energy.lowAt);
  }

  // ---------- action line ----------
  function actionText(s) {
    const a = s.astro;
    if (s.phase === 'rescue') return ['beacon', 'Boarding the rescue ship'];
    if (s.phase !== 'playing') return ['ok', 'Rescued. The outpost is quiet now.'];
    if (a.care) {
      const c = a.care;
      if (c.phase === 'travel' && c.type !== 'wait') return [c.type === 'sleep' ? 'rest' : 'eat', c.type === 'sleep' ? 'Walking to bed' : 'Walking to eat'];
      if (c.type === 'meal') return ['eat', `Eating a ration (${fmt(c.remaining)})`];
      if (c.type === 'paste') return ['eat', `Making emergency paste (${fmt(c.remaining)})`];
      if (c.type === 'wait') return ['warning', `Waiting at the shelter for paste (${fmt(s.pasteCooldown)})`];
      return ['rest', `Resting: energy ${Math.floor(a.energy)}/${B.energy.restTo}`];
    }
    const job = M.jobById(s, a.jobId);
    if (job) {
      const label = jobLabel(s, job);
      if (job.state === 'travelling') return ['inspect', `Walking to: ${label}`];
      const left = job.kind === 'mine' ? M.cellAt(s, job.c, job.d).work : job.work;
      const slow = a.hunger < B.hunger.lowAt || a.energy < B.energy.lowAt;
      return [job.kind === 'mine' ? 'mine' : 'build', `${label} (${fmt(left / (slow ? B.lowRate : 1))} left${slow ? ', slowed' : ''})`];
    }
    if (s.jobs.length) return ['warning', 'Idle: every queued job is blocked'];
    return ['inspect', 'Idle: queue work with Mine or Build'];
  }

  function jobLabel(s, j) {
    if (j.kind === 'mine') return `Mine depth ${j.d}, column ${j.c + 1}`;
    if (j.kind === 'research') return 'Improve drill';
    const room = M.roomById(s, j.roomId);
    return `Build ${B.buildings[room.type].name.toLowerCase()} (${cellName(room.a, room.c, room.r)})`;
  }

  // ---------- toolbar ----------
  function updateToolbar(s) {
    const v = app.view;
    const play = s.phase === 'playing';
    $('b-mine').setAttribute('aria-pressed', v.tool === 'mine');
    $('b-build').setAttribute('aria-pressed', v.tool === 'build');
    for (const id of ['b-mine', 'b-build']) $(id).disabled = !play;
    const er = M.eatReason(s, B), rr = M.restReason(s, B);
    $('b-eat').disabled = !!er; $('b-eat').title = er || 'Eat now';
    $('b-rest').disabled = !!rr; $('b-rest').title = rr || 'Rest to 85 energy';
    $('pause-label').textContent = s.paused ? 'Resume' : 'Pause';
    $('b-pause').disabled = s.phase === 'results' || s.phase === 'review';
    $('b-1x').setAttribute('aria-pressed', s.speed === 1);
    $('b-2x').setAttribute('aria-pressed', s.speed === 2);
    $('b-1x').disabled = $('b-2x').disabled = s.phase !== 'playing';
    $('c-auto').checked = s.autoCare;
    $('paused-badge').hidden = !s.paused || s.phase === 'results' || s.phase === 'review';
    $('storage-warning').hidden = app.storageOk;
    let tt = '';
    if (v.tool === 'mine') tt = 'Mine mode: click rock blocks to queue or unqueue them.';
    if (v.tool === 'build') tt = `Placing ${B.buildings[v.buildType]?.name || 'a room'}.`;
    if (v.tool === 'move') tt = 'Moving a room: click its new cell.';
    if (v.tool && v.hoverReason) tt += ` ${v.hoverOk ? '✓' : '✗'} ${v.hoverReason}`;
    $('tool-text').textContent = tt;
    $('palette').hidden = v.tool !== 'build' && !v.paletteOpen;
  }

  // ---------- build palette ----------
  function updateCards(s) {
    const rows = B.buildOrder.map((type) => {
      const def = B.buildings[type];
      let why = M.unlockReason(s, B, type);
      if (!why && M.countType(s, type) >= def.max) why = def.max === 1 ? 'Already built or queued' : `Limit of ${def.max} reached`;
      const miss = M.missingFor(s, def.cost);
      if (!why && miss.length) why = `Need ${miss.join(', ')}`;
      return { type, def, why, on: app.view.tool === 'build' && app.view.buildType === type };
    });
    const sig = JSON.stringify(rows.map((r) => [r.type, r.why, r.on]));
    if (sig === lastCards) return;
    lastCards = sig;
    const rooms = assets.atlases.rooms;
    $('cards').replaceChildren(...rows.map(({ type, def, why, on }) => {
      const f = rooms.frames[type];
      const pic = h('span', { class: 'room-pic', 'aria-hidden': 'true', style: `background:url("${new URL('../' + rooms.image, import.meta.url).href}") -${f[0]}px -${f[1]}px` });
      const extra = def.sky ? 'Surface with open sky. ' : def.cave ? 'Surface or cave. ' : 'Surface only. ';
      const power = def.supply ? `+${def.supply} power. ` : def.load ? `Uses ${def.load} power. ` : '';
      return h('li', { class: 'card' }, h('button', {
        type: 'button', 'data-action': 'pick', 'data-arg': type, 'aria-pressed': on ? 'true' : 'false', disabled: !!why,
        title: power + extra + def.info,
      },
      h('span', { class: 'top' }, pic, h('span', {}, def.name, h('span', { class: 'cost', text: `${M.costText(def.cost)} · ${def.work} s` }))),
      h('span', { class: 'info', text: power + extra }),
      why ? h('span', { class: 'why', text: why }) : null));
    }));
  }

  // ---------- goal chain ----------
  function updateChain(s) {
    const solar = s.rooms.some((m) => m.type === 'solar' && m.status === 'built');
    const steps = [
      ['Build a workshop', s.ever.workshop, 'Build (B) next to the shelter. 10 scrap.'],
      ['Mine the centre block at depth 0', M.cellAt(s, 1, 0).excavated, 'Mine (M). Gives scrap and regolith.'],
      ['Build a sifter', s.ever.sifter, 'Unlocked by the workshop. 12 scrap.'],
      ['Build a solar panel', solar, 'Needs open sky above it. +4 power.'],
      ['Make carbide in the sifter', s.drillUnlocked || s.inv.carbide >= 2, 'Select the sifter: 6 regolith → 2 carbide.'],
      ['Improve the drill', s.drillUnlocked, 'Select the workshop. 6 scrap and 2 carbide.'],
      ['Dig the centre shaft to depth 3', s.unique !== 'rock', 'The echo geode is at the bottom of the centre column.'],
      ['Separate the echo crystal', s.ever.crystal, 'Select the sifter. 1 geode and 2 carbide.'],
      ['Build the distress beacon', s.unique === 'installed', 'Surface slot with open sky. 18 scrap, 2 carbide, crystal.'],
      ['Broadcast for 90 seconds', s.phase !== 'playing', 'Select the beacon and Activate. Needs 3 free power.'],
    ];
    const now = steps.findIndex((x) => !x[1]);
    const sig = `${now}`;
    $('goal-next').textContent = now < 0 ? 'Rescued!' : steps[now][0];
    if (sig === lastChain) return;
    lastChain = sig;
    $('chain').replaceChildren(...steps.map(([label, done, why], i) => h('li', { class: done ? 'done' : i === now ? 'now' : 'later' },
      `${done ? '✓ ' : ''}${label}`, i === now ? h('span', { class: 'why', text: why }) : null)));
  }

  // ---------- inspector ----------
  function actionRow(label, action, arg, reason, primary = false) {
    return h('div', { class: 'act' },
      h('button', { type: 'button', class: primary ? 'primary small' : 'small', 'data-action': action, 'data-arg': arg, disabled: !!reason }, label),
      reason ? h('span', { class: 'reason', text: reason }) : null);
  }
  const progress = (frac, cls = '') => h('div', { class: `progress ${cls}`, role: 'presentation' }, h('span', { style: `width:${Math.round(frac * 100)}%` }));

  function inspector(s) {
    const sel = app.view.selected;
    if (!sel) return [h('p', { class: 'muted', text: 'Click a room or rock block to inspect it.' })];
    const { a, c, r } = sel;
    const room = M.roomAt(s, a, c, r);
    const out = [];
    const play = s.phase === 'playing';
    if (room) {
      const name = room.type === 'shelter' ? 'Crashed shelter' : B.buildings[room.type].name;
      out.push(h('h3', {}, `${name}${room.a === 'U' ? ' (cave)' : ''}`));
      const def = B.buildings[room.type];
      const dl = h('dl');
      const add = (k, v) => dl.append(h('dt', { text: k }), h('dd', { text: v }));
      add('Where', cellName(a, c, r));
      if (room.status === 'queued') {
        const job = s.jobs.find((j) => j.id === room.jobId);
        add('Status', `Queued: ${job.state.replaceAll('_', ' ')}`);
        add('Work left', fmt(job.work));
        out.push(dl, progress(1 - job.work / job.total));
        out.push(h('div', { class: 'actions' }, actionRow('Cancel build (refund)', 'cancel', job.id, play ? '' : 'The run is over')));
        return out;
      }
      if (room.type === 'shelter') {
        add('Power', `Supplies ${B.shelterSupply}`);
        add('Provides', 'Bed, emergency paste, life support');
        if (s.pasteCooldown > 0) add('Paste', `ready in ${fmt(s.pasteCooldown)}`);
        out.push(dl);
        return out;
      }
      const load = def.load;
      const on = !load || M.isPowered(s, room.type);
      add('Power', def.supply ? `Supplies ${def.supply}` : load ? (on ? `Uses ${load} (on)` : `Uses ${load}: OFF, not enough power`) : 'None');
      out.push(dl);
      const acts = h('div', { class: 'actions' });
      if (room.type === 'sifter') {
        if (s.batch) {
          const rec = B.recipes[s.batch.recipe];
          out.push(h('p', {}, `${rec.name}: ${fmt(s.batch.remaining)} left `, on ? null : h('span', { class: 'paused-text', text: 'Paused (no power)' })));
          out.push(progress(1 - s.batch.remaining / s.batch.total, 'cyan'));
          acts.append(actionRow('Cancel batch (refund inputs)', 'batch-cancel', '', ''));
        } else {
          acts.append(actionRow('Carbide batch: 6 regolith → 2 carbide (30 s)', 'batch', 'carbide', M.batchReason(s, B, 'carbide'), true));
          if (s.unique !== 'rock') {
            acts.append(actionRow('Separate echo crystal: geode + 2 carbide (60 s)', 'batch', 'echo', M.batchReason(s, B, 'echo'), true));
          } else acts.append(h('p', { class: 'muted', text: 'Echo separation unlocks once the geode at depth 3 is mined.' }));
        }
      }
      if (room.type === 'workshop') {
        const rj = s.jobs.find((j) => j.kind === 'research');
        if (s.drillUnlocked) acts.append(h('p', { class: 'okline', text: 'Drill improved: depths 1 to 3 unlocked' }));
        else if (rj) { out.push(h('p', { text: `Drill research: ${fmt(rj.work)} of work left` }), progress(1 - rj.work / rj.total)); }
        else acts.append(actionRow('Improve drill: 6 scrap, 2 carbide (35 s work)', 'drill', '', M.drillReason(s, B), true));
      }
      if (room.type === 'greenhouse') {
        const full = s.inv.ration >= B.greenhouse.cap;
        out.push(h('p', { text: full ? `Holding ${B.greenhouse.cap} rations: growth waits until you eat.` : on ? `Next ration in ${fmt(s.greenhouseTimer)}` : `Growth paused (no power), ${fmt(s.greenhouseTimer)} left` }));
        if (!full) out.push(progress(1 - s.greenhouseTimer / B.greenhouse.interval, 'green'));
      }
      if (room.type === 'beacon') {
        if (s.broadcast.active) {
          out.push(h('p', {}, `Broadcasting: ${fmt(s.broadcast.remaining)} left `, on ? null : h('span', { class: 'paused-text', text: 'Paused (no power)' })));
          out.push(progress(1 - s.broadcast.remaining / B.broadcast, 'cyan'));
          acts.append(actionRow('Stop broadcast (resets to 90 s)', 'beacon-off', '', ''));
        } else acts.append(actionRow('Activate distress broadcast (90 s)', 'beacon-on', '', M.beaconReason(s), true));
      }
      if (room.type === 'bunk') out.push(h('p', { class: 'muted', text: 'Auto care and Rest prefer this bunk (25% faster).' }));
      if (play) {
        acts.append(actionRow('Move room (free)', 'move', room.id, M.moveReason(w(), room.id)));
        acts.append(actionRow(`Salvage (refund ${M.costText(room.paid)})`, 'salvage', room.id, M.salvageReason(w(), room.id)));
      }
      out.push(acts);
      return out;
    }
    if (a === 'S') {
      out.push(h('h3', {}, r > 2 ? 'Open space' : 'Empty slot'));
      out.push(h('p', { class: 'muted', text: r > 2 ? 'Anchors cannot support another floor.' : `${cellName(a, c, r)}. Use Build to place a room here.` }));
      return out;
    }
    const cell = M.cellAt(s, c, r);
    const geode = c === B.geodeCell[0] && r === B.geodeCell[1];
    const dep = B.depths[r];
    out.push(h('h3', {}, cell.excavated ? 'Excavated cell' : `Rock: depth ${r}`));
    const dl = h('dl');
    const add = (k, v) => dl.append(h('dt', { text: k }), h('dd', { text: v }));
    add('Where', cellName(a, c, r));
    if (cell.excavated) {
      add('Use', 'Permanent ladder passage. A cave room can be built here.');
      out.push(dl);
      return out;
    }
    add('Work', `${fmt(cell.work)} of ${fmt(dep.work)}`);
    add('Yield', `${dep.scrap} scrap, ${dep.regolith} regolith${geode ? ', echo geode' : ''}`);
    out.push(dl);
    if (cell.work < dep.work) out.push(progress(1 - cell.work / dep.work));
    const job = s.jobs.find((j) => j.kind === 'mine' && j.c === c && j.d === r);
    const acts = h('div', { class: 'actions' });
    if (job) acts.append(actionRow('Cancel mining (progress kept)', 'cancel', job.id, ''));
    else {
      const res = previewMine(s, c, r);
      acts.append(actionRow('Mine this block', 'mine', `${c},${r}`, res, true));
    }
    out.push(acts);
    return out;
  }

  function previewMine(s, c, d) {
    if (s.phase !== 'playing') return 'The run is over';
    const cell = M.cellAt(s, c, d);
    if (cell.excavated) return 'Already excavated';
    if (d > 0 && !M.cellAt(s, c, d - 1).excavated) return 'Dig the block above first';
    if (B.depths[d].needsDrill && !s.drillUnlocked) return 'Needs improved drill';
    return '';
  }

  const w = () => app.w;

  function rebuild(container, nodes, sigRef) {
    const tmp = h('div', {}, nodes);
    const sig = tmp.innerHTML;
    if (sig === sigRef) return sigRef;
    const focused = document.activeElement?.closest?.('[data-action]');
    const fKey = focused && container.contains(focused) ? `${focused.dataset.action}|${focused.dataset.arg}` : null;
    container.replaceChildren(...tmp.childNodes);
    if (fKey) container.querySelector(`[data-action="${fKey.split('|')[0]}"][data-arg="${CSS.escape(fKey.split('|')[1])}"]`)?.focus();
    return sig;
  }

  // ---------- jobs ----------
  function jobsView(s) {
    return s.jobs.map((j, i) => {
      const claimed = j.id === s.astro.jobId;
      const total = j.kind === 'mine' ? B.depths[j.d].work : j.total;
      const left = j.kind === 'mine' ? M.cellAt(s, j.c, j.d).work : j.work;
      const state = j.state === 'blocked' ? `Blocked: ${j.blockReason}` : j.state.replaceAll('_', ' ');
      const ic = j.kind === 'mine' ? 'mine' : 'build';
      return h('li', {},
        h('span', { class: 'num', text: String(i + 1) }),
        h('span', {}, icon(ic), ` ${jobLabel(s, j)}`, h('span', { class: `state ${j.state}`, text: `${claimed ? 'Active: ' : ''}${state} · ${fmt(left)} left` })),
        h('span', { class: 'btns' },
          h('button', { type: 'button', class: 'small', 'data-action': 'up', 'data-arg': j.id, disabled: i === 0 || s.phase !== 'playing', title: 'Move up', 'aria-label': `Move ${jobLabel(s, j)} up` }, '↑'),
          h('button', { type: 'button', class: 'small', 'data-action': 'cancel', 'data-arg': j.id, disabled: s.phase !== 'playing', title: 'Cancel', 'aria-label': `Cancel ${jobLabel(s, j)}` }, '✗')),
        progress(1 - left / total));
    });
  }

  function stationsView(s) {
    const out = [];
    if (M.builtRoom(s, 'sifter')) {
      if (s.batch) {
        const on = M.isPowered(s, 'sifter');
        out.push(h('div', {}, `Sifter: ${B.recipes[s.batch.recipe].name}, ${fmt(s.batch.remaining)} `, on ? null : h('span', { class: 'paused-text', text: 'Paused' })));
      } else out.push(h('div', { class: 'muted', text: 'Sifter: idle' }));
    }
    if (M.builtRoom(s, 'greenhouse')) {
      const full = s.inv.ration >= B.greenhouse.cap;
      out.push(h('div', { text: full ? 'Greenhouse: full' : M.isPowered(s, 'greenhouse') ? `Greenhouse: ration in ${fmt(s.greenhouseTimer)}` : 'Greenhouse: no power' }));
    }
    if (s.broadcast.active) out.push(h('div', { text: `Broadcast: ${fmt(s.broadcast.remaining)} left${M.isPowered(s, 'beacon') ? '' : ' (paused, no power)'}` }));
    if (s.pasteCooldown > 0) out.push(h('div', { class: 'muted', text: `Emergency paste ready in ${fmt(s.pasteCooldown)}` }));
    return out;
  }

  // ---------- hints / announcements ----------
  // Only the newest tip is shown; older ones are superseded by progress.
  function showHint(id) {
    if (!HINTS[id]) return;
    hintQueue = [id];
    renderHint();
  }
  function renderHint() {
    const id = hintQueue[0];
    $('hint').hidden = !id;
    if (id) $('hint-text').textContent = HINTS[id];
  }
  $('hint-ok').addEventListener('click', () => { hintQueue.shift(); renderHint(); });

  function announce(text, warn = false) {
    if (!text) return;
    live.textContent = text;
    const t = h('div', { class: `toast${warn ? ' warn' : ''}`, text: warn ? `✗ ${text}` : text });
    $('toasts').append(t);
    setTimeout(() => t.remove(), 4100);
  }

  function handleEvents(events) {
    for (const e of events) {
      if (e.type === 'hint') showHint(e.id);
      else if (['complete', 'rescue', 'salvaged', 'moved', 'beacon', 'cancel'].includes(e.type)) announce(e.text);
      else if (e.type === 'care' && /Ate|Rested/.test(e.text)) announce(e.text);
    }
  }

  // ---------- hover / tool preview ----------
  function preview(cell) {
    const v = app.view;
    const s = app.w.s;
    if (!cell || !v.tool) return { ok: false, reason: '' };
    if (v.tool === 'mine') {
      if (cell.a !== 'U') return { ok: false, reason: 'Pick a rock block below the surface' };
      if (s.jobs.some((j) => j.kind === 'mine' && j.c === cell.c && j.d === cell.r)) return { ok: true, reason: 'Click to unqueue' };
      const why = previewMine(s, cell.c, cell.r);
      return { ok: !why, reason: why || `Mine depth ${cell.r}` };
    }
    if (v.tool === 'build') {
      const type = v.buildType;
      const why = M.placementReason(app.w, type, cell.a, cell.c, cell.r);
      return { ok: !why, reason: why || `Place ${B.buildings[type].name.toLowerCase()} here` };
    }
    if (v.tool === 'move') {
      const why = M.relocateReason(app.w, v.moveRoomId, cell.a, cell.c, cell.r);
      return { ok: !why, reason: why || 'Move here' };
    }
    return { ok: false, reason: '' };
  }

  function setHover(cell) {
    const v = app.view;
    v.hover = cell;
    const p = preview(cell);
    v.hoverOk = p.ok; v.hoverReason = p.reason;
  }

  function applyAt(cell) {
    const v = app.view;
    if (!cell) return;
    const s = app.w.s;
    if (!v.tool) { v.selected = cell; v.cursor = cell; lastInspector = ''; return; }
    if (v.tool === 'mine') {
      if (cell.a !== 'U') { announce('Pick a rock block below the surface', true); return; }
      const job = s.jobs.find((j) => j.kind === 'mine' && j.c === cell.c && j.d === cell.r);
      if (job) app.command(M.cancelJob, job.id);
      else app.command(M.requestMine, cell.c, cell.r);
    } else if (v.tool === 'build') {
      const r = app.command(M.requestBuild, v.buildType, cell.a, cell.c, cell.r);
      if (r.ok) {
        v.selected = cell;
        if (M.countType(s, v.buildType) >= B.buildings[v.buildType].max) exitTool();
      }
    } else if (v.tool === 'move') {
      const r = app.command(M.requestRelocate, v.moveRoomId, cell.a, cell.c, cell.r);
      if (r.ok) { v.selected = cell; exitTool(); }
    }
    setHover(cell);
  }

  function setTool(tool, extra = {}) {
    const v = app.view;
    if (app.w.s.phase !== 'playing') return;
    v.tool = tool; v.buildType = extra.buildType || null; v.moveRoomId = extra.moveRoomId || null;
    v.moveType = extra.moveRoomId ? M.roomById(app.w.s, extra.moveRoomId).type : null;
    v.paletteOpen = tool === 'build';
    setHover(v.hover);
    lastCards = '';
  }
  function exitTool() {
    const v = app.view;
    v.tool = null; v.buildType = null; v.moveRoomId = null; v.moveType = null; v.paletteOpen = false;
    v.hoverReason = '';
    lastCards = '';
  }

  // ---------- input wiring ----------
  canvas.addEventListener('pointermove', (e) => setHover(pointerCell(canvas, e)));
  canvas.addEventListener('pointerleave', () => { if (document.activeElement !== canvas) setHover(null); });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) { exitTool(); return; }
    if (e.button !== 0) return;
    const cell = pointerCell(canvas, e);
    if (!cell) return;
    if (!app.view.tool && cell.a === 'S' && cell.r > 2) return;
    applyAt(cell);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard cell selector: rows run floor 2, 1, ground, depth 0..3.
  const toRow = (cell) => (cell.a === 'S' ? 2 - cell.r : 3 + cell.r);
  const fromRow = (row, c) => (row < 3 ? { a: 'S', c, r: 2 - row, inGrid: true } : { a: 'U', c, r: row - 3, inGrid: true });
  canvas.addEventListener('keydown', (e) => {
    const v = app.view;
    const cur = v.cursor || { a: 'S', c: 1, r: 0 };
    let row = toRow(cur), c = cur.c;
    if (e.key === 'ArrowUp') row--; else if (e.key === 'ArrowDown') row++;
    else if (e.key === 'ArrowLeft') c--; else if (e.key === 'ArrowRight') c++;
    else if (e.key === 'Enter') { e.preventDefault(); applyAt(cur); return; }
    else return;
    e.preventDefault();
    row = Math.max(0, Math.min(6, row)); c = Math.max(0, Math.min(COLS - 1, c));
    v.cursor = fromRow(row, c);
    setHover(v.cursor);
    if (!v.tool) { v.selected = v.cursor; lastInspector = ''; }
    $('selector-text').textContent = `Selected ${cellName(v.cursor.a, v.cursor.c, v.cursor.r)}. ${v.hoverReason || ''}`;
    live.textContent = $('selector-text').textContent;
  });
  canvas.addEventListener('focus', () => { app.view.cursor ||= { a: 'S', c: 1, r: 0, inGrid: true }; setHover(app.view.cursor); });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled || !app.w) return;
    const { action, arg } = el.dataset;
    const v = app.view;
    switch (action) {
      case 'pick': setTool('build', { buildType: arg }); canvas.focus(); break;
      case 'mine': { const [c, d] = arg.split(',').map(Number); app.command(M.requestMine, c, d); break; }
      case 'cancel': app.command(M.cancelJob, arg); break;
      case 'up': app.command(M.moveJobUp, arg); break;
      case 'batch': app.command(M.startBatch, arg); break;
      case 'batch-cancel': app.command(M.cancelBatch); break;
      case 'drill': app.command(M.requestDrillUpgrade); break;
      case 'beacon-on': app.command(M.activateBeacon); break;
      case 'beacon-off': app.command(M.stopBroadcast); break;
      case 'salvage': app.command(M.requestSalvage, arg); break;
      case 'move': setTool('move', { moveRoomId: arg }); canvas.focus(); break;
      default: return;
    }
    lastInspector = ''; lastJobs = '';
  });

  $('b-mine').addEventListener('click', () => (app.view.tool === 'mine' ? exitTool() : setTool('mine')));
  $('b-build').addEventListener('click', () => {
    const v = app.view;
    if (v.tool === 'build' || v.paletteOpen) exitTool(); else { exitTool(); v.paletteOpen = true; }
  });
  $('b-eat').addEventListener('click', () => app.command(M.requestEat));
  $('b-rest').addEventListener('click', () => app.command(M.requestRest));
  $('b-pause').addEventListener('click', () => app.togglePause());
  $('b-1x').addEventListener('click', () => app.setSpeed(1));
  $('b-2x').addEventListener('click', () => app.setSpeed(2));
  $('c-auto').addEventListener('change', (e) => { app.w.s.autoCare = e.target.checked; app.markDirty(); });
  $('b-save').addEventListener('click', () => app.saveNow(true));
  $('b-export').addEventListener('click', () => app.exportSave());
  $('b-menu').addEventListener('click', () => app.openPause());

  document.addEventListener('keydown', (e) => {
    if (!app.w || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t.closest?.('input, select, textarea, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') {
      if (t.closest?.('button')) return; // let buttons activate natively
      e.preventDefault(); app.togglePause(); return;
    }
    if (k === 'escape') { if (app.view.tool || app.view.paletteOpen) exitTool(); else app.openPause(); return; }
    if (k === 'm') $('b-mine').click();
    else if (k === 'b') $('b-build').click();
    else if (k === 'e') app.command(M.requestEat);
    else if (k === 'r') app.command(M.requestRest);
    else if (k === '1') app.setSpeed(1);
    else if (k === '2') app.setSpeed(2);
  });

  // ---------- refresh ----------
  let lastRefresh = 0;
  function refresh(force = false) {
    const now = performance.now();
    if (!force && now - lastRefresh < 150) return;
    lastRefresh = now;
    const s = app.w.s;
    updateHud(s);
    const [ic, text] = actionText(s);
    const ai = $('action-icon'); ai.dataset.icon = ic; paintIcon(ai);
    $('action-text').textContent = text;
    if (app.view.hover && app.view.tool) setHover(app.view.hover);
    updateToolbar(s);
    if (!$('palette').hidden) updateCards(s);
    updateChain(s);
    lastInspector = rebuild($('inspector'), inspector(s), lastInspector);
    lastJobs = rebuild($('jobs'), jobsView(s), lastJobs);
    $('jobs-empty').hidden = s.jobs.length > 0;
    lastStations = rebuild($('stations'), stationsView(s), lastStations);
  }

  function reset() {
    hintQueue = [];
    renderHint();
    exitTool();
    app.view.selected = null;
    lastInspector = lastJobs = lastStations = lastCards = lastChain = '';
  }

  return { refresh, handleEvents, announce, showHint, reset, exitTool };
}
