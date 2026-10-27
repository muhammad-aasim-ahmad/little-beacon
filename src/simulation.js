// Fixed-step simulation: power, care, travel, attended work, autonomous stations and the ending.
import { key, nodePos, findPath, nearestNode, parseKey } from './path.js';
import {
  graph, computePower, isPowered, emit, touchLayout, builtRoom, roomById, cellAt, jobById,
} from './model.js';
import { blockReason, selectJob, standFor, refreshJobStates } from './jobs.js';

export const STEP = 0.1;

function hint(w, id) {
  if (w.s.hints[id]) return;
  w.s.hints[id] = true;
  emit(w, 'hint', '', { id });
}
function milestone(s, name) { if (s.milestones[name] === undefined) s.milestones[name] = Math.round(s.activeSeconds); }

// ---------- movement ----------
// Step toward `goal`; returns 'arrived', 'moving' or 'unreachable'.
function goTo(w, goal, dt) {
  const { s, B } = w;
  const a = s.astro;
  const g = graph(w);
  if (!g.nodes.has(a.node)) {
    // The room under the astronaut moved away: step out to the nearest stand.
    a.node = nearestNode(g, a.x, a.y);
    Object.assign(a, nodePos(a.node));
    a.path = [];
  }
  const here = nodePos(a.node);
  const atNode = a.x === here.x && a.y === here.y;
  if (a.goal !== goal || a.planV !== s.layoutVersion) {
    // Keep the in-progress segment when its end still exists, otherwise walk back to the last node.
    const mid = !atNode && a.path.length && g.nodes.has(a.path[0]);
    const from = mid ? a.path[0] : a.node;
    const rest = findPath(g, from, goal);
    if (rest === null) { a.path = []; return 'unreachable'; }
    a.path = mid ? [from, ...rest] : atNode ? rest : [a.node, ...rest];
    a.goal = goal; a.planV = s.layoutVersion;
  }
  if (!a.path.length) {
    if (atNode) return 'arrived';
    a.path = [a.node]; // finish walking back onto the node
  }
  let budget = B.moveSpeed * dt;
  while (budget > 0 && a.path.length) {
    const t = nodePos(a.path[0]);
    const dx = t.x - a.x, dy = t.y - a.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    a.action = Math.abs(dy) > 0 ? 'climb' : 'walk';
    if (dx) a.facing = dx > 0 ? 1 : -1;
    if (dist <= budget) {
      a.x = t.x; a.y = t.y; a.node = a.path.shift(); budget -= dist;
    } else {
      // Edges are axis aligned; move the dominant axis first.
      if (dx) a.x += Math.sign(dx) * Math.min(budget, Math.abs(dx));
      else a.y += Math.sign(dy) * Math.min(budget, Math.abs(dy));
      budget = 0;
    }
  }
  return a.path.length ? 'moving' : 'arrived';
}

// ---------- care ----------
function shelterNode(w) { const [c, r] = w.B.shelterSlot; return key('S', c, r); }
function roomNode(m) { return key(m.a, m.c, m.r); }

function pathLen(w, to) { const p = findPath(graph(w), w.s.astro.node, to); return p === null ? Infinity : p.length; }

function pickCare(w) {
  const { s, B } = w;
  const a = s.astro;
  const wantFood = a.hunger <= 0 || (s.autoCare && a.hunger <= B.hunger.autoAt) || a.request === 'eat';
  const wantRest = a.energy <= 0 || (s.autoCare && a.energy <= B.energy.autoAt) || a.request === 'rest';
  if (wantFood) {
    if (s.inv.ration > 0) {
      const spots = [shelterNode(w)];
      const gh = builtRoom(s, 'greenhouse');
      if (gh) spots.push(roomNode(gh));
      spots.sort((p, q) => pathLen(w, p) - pathLen(w, q));
      return { type: 'meal', target: spots[0] };
    }
    if (s.pasteCooldown <= 0) return { type: 'paste', target: shelterNode(w) };
    if (a.hunger <= 0 && !wantRest) return { type: 'wait', target: shelterNode(w) };
  }
  if (wantRest) {
    const bunk = builtRoom(s, 'bunk');
    if (bunk && pathLen(w, roomNode(bunk)) < Infinity) return { type: 'sleep', target: roomNode(bunk), bedId: bunk.id };
    return { type: 'sleep', target: shelterNode(w), bedId: 'room_1' };
  }
  return null;
}

