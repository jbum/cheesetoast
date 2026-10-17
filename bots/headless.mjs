// The real game (js/game.js, net.js, mp.js, agent.js) running in Node, with
// no browser: a bot plays online through the matchmaker and WebRTC
// (node-datachannel) exactly as the page does.  Nothing is drawn or heard.
// What the page gets from the browser is stood in for here: a canvas whose
// 2D context ignores everything, images that are only their sizes,
// localStorage in memory, EventSource over fetch, and document/window/navigator
// with just what the game reads.
//
//   const { game, agent, mp } = await startHeadless({ url, code })
//     url:  the site the bot plays on (its matchmaker, score server, ?relay...)
//     code: a directory with the site's js/ and assets/ (the repo, or a copy
//           of the live site's: syncSiteCode)
//
// One game per process: the game's modules keep module-level state
// (sprites.js setGame, agent.js uids), so filler.mjs runs each bot as its own
// process (headless-bot.mjs).
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const W = 1280, H = 720;

// ------------------------------------------------------------ stand-ins

// A 2D context that accepts every call and draws nothing
function fakeContext(canvas) {
  const dummy = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : dummy), apply: () => dummy, set: () => true });
  const target = {
    canvas,
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),   // transparent: explosions make no sparks
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    measureText: (s) => ({ width: String(s).length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse() { return this; } }),
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => dummy),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

function fakeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), width: W, height: H, clientWidth: W, clientHeight: H,
    style: { setProperty() {} }, dataset: {}, children: [], textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { return c; }, remove() {},
    setAttribute() {}, getAttribute: () => null, querySelector: () => fakeElement(), focus() {}, blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
  };
  if (tag === 'canvas') {
    let ctx = null;
    el.getContext = () => (ctx = ctx || fakeContext(el));
  }
  return el;
}

