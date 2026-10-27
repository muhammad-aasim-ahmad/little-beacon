// Pure game model: state, validation and atomic command transactions. No DOM, images or timers.
import { COLS, FLOORS, DEPTHS, key, buildGraph } from './path.js';

export const SCHEMA_VERSION = 1;
const RESOURCES = ['scrap', 'regolith', 'carbide', 'ration'];

export function createWorld(B, s = newState(B)) {
  return { B, s, events: [], graph: buildGraph(s), graphVersion: s.layoutVersion };
}

export function newState(B) {
  const cells = [];
  for (let c = 0; c < COLS; c++) for (let d = 0; d < DEPTHS; d++) {
    cells.push({ c, d, work: B.depths[d].work, excavated: false });
  }
  const [sc, sf] = B.shelterSlot;
  return {
    schemaVersion: SCHEMA_VERSION,
    balanceVersion: B.balanceVersion,
    phase: 'playing', paused: false, speed: 1, rescued: false,
    simTime: 0, activeSeconds: 0,
    inv: { scrap: B.start.scrap, regolith: B.start.regolith, carbide: B.start.carbide, ration: B.start.ration },
    unique: 'rock', // rock | geode | separating | crystal | building | installed
    drillUnlocked: false,
    ever: { workshop: false, sifter: false, crystal: false },
    rooms: [{ id: 'room_1', type: 'shelter', a: 'S', c: sc, r: sf, status: 'built', paid: {} }],
    cells,
    jobs: [],
    nextId: 2,
    batch: null, // { recipe, remaining, total, paid }
    greenhouseTimer: B.greenhouse.interval,
    pasteCooldown: 0,
    broadcast: { active: false, remaining: B.broadcast },
    rescueRemaining: B.rescue,
    autoCare: true,
    layoutVersion: 0,
    astro: {
      id: 'astronaut_1', node: key('S', sc, sf), x: 208 + 32 * sc, y: 125, path: [], facing: 1,
      action: 'idle', jobId: null, suspendedJobId: null, care: null, request: null,
      hunger: B.start.hunger, energy: B.start.energy,
    },
    hints: {},
    stats: { blocks: 0, meals: 0, pastes: 0, rests: 0 },
    milestones: {},
    power: { cap: B.shelterSupply, demand: 0, powered: {} },
  };
}

// ---------- helpers ----------
export const emit = (w, type, text, extra = {}) => w.events.push({ type, text, ...extra });
const ok = () => ({ ok: true, reason: '' });
const no = (reason) => ({ ok: false, reason });
const newId = (s, p) => `${p}_${s.nextId++}`;

export const roomAt = (s, a, c, r) => s.rooms.find((m) => m.a === a && m.c === c && m.r === r);
export const roomById = (s, id) => s.rooms.find((m) => m.id === id);
export const builtRoom = (s, type) => s.rooms.find((m) => m.type === type && m.status === 'built');
export const cellAt = (s, c, d) => s.cells.find((x) => x.c === c && x.d === d);
export const jobById = (s, id) => s.jobs.find((j) => j.id === id);
export const countType = (s, type) => s.rooms.filter((m) => m.type === type).length;
export const inRange = (a, c, r) => c >= 0 && c < COLS && r >= 0 && r < (a === 'S' ? FLOORS : DEPTHS);

export function touchLayout(w) { w.s.layoutVersion++; }
export function graph(w) {
  if (w.graphVersion !== w.s.layoutVersion) { w.graph = buildGraph(w.s); w.graphVersion = w.s.layoutVersion; }
  return w.graph;
}

export function costText(cost) {
  return Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
}

export function missingFor(s, cost) {
  const miss = [];
  for (const [k, v] of Object.entries(cost)) {
    if (k === 'crystal') { if (s.unique !== 'crystal') miss.push('echo crystal'); }
    else if (k === 'geode') { if (s.unique !== 'geode') miss.push('raw geode'); }
    else if ((s.inv[k] || 0) < v) miss.push(`${v - s.inv[k]} more ${k}`);
  }
  return miss;
}

function pay(s, cost) {
  const paid = {};
  for (const [k, v] of Object.entries(cost)) {
    if (k === 'crystal') s.unique = 'building';
    else if (k === 'geode') s.unique = 'separating';
    else s.inv[k] -= v;
    paid[k] = v;
  }
  return paid;
}

function refund(s, paid) {
  for (const [k, v] of Object.entries(paid || {})) {
    if (k === 'crystal') s.unique = 'crystal';
    else if (k === 'geode') s.unique = 'geode';
    else s.inv[k] += v;
  }
}

