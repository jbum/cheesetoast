// The 3D starfield behind everything (GameBG.cpp).  Stars drift toward the
// viewer; at the far plane (z = -730) one world unit maps to one game unit.

import { rnd } from './util.js';

const kStarsViewDistance = 730;
const kStarWidth = 500;
const kStarHeight = 250;
const kTravelSeconds = 4;   // time for a star to fly from the far plane to the viewer

function makeStars(n, color) {
  const stars = [];
  for (let i = 0; i < n; i++)
    stars.push({ x: 0, y: 0, z: 0, c: color() });
  return stars;
}

export class Starfield {
  constructor() {
    this.small = makeStars(64, () => [0.5 + rnd() * 0.5, 0.8 + rnd() * 0.2, 0.9 + rnd() * 0.1]);
    this.large = makeStars(32, () => [0.9 + rnd() * 0.1, 0.6 + rnd() * 0.4, 0.5 + rnd() * 0.5]);
    this.fixed = makeStars(128, () => [0.5 * (0.8 + rnd() * 0.2), 0.5 * (0.8 + rnd() * 0.2), 0.5 * (0.8 + rnd() * 0.2)]);
    for (const list of [this.small, this.large, this.fixed]) {
      for (const s of list) {
        s.x = (rnd() * 2 - 1) * kStarWidth;
        s.y = (rnd() * 2 - 1) * kStarHeight;
        s.z = -rnd() * kStarsViewDistance;
      }
    }
  }

  wrap(dx, dy) {
    for (const list of [this.small, this.large, this.fixed]) {
      for (const s of list) {
        s.x += dx;
        s.y += dy;
      }
    }
  }

  // view: { cw, ch, s0 (device px per unit at the far plane), offX, offY }
  update(dt, view) {
    const inc = kStarsViewDistance * dt / kTravelSeconds;
    this.advance(this.small, inc, view);
    this.advance(this.large, inc, view);
    this.advance(this.fixed, inc * 0.125, view);
  }

  advance(list, inc, v) {
    for (const s of list) {
      s.z += inc;
      let off = s.z >= -1;
      if (!off) {
        const k = v.s0 * kStarsViewDistance / -s.z;
        const sx = (s.x - v.offX) * k, sy = (s.y - v.offY) * k;
        off = Math.abs(sx) > v.cw * 1.5 || Math.abs(sy) > v.ch * 1.5;
      }
      if (off) {
        s.x = v.offX + (rnd() * 2 - 1) * kStarWidth;
        s.y = v.offY + (rnd() * 2 - 1) * kStarHeight;
        s.z = -kStarsViewDistance;
      }
    }
  }

  render(ctx, v) {
    const px = v.ch / 768;   // original point sizes were for a 768-pixel-high window
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // fixed stars fade in over the last 10% of the distance (linear fog)
    this.draw(ctx, v, this.fixed, 1 * px, (d) => (kStarsViewDistance - d) / (kStarsViewDistance * 0.1));
    this.draw(ctx, v, this.large, 2 * px, (d) => (kStarsViewDistance - d) / kStarsViewDistance);
    this.draw(ctx, v, this.small, 1.5 * px, (d) => (kStarsViewDistance - d) / kStarsViewDistance);
  }

  draw(ctx, v, list, size, fog) {
    const cx = v.cw / 2, cy = v.ch / 2, h = size / 2;
    for (const s of list) {
      const f = Math.min(1, fog(-s.z));
      if (f <= 0.02) continue;
      const k = v.s0 * kStarsViewDistance / -s.z;
      const x = cx + (s.x - v.offX) * k, y = cy - (s.y - v.offY) * k;
      ctx.fillStyle = `rgb(${s.c[0] * f * 255 | 0},${s.c[1] * f * 255 | 0},${s.c[2] * f * 255 | 0})`;
      ctx.fillRect(x - h, y - h, size, size);
    }
  }
}
