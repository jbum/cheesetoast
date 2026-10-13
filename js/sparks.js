// Explosion particles (CTSparks.cpp).  Each exploding sprite is sampled at
// low resolution and every visible pixel becomes a spark.  Sparks are drawn
// one pixel each into a low-res buffer that is scaled up over the scene,
// which keeps thousands of them cheap.

import { makeCanvas } from './assets.js';

const kMaxSparks = 10000;
const kMaxSparkGroups = 64;
const SPARK_SPEED = [2, 2, 4, 2, 1];
const kSampleScale = 0.64;   // sample pixels per world unit (512x384 sampling viewport)
const kMaxSampleWidth = 64;

export class Sparks {
  constructor() {
    this.groups = [];
    this.count = 0;
    this.sampler = makeCanvas(kMaxSampleWidth, kMaxSampleWidth, { willReadFrequently: true });
    this.buffer = null;
  }

  clear() {
    this.groups = [];
    this.count = 0;
  }

  // sp: the sprite (already positioned), image/sx/sy/cell: its texture cell
  explode(sp, image, lifeSpan, vecTable) {
    if (this.groups.length >= kMaxSparkGroups || this.count >= kMaxSparks) return;
    const pw = Math.min(kMaxSampleWidth, Math.round(sp.rad * 2 * kSampleScale));
    if (pw <= 0) return;

    const ctx = this.sampler.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, pw);
    ctx.translate(pw / 2, pw / 2);
    ctx.rotate(-sp.rotation * Math.PI / 180);
    ctx.drawImage(image, sp.sx, sp.sy + sp.syOfs, sp.cell, sp.cell, -pw / 2, -pw / 2, pw, pw);
    const data = ctx.getImageData(0, 0, pw, pw).data;

    const n = Math.min(pw * pw, kMaxSparks - this.count);
    const g = {
      life: lifeSpan, n: 0,
      x: new Float32Array(n), y: new Float32Array(n),
      vx: new Float32Array(n), vy: new Float32Array(n),
      a: new Float32Array(n), rgb: new Uint32Array(n),
    };
    const step = sp.rad * 2 / pw;
    const ox = sp.x - sp.rad, oy = sp.y + sp.rad;
    let r = 0, speedCtr = 0;
    for (let j = 0; j < pw && g.n < n; j++) {
      for (let k = 0; k < pw && g.n < n; k++) {
        const p = (j * pw + k) * 4;
        const alpha = data[p + 3];
        if (alpha < 16) continue;
        const i = g.n++;
        g.x[i] = ox + k * step;
        g.y[i] = oy - j * step;
        g.vx[i] = sp.vx + vecTable[r].x * SPARK_SPEED[speedCtr];
        g.vy[i] = sp.vy + vecTable[r].y * SPARK_SPEED[speedCtr];
        g.a[i] = alpha / 255;
        g.rgb[i] = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);   // little-endian ABGR
        r = (r + 1) % vecTable.length;
        speedCtr = (speedCtr + 1) % 5;
      }
    }
    if (g.n > 0) {
      this.groups.push(g);
      this.count += g.n;
    }
  }

  update(bindX, bindY) {
    let killed = false;
    for (const g of this.groups) {
      if (g.life-- <= 0) { g.dead = true; killed = true; continue; }
      const decay = 0.95 * Math.min(5, g.life) / 5;
      for (let i = 0; i < g.n; i++) {
        g.a[i] *= decay;
        g.x[i] = bindX(g.x[i] + g.vx[i]);
        g.y[i] = bindY(g.y[i] + g.vy[i]);
      }
    }
    if (killed) {
      this.groups = this.groups.filter((g) => !g.dead);
      this.count = this.groups.reduce((sum, g) => sum + g.n, 0);
    }
  }

  // m: world-to-device transform {a,b,c,d,e,f} applied to (x - offX, -(y - offY))
  render(ctx, m, view, lerp) {
    if (!this.groups.length) return;
    const k = Math.max(1, view.ch / 384);   // one spark = 2 pixels of a 768-high window
    const bw = Math.ceil(view.cw / k), bh = Math.ceil(view.ch / k);
    if (!this.buffer || this.buffer.width !== bw || this.buffer.height !== bh) {
      this.buffer = makeCanvas(bw, bh);
      this.image = this.buffer.ctx.createImageData(bw, bh);
      this.pixels = new Uint32Array(this.image.data.buffer);
    }
    const px = this.pixels;
    px.fill(0);
    const back = 1 - lerp;
    const { a, b, c, d, e, f } = m;
    for (const g of this.groups) {
      for (let i = 0; i < g.n; i++) {
        const alpha = g.a[i];
        if (alpha < 0.02) continue;
        const wx = g.x[i] - g.vx[i] * back - view.offX;
        const wy = -(g.y[i] - g.vy[i] * back - view.offY);
        const sx = ((a * wx + c * wy + e) / k) | 0;
        const sy = ((b * wx + d * wy + f) / k) | 0;
        if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) continue;
        px[sy * bw + sx] = g.rgb[i] | ((alpha * 255) << 24);
      }
    }
    this.buffer.ctx.putImageData(this.image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.buffer, 0, 0, bw * k, bh * k);
    ctx.imageSmoothingEnabled = true;
  }
}