export function unlockReason(s, B, type) {
  const u = B.buildings[type].unlock;
  if (u === 'workshop' && !s.ever.workshop) return 'Complete a workshop first';
  if (u === 'sifter' && !s.ever.sifter) return 'Complete a sifter first';
  if (u === 'drill' && !s.drillUnlocked) return 'Needs the improved drill';
  if (u === 'crystal' && !s.ever.crystal) return 'Needs a separated echo crystal';
  return '';
}

// ---------- placement ----------
const isSky = (B, type) => type !== 'shelter' && B.buildings[type]?.sky;

// Reason a room of `type` cannot occupy (a,c,r), ignoring room `ignoreId` (for relocation). '' when legal.
export function placementReason(w, type, a, c, r, ignoreId = null) {
  const { s, B } = w;
  const def = B.buildings[type];
  if (a === 'S' && r >= FLOORS) return 'Anchors cannot support another floor';
  if (!inRange(a, c, r)) return 'Outside the outpost';
  const others = s.rooms.filter((m) => m.id !== ignoreId);
  if (others.some((m) => m.a === a && m.c === c && m.r === r)) return 'Slot is occupied';
  if (a === 'U') {
    if (!def.cave) return `${def.name} must be above ground`;
    const cell = cellAt(s, c, r);
    if (!cell.excavated) return 'Excavate this block first';
    return '';
  }
  if (!def.surface) return `${def.name} cannot go above ground`;
  const built = (cc, rr) => others.some((m) => m.a === 'S' && m.c === cc && m.r === rr && m.status === 'built');
  if (r > 0 && !built(c, r - 1)) return 'Needs a completed room directly below';
  if (!(built(c - 1, r) || built(c + 1, r) || built(c, r - 1) || built(c, r + 1))) return 'Must touch a completed room';
  const column = others.filter((m) => m.a === 'S' && m.c === c);
  if (isSky(B, type) && column.some((m) => m.r > r)) return 'Needs open sky: a room is above this slot';
  if (column.some((m) => m.r < r && isSky(B, m.type))) return 'Would cover the open sky of a solar panel or beacon';
  return '';
}

// Reason removing `room` from its slot would break the layout. '' when safe.
function removalReason(w, room) {
  const { s } = w;
  if (room.type === 'shelter') return 'The crashed shelter is permanent';
  if (room.a === 'S' && s.rooms.some((m) => m.a === 'S' && m.c === room.c && m.r === room.r + 1)) {
    return 'It supports the room above';
  }
  return '';
}

function busyReason(w, room) {
  const { s } = w;
  if (room.type === 'sifter' && s.batch) return 'Finish or cancel the sifter batch first';
  if (room.type === 'workshop' && s.jobs.some((j) => j.kind === 'research')) return 'Finish or cancel drill research first';
  if (room.type === 'beacon' && s.broadcast.active) return 'Stop the broadcast first';
  if (s.astro.care?.type === 'sleep' && s.astro.care.bedId === room.id) return 'The astronaut is resting here';
  return '';
}

// ---------- power ----------
export function computePower(s, B) {
  const solars = s.rooms.filter((m) => m.type === 'solar' && m.status === 'built').length;
  const cap = B.shelterSupply + solars * B.buildings.solar.supply;
  const powered = {};
  let demand = 0;
  for (const t of B.shedOrder) if (builtRoom(s, t)) { powered[t] = true; demand += B.buildings[t].load; }
  const totalDemand = demand;
  for (const t of B.shedOrder) {
    if (demand <= cap) break;
    if (powered[t]) { powered[t] = false; demand -= B.buildings[t].load; }
  }
  s.power = { cap, demand: totalDemand, used: demand, powered };
  return s.power;
}
export const isPowered = (s, type) => !!s.power.powered[type];

// ---------- commands ----------
const playing = (s) => (s.phase === 'playing' ? '' : 'The run is over');

export function requestMine(w, c, d) {
  const { s, B } = w;
  if (playing(s)) return no(playing(s));
  if (!inRange('U', c, d)) return no('Outside the asteroid');
  const cell = cellAt(s, c, d);
  if (cell.excavated) return no('Already excavated');
  if (s.jobs.some((j) => j.kind === 'mine' && j.c === c && j.d === d)) return no('Already queued');
  if (d > 0 && !cellAt(s, c, d - 1).excavated) return no('Dig the block above first');
  if (B.depths[d].needsDrill && !s.drillUnlocked) return no('Needs improved drill');
  const job = { id: newId(s, 'job'), kind: 'mine', c, d, state: 'queued' };
  s.jobs.push(job);
  emit(w, 'queued', `Mine depth ${d} queued`, { save: true });
  return { ...ok(), job };
}

