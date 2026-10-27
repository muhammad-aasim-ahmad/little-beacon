// Canvas 2D world drawing. Reads state only; never changes the model.
import { slotTopLeft, COLS, DEPTHS } from './path.js';
import { isPowered, roomAt, cellAt } from './model.js';

export const W = 480, H = 320;

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.assets = assets;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.fx = [];
  }

  spr(atlas, id, x, y, { flip = false, alpha = 1 } = {}) {
    const a = this.assets.atlases[atlas];
    const f = a.frames[id];
    if (!f) return;
    const ctx = this.ctx;
    const [sx, sy, sw, sh] = f;
    x = Math.round(x); y = Math.round(y);
    ctx.globalAlpha = alpha;
    if (flip) {
      ctx.save(); ctx.translate(x + sw, y); ctx.scale(-1, 1);
      ctx.drawImage(a.img, sx, sy, sw, sh, 0, 0, sw, sh);
      ctx.restore();
    } else ctx.drawImage(a.img, sx, sy, sw, sh, x, y, sw, sh);
    ctx.globalAlpha = 1;
  }

  // Frame id for an animation at time t (seconds).
  anim(atlas, name, t) {
    const a = this.assets.atlases[atlas];
    const an = a.animations[name];
    let i = Math.floor(t * an.fps);
    i = an.loop ? i % an.count : Math.min(i, an.count - 1);
    return Object.keys(a.frames)[an.start + i];
  }

  rect(x, y, w, h, color) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, w - 1, h - 1);
  }

  bar(x, y, w, frac, color) {
    const ctx = this.ctx;
    ctx.fillStyle = '#162a3a'; ctx.fillRect(x, y, w, 2);
    ctx.fillStyle = color; ctx.fillRect(x, y, Math.round(w * Math.max(0, Math.min(1, frac))), 2);
  }

  addFx(kind, x, y, t) { this.fx.push({ kind, x, y, t }); }

  draw(w, view) {
    const { s, B } = w;
    const ctx = this.ctx;
    const P = this.assets.manifest.palette;
    const t = s.simTime;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.assets.background, 0, 0);

    // Terrain
    for (let c = 0; c < COLS; c++) for (let d = 0; d < DEPTHS; d++) {
      const cell = cellAt(s, c, d);
      const [X, Y] = slotTopLeft('U', c, d);
      if (cell.excavated) {
        for (let k = 0; k < 4; k++) this.spr('terrain', 'excavated', X + (k % 2) * 16, Y + (k >> 1) * 16);
        this.spr('terrain', 'ledge', X, Y + 16); this.spr('terrain', 'ledge', X + 16, Y + 16);
      } else {
        const ore = (c * 3 + d) % 4;
        for (let k = 0; k < 4; k++) this.spr('terrain', `${k === ore ? 'ore' : 'rock'}_d${d}`, X + (k % 2) * 16, Y + (k >> 1) * 16);
        if (c === B.geodeCell[0] && d === B.geodeCell[1]) this.spr('terrain', 'geode_rock', X + 8, Y + 8);
        const frac = cell.work / B.depths[d].work;
        if (frac < 0.67) this.spr('terrain', 'crack_a', X + 2, Y + 8);
        if (frac < 0.34) this.spr('terrain', 'crack_b', X + 14, Y + 8);
        const qi = s.jobs.findIndex((j) => j.kind === 'mine' && j.c === c && j.d === d);
        if (qi >= 0) this.rect(X + 1, Y + 1, 30, 30, P.amber);
      }
    }

    // Rooms
    const rescueLike = s.phase !== 'playing';
    for (const m of s.rooms) {
      const [X, Y] = slotTopLeft(m.a, m.c, m.r);
      const cave = m.a === 'U';
      if (m.status === 'queued') {
        this.spr('rooms', cave ? 'cave_empty' : 'empty', X, Y, { alpha: 0.75 });
        this.spr('rooms', frameFor(m.type, cave), X, Y, { alpha: 0.35 });
        const job = s.jobs.find((j) => j.id === m.jobId);
        this.rect(X, Y, 32, 32, P.amber);
        if (job) this.bar(X + 4, Y + 27, 24, 1 - job.work / job.total, P.amber);
      } else {
        this.spr('rooms', frameFor(m.type, cave), X, Y);
      }
      if (cave) { this.spr('terrain', 'ladder', X - 2, Y); this.spr('terrain', 'ladder', X - 2, Y + 16); }
    }
    // Free ladders in empty shaft cells
    for (const cell of s.cells) {
      if (!cell.excavated || roomAt(s, 'U', cell.c, cell.d)) continue;
      const [X, Y] = slotTopLeft('U', cell.c, cell.d);
      this.spr('terrain', 'ladder', X + 8, Y); this.spr('terrain', 'ladder', X + 8, Y + 16);
    }

    // Machine overlays and power marks (frozen while unpowered: they use their own progress time)
    for (const m of s.rooms) {
      if (m.status !== 'built') continue;
      const [X, Y] = slotTopLeft(m.a, m.c, m.r);
      const load = m.type !== 'shelter' && B.buildings[m.type].load > 0;
      const on = !load || isPowered(s, m.type);
      if (load && !on) this.spr('terrain', 'no_power', X + 16, Y);
      if (m.type === 'sifter' && s.batch) {
        if (on) this.spr('machines', this.anim('machines', 'sifter', t), X + 8, Y + 16);
        else this.rect(X, Y, 32, 32, P.cyan);
        this.bar(X + 4, Y + 29, 24, 1 - s.batch.remaining / s.batch.total, P.cyan);
      }
      if (m.type === 'greenhouse' && on && s.inv.ration < B.greenhouse.cap) {
        this.spr('machines', this.anim('machines', 'plant', t), X + 8, Y + 8);
        this.bar(X + 4, Y + 29, 24, 1 - s.greenhouseTimer / B.greenhouse.interval, P.green);
      }
      if (m.type === 'greenhouse' && s.inv.ration >= B.greenhouse.cap) this.spr('effects', 'food_0', X + 8, Y - 14);
      if (m.type === 'workshop' && s.astro.action === 'build' && s.jobs.find((j) => j.id === s.astro.jobId)?.kind === 'research') {
        this.spr('machines', this.anim('machines', 'drill', t), X + 16, Y + 8);
      }
      if (m.type === 'beacon' && (s.broadcast.active || s.phase === 'rescue')) {
        if (on || s.phase === 'rescue') {
          this.spr('machines', this.anim('machines', 'beacon', t), X + 8, Y + 2);
          if (!view.reducedMotion || Math.floor(t) % 2 === 0) this.spr('effects', this.anim('effects', 'signal', t), X + 8, Y - 16);
        }
        if (s.phase === 'playing') this.bar(X + 4, Y + 29, 24, 1 - s.broadcast.remaining / B.broadcast, P.cyan);
      }
    }

    this.drawAstronaut(w, view);

    // Transient effects
    this.fx = this.fx.filter((f) => t - f.t < 0.7 && t >= f.t);
    for (const f of this.fx) this.spr('effects', this.anim('effects', f.kind, t - f.t), f.x, f.y);

    if (!rescueLike) this.drawSelection(w, view);
    if (s.phase === 'rescue') this.drawShip(w, view);
  }

  drawAstronaut(w, view) {
    const { s, B } = w;
    const a = s.astro;
    if (s.phase === 'results' || s.phase === 'review') return;
    let x = a.x, y = a.y, action = a.action, flip = a.facing < 0;
    const t = s.simTime;
    if (s.phase === 'rescue') {
      const rt = B.rescue - s.rescueRemaining;
      if (rt >= 7) return;
      const from = a.underground ? { x: 240, y: 125 } : a.rescueFrom;
      const dock = { x: 180, y: 125 };
      if (rt < 3) { x = from.x; y = from.y; action = 'celebrate'; }
      else {
        const k = view.reducedMotion ? 1 : (rt - 3) / 4;
        x = from.x + (dock.x - from.x) * k; y = from.y + (dock.y - from.y) * k;
        action = 'walk'; flip = dock.x < from.x;
      }
      const name = action === 'celebrate' ? this.anim('astronaut', 'celebrate', rt) : this.anim('astronaut', 'walk', rt);
      this.spr('astronaut', name, x - 8, y - 15, { flip });
      return;
    }
    const map = { idle: 'idle', walk: 'walk', climb: 'climb', mine: 'mine', build: 'build', eat: 'eat', sleep: 'sleep' };
    const frame = this.anim('astronaut', map[action] || 'idle', view.reducedMotion && action === 'idle' ? 0 : t);
    this.spr('astronaut', frame, x - 8, y - 15, { flip });
    if (action === 'sleep') this.spr('effects', this.anim('effects', 'zzz', t), x - 2, y - 30);
    if (action === 'eat') this.spr('effects', this.anim('effects', 'food', t), x - 8, y - 32);
    if ((action === 'mine' || action === 'build') && !view.reducedMotion) {
      const job = s.jobs.find((j) => j.id === a.jobId);
      if (job?.kind === 'mine') {
        const [X, Y] = slotTopLeft('U', job.c, job.d);
        if (Math.floor(t * 4) % 3 === 0) this.spr('effects', this.anim('effects', 'spark', t), X + 8, Y - 6);
      }
    }
  }

  drawSelection(w, view) {
    const P = this.assets.manifest.palette;
    const h = view.hover;
    if (h && view.tool) {
      const [X, Y] = slotTopLeft(h.a, h.c, h.r);
      if (view.tool === 'build' || view.tool === 'move') {
        const type = view.tool === 'build' ? view.buildType : view.moveType;
        if (type && h.inGrid) this.spr('rooms', frameFor(type, h.a === 'U'), X, Y, { alpha: 0.55 });
      }
      this.rect(X, Y, 32, 32, view.hoverOk ? P.green : P.orange);
      this.rect(X + 1, Y + 1, 30, 30, view.hoverOk ? P.green : P.orange);
      this.spr('icons', view.hoverOk ? 'ok' : 'invalid', X + 16, Y - 2);
    }
    const sel = view.cursor;
    if (sel) {
      const [X, Y] = slotTopLeft(sel.a, sel.c, sel.r);
      this.rect(X - 1, Y - 1, 34, 34, P.cream);
    }
  }

  drawShip(w, view) {
    const { s, B } = w;
    const rt = B.rescue - s.rescueRemaining;
    const dock = { x: 172, y: 127 };
    let x = dock.x, y = dock.y, frame = 'ship_landed', thrust = false;
    if (view.reducedMotion) {
      if (rt >= 7) return;
    } else if (rt < 3) {
      const k = rt / 3, e = 1 - (1 - k) * (1 - k);
      x = -30 + (dock.x + 30) * e; y = 40 + (dock.y - 40) * e; frame = 'ship_flying'; thrust = true;
    } else if (rt >= 7) {
      const k = (rt - 7) / 3;
      x = dock.x + 360 * k * k; y = dock.y - 110 * k; frame = 'ship_flying'; thrust = true;
    }
    this.spr('ship', frame, x - 16, y - 15);
    if (thrust) this.spr('effects', this.anim('effects', 'thruster', rt), x - 30, y - 12, { flip: true });
  }
}

export function frameFor(type, cave) {
  return cave && type !== 'shelter' ? `cave_${type}` : type;
}

// Map a pointer event to a grid cell, or null outside the outpost grid.
export function pointerCell(canvas, ev) {
  const r = canvas.getBoundingClientRect();
  const x = (ev.clientX - r.left) * W / r.width;
  const y = (ev.clientY - r.top) * H / r.height;
  return pointToCell(x, y);
}

export function pointToCell(x, y) {
  const c = Math.floor((x - 192) / 32);
  if (c < 0 || c > 2 || x < 192) return null;
  if (y < 128) {
    const f = Math.floor((127 - y) / 32);
    if (f < 0 || f > 3) return null; // floor 3 is reported so placement can explain the height cap
    return { a: 'S', c, r: f, inGrid: f <= 2 };
  }
  const d = Math.floor((y - 128) / 32);
  if (d > 3) return null;
  return { a: 'U', c, r: d, inGrid: true };
}

