// Tiny movement graph: walkway/ground stands, completed upper rooms, excavated cells.
// Node keys: "S:c:f" (surface; S:c:0 is always present as the permanent walkway) and "U:c:d".

export const COLS = 3, FLOORS = 3, DEPTHS = 4;

export const key = (a, c, r) => `${a}:${c}:${r}`;
export const parseKey = (k) => { const [a, c, r] = k.split(':'); return { a, c: +c, r: +r }; };

export function slotTopLeft(a, c, r) {
  return a === 'S' ? [192 + 32 * c, 96 - 32 * r] : [192 + 32 * c, 128 + 32 * r];
}

// Feet position of a stand node (astronaut pivot is 8,15).
export function nodePos(k) {
  const { a, c, r } = parseKey(k);
  const [x, y] = slotTopLeft(a, c, r);
  return { x: x + 16, y: y + 29 };
}

export function buildGraph(s) {
  const nodes = new Set();
  const builtAt = new Set(s.rooms.filter((m) => m.status === 'built' && m.a === 'S').map((m) => key('S', m.c, m.r)));
  for (let c = 0; c < COLS; c++) {
    nodes.add(key('S', c, 0));
    for (let f = 1; f < FLOORS; f++) if (builtAt.has(key('S', c, f))) nodes.add(key('S', c, f));
  }
  for (const cell of s.cells) if (cell.excavated) nodes.add(key('U', cell.c, cell.d));
  const adj = new Map([...nodes].map((n) => [n, []]));
  const link = (p, q) => { if (nodes.has(p) && nodes.has(q)) { adj.get(p).push(q); adj.get(q).push(p); } };
  for (let c = 0; c < COLS; c++) {
    for (let f = 0; f < FLOORS; f++) {
      if (c + 1 < COLS) link(key('S', c, f), key('S', c + 1, f));
      if (f + 1 < FLOORS) link(key('S', c, f), key('S', c, f + 1));
    }
    link(key('S', c, 0), key('U', c, 0));
    for (let d = 0; d < DEPTHS; d++) {
      if (d + 1 < DEPTHS) link(key('U', c, d), key('U', c, d + 1));
      if (c + 1 < COLS) link(key('U', c, d), key('U', c + 1, d));
    }
  }
  return { nodes, adj };
}

// Breadth-first search; returns the node list after `from` (empty when already there), or null.
export function findPath(graph, from, to) {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null;
  if (from === to) return [];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift();
    for (const m of graph.adj.get(n)) {
      if (prev.has(m)) continue;
      prev.set(m, n);
      if (m === to) {
        const out = [];
        for (let k = to; k !== from; k = prev.get(k)) out.unshift(k);
        return out;
      }
      queue.push(m);
    }
  }
  return null;
}

// Closest existing node to a world point (used after a layout change strands the astronaut).
export function nearestNode(graph, x, y) {
  let best = null, bd = Infinity;
  for (const n of graph.nodes) {
    const p = nodePos(n);
    const d = Math.abs(p.x - x) + Math.abs(p.y - y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