export function requestBuild(w, type, a, c, r) {
  const { s, B } = w;
  if (playing(s)) return no(playing(s));
  const def = B.buildings[type];
  if (!def) return no('Unknown room');
  const lock = unlockReason(s, B, type);
  if (lock) return no(lock);
  if (countType(s, type) >= def.max) return no(def.max === 1 ? `Only one ${def.name.toLowerCase()} allowed` : `At most ${def.max} allowed`);
  const where = placementReason(w, type, a, c, r);
  if (where) return no(where);
  const miss = missingFor(s, def.cost);
  if (miss.length) return no(`Need ${miss.join(', ')}`);
  const paid = pay(s, def.cost);
  const room = { id: newId(s, 'room'), type, a, c, r, status: 'queued', paid: {} };
  const job = { id: newId(s, 'job'), kind: 'build', roomId: room.id, work: def.work, total: def.work, paid, state: 'queued' };
  room.jobId = job.id;
  s.rooms.push(room);
  s.jobs.push(job);
  emit(w, 'queued', `${def.name} queued`, { save: true });
  return { ...ok(), job, room };
}

export function batchReason(s, B, recipe) {
  if (s.phase !== 'playing') return 'The run is over';
  if (!builtRoom(s, 'sifter')) return 'Needs a completed sifter';
  if (s.batch) return 'The sifter is already running a batch';
  if (recipe === 'echo' && s.unique !== 'geode') return s.unique === 'rock' ? 'Mine the geode at depth 3 first' : 'The echo geode is already processed';
  const miss = missingFor(s, B.recipes[recipe].in);
  return miss.length ? `Need ${miss.join(', ')}` : '';
}

export function startBatch(w, recipe) {
  const { s, B } = w;
  if (!B.recipes[recipe]) return no('Unknown recipe');
  const why = batchReason(s, B, recipe);
  if (why) return no(why);
  const rec = B.recipes[recipe];
  s.batch = { recipe, remaining: rec.time, total: rec.time, paid: pay(s, rec.in) };
  emit(w, 'batch', `${rec.name} started`, { save: true });
  return ok();
}

export function cancelBatch(w) {
  const { s } = w;
  if (!s.batch) return no('No batch running');
  refund(s, s.batch.paid);
  s.batch = null;
  emit(w, 'cancel', 'Sifter batch cancelled; inputs returned', { save: true });
  return ok();
}

export function drillReason(s, B) {
  if (s.phase !== 'playing') return 'The run is over';
  if (s.drillUnlocked) return 'Drill already improved';
  if (!builtRoom(s, 'workshop')) return 'Needs a completed workshop';
  if (s.jobs.some((j) => j.kind === 'research')) return 'Drill upgrade already queued';
  const miss = missingFor(s, B.drill.cost);
  return miss.length ? `Need ${miss.join(', ')}` : '';
}

export function requestDrillUpgrade(w) {
  const { s, B } = w;
  const why = drillReason(s, B);
  if (why) return no(why);
  const job = { id: newId(s, 'job'), kind: 'research', work: B.drill.work, total: B.drill.work, paid: pay(s, B.drill.cost), state: 'queued' };
  s.jobs.push(job);
  emit(w, 'queued', 'Drill upgrade queued', { save: true });
  return ok();
}

export function releaseClaim(s, jobId) {
  if (s.astro.jobId === jobId) { s.astro.jobId = null; s.astro.path = []; }
  if (s.astro.suspendedJobId === jobId) s.astro.suspendedJobId = null;
}

export function cancelJob(w, id) {
  const { s } = w;
  const job = jobById(s, id);
  if (!job) return no('No such job');
  if (s.phase !== 'playing') return no('The run is over');
  // Removing a queued room must not strand a queued room reserved above it.
  if (job.kind === 'build') {
    const room = roomById(s, job.roomId);
    const above = room.a === 'S' && s.rooms.find((m) => m.a === 'S' && m.c === room.c && m.r === room.r + 1);
    if (above) return no('Cancel the room queued above it first');
    s.rooms = s.rooms.filter((m) => m.id !== room.id);
    refund(s, job.paid);
  } else if (job.kind === 'research') {
    refund(s, job.paid);
  }
  releaseClaim(s, id);
  s.jobs = s.jobs.filter((j) => j.id !== id);
  emit(w, 'cancel', job.kind === 'mine' ? 'Mining cancelled; progress kept' : 'Job cancelled; materials refunded', { save: true });
  return ok();
}

