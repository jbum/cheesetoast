// Image loading plus a cache of tinted sprite cells (GL_MODULATE stand-in).

import { TEXTURE_DEFS } from './constants.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load ' + src));
    img.src = src;
  });
}

export async function loadTextures(onProgress) {
  let done = 0;
  return Promise.all(TEXTURE_DEFS.map(async ([file, tileSize]) => {
    const image = await loadImage('assets/img/' + file);
    onProgress && onProgress(++done / TEXTURE_DEFS.length);
    return { image, tileSize };
  }));
}

export function makeCanvas(w, h, opts) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  c.ctx = c.getContext('2d', opts);
  return c;
}

const tintCache = new Map();

// Returns a canvas holding one sprite cell multiplied by an rgb tint
// (and optionally a vertical gradient: rgb at the bottom, rgb2 at the top).
export function tintedCell(image, sx, sy, sw, sh, rgb, rgb2 = rgb) {
  const key = `${image.src}|${sx}|${sy}|${sw}|${sh}|${rgb}|${rgb2}`;
  let c = tintCache.get(key);
  if (c) return c;
  c = makeCanvas(sw, sh);
  const ctx = c.ctx;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.globalCompositeOperation = 'multiply';
  if (rgb === rgb2) {
    ctx.fillStyle = cssColor(rgb);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, sh);
    g.addColorStop(0, cssColor(rgb2));
    g.addColorStop(1, cssColor(rgb));
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, sw, sh);
  // multiply leaves the alpha opaque, so restore the cell's own alpha
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  tintCache.set(key, c);
  return c;
}

export function cssColor(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
}