function evaluateCare(w) {
  const { s, B } = w;
  const a = s.astro;
  if (a.hunger <= B.hunger.autoAt) hint(w, 'hunger');
  if (a.energy <= B.energy.autoAt) hint(w, 'energy');
  // Real care actions are never interrupted; a safe wait for paste may become paste or sleep.
  if (a.care && a.care.type !== 'wait') return;
  if (a.care) {
    if (s.pasteCooldown <= 0) { a.care = { ...a.care, type: 'paste' }; return; }
    if (!(a.energy <= 0 || (s.autoCare && a.energy <= B.energy.autoAt))) return;
    a.care = null;
  }
  const care = pickCare(w);
  if (!care) { a.request = null; return; }
  a.request = null;
  if (a.jobId) {
    const job = jobById(s, a.jobId);
    job.state = 'suspended_for_care';
    a.suspendedJobId = a.jobId;
    a.jobId = null;
  }
  a.care = { ...care, phase: 'travel', remaining: 0 };
  emit(w, 'care', care.type === 'sleep' ? 'Going to rest' : care.type === 'wait' ? 'Waiting for the food synthesizer' : 'Going to eat');
}

function advanceCare(w, dt) {
  const { s, B } = w;
  const a = s.astro;
  const c = a.care;
  if (c.phase === 'travel') {
    const r = goTo(w, c.target, dt);
    if (r === 'moving') return 'travel';
    if (r === 'unreachable') { c.target = shelterNode(w); return 'idle'; }
    if (c.type === 'wait') { a.action = 'idle'; return 'idle'; }
    c.phase = 'act';
    if (c.type === 'meal') { s.inv.ration -= 1; c.remaining = B.hunger.meal.time; }
    if (c.type === 'paste') c.remaining = B.hunger.paste.time;
    if (c.type === 'sleep') emit(w, 'care', 'Resting');
    w.dirty = true;
  }
  if (c.type === 'wait') { a.action = 'idle'; return 'idle'; }
  if (c.type === 'sleep') {
    a.action = 'sleep';
    const rate = roomById(s, c.bedId)?.type === 'bunk' ? B.energy.bunkRate : B.energy.shelterRate;
    a.energy = Math.min(100, a.energy + rate * dt);
    if (a.energy >= B.energy.restTo) {
      s.stats.rests++; a.care = null; a.action = 'idle';
      emit(w, 'care', 'Rested', { save: true });
    }
    return 'sleep';
  }
  a.action = 'eat';
  c.remaining -= dt;
  if (c.remaining <= 1e-9) {
    const gain = c.type === 'meal' ? B.hunger.meal.gain : B.hunger.paste.gain;
    a.hunger = Math.min(100, a.hunger + gain);
    if (c.type === 'paste') { s.pasteCooldown = B.hunger.paste.cooldown; s.stats.pastes++; } else s.stats.meals++;
    a.care = null; a.action = 'idle';
    emit(w, 'care', c.type === 'meal' ? 'Ate a ration' : 'Ate emergency paste', { save: true });
  }
  return 'eat';
}

// ---------- industrial work ----------
function completeJob(w, job) {
  const { s, B } = w;
  s.jobs = s.jobs.filter((j) => j.id !== job.id);
  s.astro.jobId = null;
  if (job.kind === 'mine') {
    const cell = cellAt(s, job.c, job.d);
    const y = B.depths[job.d];
    cell.work = 0; cell.excavated = true;
    s.inv.scrap += y.scrap; s.inv.regolith += y.regolith;
    s.stats.blocks++;
    let text = `Mined depth ${job.d}: +${y.scrap} scrap, +${y.regolith} regolith`;
    if (job.c === B.geodeCell[0] && job.d === B.geodeCell[1]) {
      s.unique = 'geode'; text += ', and the echo geode!';
      milestone(s, 'geode'); hint(w, 'geode');
    }
    touchLayout(w);
    emit(w, 'complete', text, { save: true, fx: { kind: 'dust', c: job.c, d: job.d } });
  } else if (job.kind === 'build') {
    const room = roomById(s, job.roomId);
    room.status = 'built'; room.paid = job.paid; delete room.jobId;
    if (room.type === 'beacon') { s.unique = 'installed'; milestone(s, 'beacon'); hint(w, 'beacon'); }
    if (room.type === 'greenhouse') s.greenhouseTimer = B.greenhouse.interval;
    if (room.type === 'workshop' && !s.ever.workshop) { s.ever.workshop = true; milestone(s, 'workshop'); hint(w, 'workshop'); }
    if (room.type === 'sifter') s.ever.sifter = true;
    touchLayout(w);
    emit(w, 'complete', `${B.buildings[room.type].name} complete`, { save: true });
  } else {
    s.drillUnlocked = true; milestone(s, 'drill');
    emit(w, 'complete', 'Drill improved: depths 1 to 3 unlocked', { save: true });
    hint(w, 'drill');
  }
}