export function moveJobUp(w, id) {
  const { s } = w;
  const i = s.jobs.findIndex((j) => j.id === id);
  if (i <= 0) return no('Already first');
  [s.jobs[i - 1], s.jobs[i]] = [s.jobs[i], s.jobs[i - 1]];
  return ok();
}

export function relocateReason(w, roomId, a, c, r) {
  const { s, B } = w;
  if (s.phase !== 'playing') return 'The run is over';
  const room = roomById(s, roomId);
  if (!room || room.status !== 'built') return 'Only completed rooms can move';
  if (room.a === a && room.c === c && room.r === r) return 'Already here';
  return removalReason(w, room) || busyReason(w, room) || placementReason(w, room.type, a, c, r, room.id);
}

// Why a completed room cannot be picked up at all ('' when it can move).
export function moveReason(w, roomId) {
  const room = roomById(w.s, roomId);
  if (!room || room.status !== 'built') return 'Only completed rooms can move';
  return removalReason(w, room) || busyReason(w, room);
}

export function requestRelocate(w, roomId, a, c, r) {
  const why = relocateReason(w, roomId, a, c, r);
  if (why) return no(why);
  const room = roomById(w.s, roomId);
  Object.assign(room, { a, c, r });
  touchLayout(w);
  emit(w, 'moved', `${w.B.buildings[room.type].name} moved`, { save: true });
  return ok();
}

export function salvageReason(w, roomId) {
  const { s } = w;
  if (s.phase !== 'playing') return 'The run is over';
  const room = roomById(s, roomId);
  if (!room) return 'No such room';
  if (room.status !== 'built') return 'Cancel the queued build instead';
  return removalReason(w, room) || busyReason(w, room);
}

export function requestSalvage(w, roomId) {
  const why = salvageReason(w, roomId);
  if (why) return no(why);
  const { s, B } = w;
  const room = roomById(s, roomId);
  s.rooms = s.rooms.filter((m) => m.id !== roomId);
  refund(s, room.paid);
  if (room.type === 'beacon') s.broadcast = { active: false, remaining: B.broadcast };
  touchLayout(w);
  emit(w, 'salvaged', `${B.buildings[room.type].name} salvaged; ${costText(room.paid)} returned`, { save: true });
  return ok();
}

export function eatReason(s, B) {
  if (s.phase !== 'playing') return 'The run is over';
  if (s.astro.care || s.astro.request) return 'Already busy with care';
  if (s.astro.hunger >= 100) return 'Already full';
  if (s.inv.ration <= 0 && s.pasteCooldown > 0) return `No rations; paste ready in ${Math.ceil(s.pasteCooldown)} s`;
  return '';
}
export function requestEat(w) {
  const why = eatReason(w.s, w.B);
  if (why) return no(why);
  w.s.astro.request = 'eat';
  return ok();
}

export function restReason(s, B) {
  if (s.phase !== 'playing') return 'The run is over';
  if (s.astro.care || s.astro.request) return 'Already busy with care';
  if (s.astro.energy >= B.energy.restTo) return `Not tired (rest below ${B.energy.restTo})`;
  return '';
}
export function requestRest(w) {
  const why = restReason(w.s, w.B);
  if (why) return no(why);
  w.s.astro.request = 'rest';
  return ok();
}

export function beaconReason(s) {
  if (s.phase !== 'playing') return 'The run is over';
  if (!builtRoom(s, 'beacon')) return 'Build the distress beacon first';
  if (s.broadcast.active) return 'Already broadcasting';
  if (!isPowered(s, 'beacon')) return 'Beacon needs 3 free power';
  return '';
}
export function activateBeacon(w) {
  const why = beaconReason(w.s);
  if (why) return no(why);
  w.s.broadcast = { active: true, remaining: w.B.broadcast };
  emit(w, 'beacon', 'Distress broadcast started', { save: true });
  return ok();
}
export function stopBroadcast(w) {
  const { s, B } = w;
  if (!s.broadcast.active || s.phase !== 'playing') return no('Not broadcasting');
  s.broadcast = { active: false, remaining: B.broadcast };
  emit(w, 'beacon', 'Broadcast stopped', { save: true });
  return ok();
}

