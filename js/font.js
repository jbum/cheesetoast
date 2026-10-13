// Bitmap fonts (FontMgr.cpp).  Text is drawn in "space" units where y is up:
// the caller hands us a 2D context already set to the space's transform,
// and we flip y ourselves.

import { makeCanvas, cssColor } from './assets.js';
import { gnoise3d } from './util.js';

export class FontMgr {
  constructor(fontData, images) {
    this.fonts = {};
    for (const [name, f] of Object.entries(fontData)) {
      const glyphs = {};
      for (const g of f.glyphs)
        glyphs[g[0]] = { x: g[1], y: g[2], w: g[3], h: g[4], ox: g[5], oy: g[6], ax: g[7] };
      this.fonts[name] = { ...f, glyphs, image: images[name] };
    }
    this.font = this.fonts.comic;
    this.scale = 0.34;
    this.color = [1, 1, 1, 1];
    this.color2 = [1, 1, 1, 1];
    this.warp = false;
    this.warpOrigin = null;
    this.time = 0;
    this.cache = new Map();
    this.scratch = makeCanvas(128, 128);
  }

  setFont(name) { this.font = this.fonts[name]; }
  setSize(points) { this.scale = (points || this.font.defPoints) / this.font.sampleSize; }
  setScale(s) { this.scale = s || this.font.defPoints / this.font.sampleSize; }
  setColor(r, g, b, a = 1) { this.color = [r, g, b, a]; this.color2 = [r, g, b, a]; }
  setColor2(r, g, b, a = 1) { this.color2 = [r, g, b, a]; }
  setWarp(w) { this.warp = w; }
  // Where the warp noise is sampled, instead of the drawing position.  Lets a
  // moving title keep a steady wobble (null: sample at the drawing position).
  setWarpOrigin(x, y) { this.warpOrigin = x == null ? null : { x, y }; }

  strWidth(str) {
    const f = this.font;
    let sum = 0;
    for (const ch of str) {
      if (ch === ' ') sum += f.spaceAX;
      else {
        const g = f.glyphs[ch.charCodeAt(0)];
        if (g) sum += g.ax;
      }
    }
    return sum;
  }

  // x === -1 centers the string, as in the original
  puts(ctx, x, y, str) {
    if (!str) return;
    const alpha = this.color[3];
    if (alpha <= 0.004) return;
    if (this.warp) return this.putsWarped(ctx, x, y, str);

    const img = this.textImage(str);
    const s = this.scale;
    const left = x === -1 ? -this.strWidth(str) / 2 * s : x;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, left + img.ox * s, -(y + img.top * s), img.width * s, img.height * s);
    ctx.globalAlpha = 1;
  }

  // The string rendered once at the atlas resolution, tinted per glyph
  // (color at the glyph bottom, color2 at the top)
  textImage(str) {
    const f = this.font;
    const c1 = this.color, c2 = this.color2;
    const key = `${f.image.src}|${str}|${c1[0]},${c1[1]},${c1[2]}|${c2[0]},${c2[1]},${c2[2]}`;
    let img = this.cache.get(key);
    if (img) return img;

    let pen = 0, top = 0, bottom = 0, minX = 0, maxX = 1;
    const placed = [];
    for (const ch of str) {
      if (ch === ' ') { pen += f.spaceAX; continue; }
      const g = f.glyphs[ch.charCodeAt(0)];
      if (!g) continue;
      placed.push([g, pen]);
      top = Math.max(top, g.oy);
      bottom = Math.min(bottom, g.oy - g.h);
      minX = Math.min(minX, pen + g.ox);
      maxX = Math.max(maxX, pen + g.ox + g.w);
      pen += g.ax;
    }
    img = makeCanvas(maxX - minX + 2, top - bottom + 2);
    img.top = top;
    img.ox = minX;
    const ctx = img.ctx;
    for (const [g, px] of placed) {
      const gx = px + g.ox - minX, gy = top - g.oy;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(f.image, g.x, g.y, g.w, g.h, gx, gy, g.w, g.h);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = gradient(ctx, gy, gy + g.h, c1, c2);
      ctx.fillRect(gx, gy, g.w, g.h);
    }
    if (this.cache.size > 300) this.cache.clear();
    this.cache.set(key, img);
    return img;
  }

  // Each glyph wobbles and swells with gradient noise (title lettering)
  putsWarped(ctx, x, y, str) {
    const f = this.font;
    const s = this.scale;
    let rx = x, ry = y;
    if (x === -1) rx = -this.strWidth(str) / 2 * s;
    let pen = rx;
    if (this.warpOrigin) { rx = this.warpOrigin.x; ry = this.warpOrigin.y; }
    const base = ctx.getTransform();
    ctx.globalAlpha = this.color[3];
    for (const ch of str) {
      if (ch === ' ') { pen += f.spaceAX * s; rx += f.spaceAX; continue; }
      const g = f.glyphs[ch.charCodeAt(0)];
      if (!g) continue;
      rx += g.ox;
      ry += g.oy;
      const rotWarp = gnoise3d(rx * 0.125, ry * 0.125, this.time * 0.5);
      const sizeWarp = gnoise3d(1.25 + rx * 0.125, ry * 0.125, 0);
      const glyph = this.glyphImage(g);
      ctx.setTransform(base);
      ctx.translate(pen + g.ox * s, -(y + g.oy * s));
      ctx.rotate(-rotWarp * 20 * Math.PI / 180);
      const k = s * (1 + sizeWarp * 0.5);
      ctx.drawImage(glyph, 0, 0, g.w, g.h, 0, 0, g.w * k, g.h * k);
      rx += g.ax - g.ox;
      ry -= g.oy;
      pen += g.ax * s;
    }
    ctx.setTransform(base);
    ctx.globalAlpha = 1;
  }

  glyphImage(g) {
    const c = this.scratch;
    if (c.width < g.w || c.height < g.h) {
      c.width = Math.max(c.width, g.w);
      c.height = Math.max(c.height, g.h);
    }
    const ctx = c.ctx;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.font.image, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = gradient(ctx, 0, g.h, this.color, this.color2);
    ctx.fillRect(0, 0, g.w, g.h);
    return c;
  }
}

function gradient(ctx, y0, y1, bottomColor, topColor) {
  if (bottomColor[0] === topColor[0] && bottomColor[1] === topColor[1] && bottomColor[2] === topColor[2])
    return cssColor(bottomColor);
  const grad = ctx.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, cssColor(topColor));
  grad.addColorStop(1, cssColor(bottomColor));
  return grad;
}