function advanceWork(w, dt) {
  const { s, B } = w;
  const a = s.astro;
  if (!a.jobId) {
    const pick = selectJob(w);
    if (!pick) { a.action = 'idle'; return 'idle'; }
    a.jobId = pick.id;
    if (a.suspendedJobId === pick.id) a.suspendedJobId = null;
  }
  const job = jobById(s, a.jobId);
  const why = blockReason(w, job);
  if (why) { job.state = 'blocked'; job.blockReason = why; a.jobId = null; a.action = 'idle'; return 'idle'; }
  const r = goTo(w, standFor(w, job), dt);
  if (r !== 'arrived') { job.state = 'travelling'; return r === 'moving' ? 'travel' : 'idle'; }
  job.state = 'working';
  const slow = a.hunger < B.hunger.lowAt || a.energy < B.energy.lowAt;
  const amount = dt * (slow ? B.lowRate : 1);
  let left;
  if (job.kind === 'mine') {
    const cell = cellAt(s, job.c, job.d);
    cell.work = Math.max(0, cell.work - amount); left = cell.work;
    a.action = 'mine';
    const tx = 208 + 32 * job.c;
    if (tx !== a.x) a.facing = tx > a.x ? 1 : -1;
  } else {
    job.work = Math.max(0, job.work - amount); left = job.work;
    a.action = 'build';
  }
  if (left <= 1e-9) completeJob(w, job);
  return 'work';
}

// ---------- autonomous timers ----------
function advanceStations(w, dt) {
  const { s, B } = w;
  if (s.batch && isPowered(s, 'sifter')) {
    s.batch.remaining -= dt;
    if (s.batch.remaining <= 1e-9) {
      const recipe = s.batch.recipe;
      s.batch = null;
      if (recipe === 'carbide') {
        s.inv.carbide += B.recipes.carbide.out.carbide;
        hint(w, 'carbide');
        emit(w, 'complete', `+${B.recipes.carbide.out.carbide} carbide`, { save: true });
      } else {
        s.unique = 'crystal'; s.ever.crystal = true; milestone(s, 'crystal'); hint(w, 'crystal');
        emit(w, 'complete', 'Echo crystal separated', { save: true });
      }
    }
  }
  if (builtRoom(s, 'greenhouse') && s.inv.ration < B.greenhouse.cap && isPowered(s, 'greenhouse')) {
    s.greenhouseTimer -= dt;
    if (s.greenhouseTimer <= 1e-9) {
      s.inv.ration++; s.greenhouseTimer = B.greenhouse.interval;
      emit(w, 'complete', 'Greenhouse grew a ration', { save: true });
    }
  }
  s.pasteCooldown = Math.max(0, s.pasteCooldown - dt);
}

function beginRescue(w) {
  const { s, B } = w;
  s.phase = 'rescue'; s.speed = 1; s.rescueRemaining = B.rescue;
  s.broadcast.active = false; s.broadcast.remaining = 0;
  const a = s.astro;
  a.care = null; a.request = null; a.jobId = null; a.path = [];
  a.underground = parseKey(a.node).a === 'U';
  a.rescueFrom = { x: a.x, y: a.y };
  milestone(s, 'broadcast');
  emit(w, 'rescue', 'Signal received. A rescue ship is coming!', { save: true });
}

// ---------- one fixed step ----------
export function step(w, dt = STEP) {
  const { s, B } = w;
  if (s.phase === 'rescue') {
    s.rescueRemaining = Math.max(0, s.rescueRemaining - dt);
    if (s.rescueRemaining <= 0) {
      s.rescued = true; s.phase = 'results'; milestone(s, 'rescued');
      emit(w, 'results', 'Rescued!', { save: true });
    }
    return;
  }
  if (s.phase !== 'playing') return;
  s.simTime += dt;
  graph(w);
  computePower(s, B);
  refreshJobStates(w);
  evaluateCare(w);

  const a = s.astro;
  let mode;
  if (a.care) mode = advanceCare(w, dt);
  else mode = advanceWork(w, dt);

  // Survival: one energy rate per step; meals and paste freeze both meters.
  if (mode !== 'eat') {
    a.hunger = Math.max(0, a.hunger - (mode === 'sleep' ? B.hunger.asleep : B.hunger.awake) * dt);
  }
  const drain = { work: B.energy.work, travel: B.energy.travel, idle: B.energy.idle }[mode] || 0;
  a.energy = Math.max(0, a.energy - drain * dt);

  advanceStations(w, dt);
  if (s.broadcast.active && isPowered(s, 'beacon')) {
    s.broadcast.remaining = Math.max(0, s.broadcast.remaining - dt);
    if (s.broadcast.remaining <= 0) beginRescue(w);
  }
}