// ---------- validation of loaded snapshots ----------
export function validateState(s, B) {
  const fin = (v, lo = -Infinity, hi = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const fail = (m) => { throw new Error(m); };
  if (!s || typeof s !== 'object') fail('Not a save object');
  if (s.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported save version ${s.schemaVersion}`);
  if (s.balanceVersion !== B.balanceVersion) fail('Save is for a different balance version');
  if (!['playing', 'rescue', 'results', 'review'].includes(s.phase)) fail('Bad phase');
  for (const k of RESOURCES) if (!fin(s.inv?.[k], 0, 1e6)) fail(`Bad ${k}`);
  if (!['rock', 'geode', 'separating', 'crystal', 'building', 'installed'].includes(s.unique)) fail('Bad unique item');
  for (const k of ['simTime', 'activeSeconds', 'pasteCooldown', 'greenhouseTimer', 'rescueRemaining']) if (!fin(s[k], 0)) fail(`Bad ${k}`);
  if (![1, 2].includes(s.speed)) fail('Bad speed');
  const a = s.astro;
  if (!a || a.id !== 'astronaut_1') fail('Exactly one astronaut is required');
  if (!fin(a.hunger, 0, 100) || !fin(a.energy, 0, 100) || !fin(a.x) || !fin(a.y)) fail('Bad astronaut values');
  if (!Array.isArray(s.cells) || s.cells.length !== COLS * DEPTHS) fail('Bad mine cells');
  const seen = new Set();
  for (const c of s.cells) {
    const k = `${c.c}:${c.d}`;
    if (seen.has(k) || !inRange('U', c.c, c.d) || !fin(c.work, 0, 1000)) fail('Duplicate or bad cell');
    seen.add(k);
    if (c.excavated && c.d > 0 && !s.cells.find((x) => x.c === c.c && x.d === c.d - 1)?.excavated) fail('Unreachable excavation');
  }
  const ids = new Set(), slots = new Set();
  for (const m of s.rooms) {
    if (ids.has(m.id)) fail('Duplicate room id');
    ids.add(m.id);
    const sk = `${m.a}:${m.c}:${m.r}`;
    if (slots.has(sk) || !inRange(m.a, m.c, m.r)) fail('Duplicate or bad room slot');
    slots.add(sk);
    if (m.type !== 'shelter' && !B.buildings[m.type]) fail('Unknown room type');
    if (!['built', 'queued'].includes(m.status)) fail('Bad room status');
  }
  const shelter = s.rooms.filter((m) => m.type === 'shelter');
  if (shelter.length !== 1 || shelter[0].c !== B.shelterSlot[0] || shelter[0].r !== B.shelterSlot[1] || shelter[0].a !== 'S') fail('Shelter missing');
  const w = { s, B };
  for (const m of s.rooms) {
    if (m.type === 'shelter') continue;
    if (countType(s, m.type) > B.buildings[m.type].max) fail('Too many rooms of one type');
    const surrounding = { ...w, s: { ...s, rooms: s.rooms.filter((x) => x.status === 'built' || x.id === m.id) } };
    if (m.status === 'built' && placementReason(surrounding, m.type, m.a, m.c, m.r, m.id)) fail(`Illegal room at ${m.a}${m.c},${m.r}`);
  }
  const beacon = s.rooms.find((m) => m.type === 'beacon');
  const uniqueOk = {
    rock: !beacon && !s.cells.find((c) => c.c === B.geodeCell[0] && c.d === B.geodeCell[1]).excavated,
    geode: !beacon && s.batch?.recipe !== 'echo',
    separating: !beacon && s.batch?.recipe === 'echo',
    crystal: !beacon,
    building: beacon?.status === 'queued',
    installed: beacon?.status === 'built',
  }[s.unique];
  if (!uniqueOk) fail('Echo item reservations are inconsistent');
  const jobIds = new Set();
  for (const j of s.jobs) {
    if (jobIds.has(j.id) || !['mine', 'build', 'research'].includes(j.kind)) fail('Bad job');
    jobIds.add(j.id);
    if (j.kind === 'build' && roomById(s, j.roomId)?.status !== 'queued') fail('Build job without its room');
    if (j.work !== undefined && !fin(j.work, 0, 1000)) fail('Bad job work');
  }
  for (const m of s.rooms) if (m.status === 'queued' && !s.jobs.some((j) => j.roomId === m.id)) fail('Queued room without a job');
  if (s.batch && (!B.recipes[s.batch.recipe] || !fin(s.batch.remaining, 0, 1000))) fail('Bad batch');
  return true;
}