// EventSource (what the matchmaker's event stream needs: onmessage, close,
// and reconnecting after a dropped connection, as browsers do)
class FetchEventSource {
  constructor(url) {
    this.url = String(url);
    this.onmessage = null; this.onerror = null; this.onopen = null;
    this.readyState = 0;
    this.closed = false;
    this.connect();
  }
  async connect() {
    while (!this.closed) {
      this.ctrl = new AbortController();
      try {
        const res = await fetch(this.url, { headers: { Accept: 'text/event-stream' }, signal: this.ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        this.readyState = 1;
        this.onopen && this.onopen({});
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
            if (data.length && this.onmessage && !this.closed) this.onmessage({ data: data.join('\n') });
          }
        }
      } catch (e) { /* dropped, or closed */ }
      if (this.closed) break;
      this.readyState = 0;
      this.onerror && this.onerror({});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  close() { this.closed = true; this.readyState = 2; try { this.ctrl && this.ctrl.abort(); } catch (e) { /* done */ } }
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const define = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

export async function installBrowserShims(url) {
  const page = new URL(url);
  if (!page.searchParams.has('agent')) page.searchParams.set('agent', '');
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = await import('node-datachannel/polyfill');
  define('RTCPeerConnection', RTCPeerConnection);
  define('RTCSessionDescription', RTCSessionDescription);
  define('RTCIceCandidate', RTCIceCandidate);
  define('window', globalThis);
  define('location', page);
  define('history', { replaceState() {}, pushState() {} });
  define('localStorage', memoryStorage());
  define('sessionStorage', memoryStorage());
  define('navigator', { userAgent: 'Cheese Toast headless bot (Node ' + process.version + ')', maxTouchPoints: 0, platform: 'node', onLine: true });
  define('EventSource', FetchEventSource);
  define('innerWidth', W); define('innerHeight', H); define('devicePixelRatio', 1);
  define('addEventListener', () => {}); define('removeEventListener', () => {});
  define('matchMedia', () => ({ matches: false, addEventListener() {}, addListener() {} }));
  define('requestAnimationFrame', (fn) => setTimeout(() => fn(performance.now()), 16));
  define('document', {
    hidden: false, visibilityState: 'visible',
    body: fakeElement('body'), documentElement: fakeElement('html'),
    createElement: (tag) => fakeElement(tag), getElementById: () => fakeElement(),
    querySelector: () => fakeElement(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  });
  // the page's relative URLs (mm/play, api/scores) are relative to the site
  const realFetch = globalThis.fetch;
  define('fetch', (input, init) => realFetch(typeof input === 'string' && !/^[a-z]+:/i.test(input) ? new URL(input, page).href : input, init));
}

// ------------------------------------------------------------ the game

// a PNG's size from its header (IHDR: width and height at bytes 16-23)
export function pngSize(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export async function startHeadless({ url, code, log = () => {} }) {
  await installBrowserShims(url);
  const mod = (f) => import(pathToFileURL(path.join(code, 'js', f)).href);
  const [{ TEXTURE_DEFS, GS }, { Game }, { FontMgr }, { Input }, { installMultiplayer }, { installAgent }] = await Promise.all(
    ['constants.js', 'game.js', 'font.js', 'input.js', 'mp.js', 'agent.js'].map(mod));

  // images: only their sizes matter (sprites.js counts a sheet's columns)
  // (a copy of the live site's code has them in img-sizes.json; the repo's are read from the files)
  const sizesFile = path.join(code, 'assets', 'img-sizes.json');
  const sizes = fs.existsSync(sizesFile) ? JSON.parse(fs.readFileSync(sizesFile, 'utf8')) : {};
  if (!fs.existsSync(sizesFile))
    for (const f of fs.readdirSync(path.join(code, 'assets', 'img'))) if (f.endsWith('.png')) sizes[f] = pngSize(fs.readFileSync(path.join(code, 'assets', 'img', f)).subarray(0, 64));
  const textures = TEXTURE_DEFS.map(([file, tileSize]) => {
    const name = file.replace(/\?.*$/, '');
    const s = sizes[name];
    if (!s) throw new Error('no size for ' + name);
    return { image: { src: 'assets/img/' + file, width: s.width, height: s.height, naturalWidth: s.width, naturalHeight: s.height, complete: true }, tileSize };
  });
  const fontData = JSON.parse(fs.readFileSync(path.join(code, 'assets', 'fonts.json'), 'utf8'));
  const font = new FontMgr(fontData, { comic: textures[8].image, goudy: textures[9].image });
  const silence = () => {};
  const snd = new Proxy({ enabled: false }, { get: (t, k) => (k in t ? t[k] : (k === 'status' ? () => 'headless' : silence)), set: (t, k, v) => { t[k] = v; return true; } });
  const input = new Input();
  const game = new Game({ canvas: fakeElement('canvas'), textures, font, snd, input, debug: false });
  // nothing to look at: no drawing at all (frame() keeps the game's logic
  // apart from its render* methods; agent.setDraw(false) only covers Play)
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(game))) if (/^render/.test(k)) game[k] = () => {};

  let mp = null;
  // what main.js's stateChanged does that matters without a page: a solo host
  // whose game ends leaves the matchmaker's queue
  game.ui = { stateChanged: (state) => { if (mp && state === GS.GameOver) mp.gameOver(); }, engraveRetry() {} };
  let status = '';
  const setStatus = (t) => { if (t && t !== status && !/^\S+: connecting to .* \d+ /.test(t)) log('status: ' + t); status = t; };
  mp = installMultiplayer(game, { setStatus, modeChanged() {}, askName: async () => null });
  mp.chatEvents = [];
  mp.stepAway = () => {};
  const agent = installAgent(game, input, { hideStart() {}, mp });
  agent.setDraw(false);
  game.startup();

  // the frame loop (the page's requestAnimationFrame)
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    try { game.frame((now - last) / 1000); } catch (e) { log('frame: ' + (e.stack || e.message)); }
    last = now;
  }, 16);
  return { game, agent, mp, stop: () => clearInterval(timer) };
}

// ------------------------------------------------------------ the site's code

// Copy the code the bot runs from the site itself (js/ modules, followed from
// the ones startHeadless loads, plus fonts.json and the images' sizes), so
// bots always play the protocol that's deployed.  Copies go in
// <cache>/<hash of the files>/, and the directory is returned.
export async function syncSiteCode(url, cache) {
  const base = new URL(url);
  const files = new Map();
  const get = async (rel, opts) => {
    const res = await fetch(new URL(rel, base), { cache: 'no-store', ...opts });
    if (!res.ok && res.status !== 206) throw new Error(`${rel}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const todo = ['constants.js', 'game.js', 'font.js', 'input.js', 'mp.js', 'agent.js'];
  while (todo.length) {
    const f = todo.shift();
    if (files.has('js/' + f)) continue;
    const text = (await get('js/' + f)).toString('utf8');
    files.set('js/' + f, text);
    for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*)['"]\.\/([\w.-]+\.js)['"]/g)) todo.push(m[1]);
  }
  files.set('assets/fonts.json', (await get('assets/fonts.json')).toString('utf8'));
  const { TEXTURE_DEFS } = await import('data:text/javascript;base64,' + Buffer.from(files.get('js/constants.js')).toString('base64'));
  const sizes = {};
  for (const [file] of TEXTURE_DEFS) {
    const name = file.replace(/\?.*$/, '');
    sizes[name] = pngSize(await get('assets/img/' + file, { headers: { Range: 'bytes=0-63' } }));
  }
  files.set('assets/img-sizes.json', JSON.stringify(sizes));
  const { createHash } = await import('crypto');
  const h = createHash('sha1');
  for (const [k, v] of [...files].sort()) h.update(k).update('\0').update(v).update('\0');
  const dir = path.join(cache, h.digest('hex').slice(0, 12));
  if (!fs.existsSync(path.join(dir, 'assets', 'img-sizes.json'))) {
    for (const [k, v] of files) {
      fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true });
      fs.writeFileSync(path.join(dir, k), v);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type": "module"}\n');
  }
  return dir;
}
