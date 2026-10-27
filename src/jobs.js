// One-worker industrial job queue: stands, blocking reasons and FIFO selection.
import { key, findPath } from './path.js';
import { graph, roomById, builtRoom, cellAt, isPowered } from './model.js';

// Node the astronaut works from for a job.
export function standFor(w, job) {
  const { s } = w;
  if (job.kind === 'mine') return job.d === 0 ? key('S', job.c, 0) : key('U', job.c, job.d - 1);
  if (job.kind === 'build') {
    const room = roomById(s, job.roomId);
    if (room.a === 'U') return key('U', room.c, room.r);
    return key('S', room.c, Math.max(0, room.r - 1));
  }
  const ws = builtRoom(s, 'workshop');
  return ws ? key(ws.a, ws.c, ws.r) : null;
}

// Why a job cannot run right now ('' when runnable).
export function blockReason(w, job) {
  const { s, B } = w;
  if (job.kind === 'mine') {
    if (B.depths[job.d].needsDrill && !s.drillUnlocked) return 'Needs improved drill';
    if (job.d > 0 && !cellAt(s, job.c, job.d - 1).excavated) return 'Dig the block above first';
  } else if (job.kind === 'build') {
    const room = roomById(s, job.roomId);
    if (room.a === 'S' && room.r > 0) {
      const below = s.rooms.find((m) => m.a === 'S' && m.c === room.c && m.r === room.r - 1);
      if (!below || below.status !== 'built') return 'Waiting for the room below';
    }
  } else if (job.kind === 'research') {
    if (!builtRoom(s, 'workshop')) return 'Needs a workshop';
    if (!isPowered(s, 'workshop')) return 'Workshop has no power';
  }
  const stand = standFor(w, job);
  if (!stand || findPath(graph(w), s.astro.node, stand) === null) return 'No route';
  return '';
}

// Suspended job first, then the oldest runnable entry.
export function selectJob(w) {
  const { s } = w;
  const susp = s.jobs.find((j) => j.id === s.astro.suspendedJobId);
  if (susp && !blockReason(w, susp)) return susp;
  return s.jobs.find((j) => j !== susp && !blockReason(w, j)) || null;
}

export function refreshJobStates(w) {
  const { s } = w;
  for (const j of s.jobs) {
    if (j.id === s.astro.jobId) continue;
    const why = blockReason(w, j);
    j.blockReason = why;
    j.state = why ? 'blocked' : j.id === s.astro.suspendedJobId ? 'suspended_for_care' : 'queued';
  }
}
