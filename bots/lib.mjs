// Shared bits for the Cheese Toast bots: loading Playwright, reading the
// TypeSafe key, small helpers.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  const tries = [
    'playwright',
    'playwright-core',   // enough with the installed Chrome (e.g. the filler daemon on a spare machine)
    '/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright',   // bundled with playwright-cli
  ];
  for (const t of tries) {
    try { return require(t); } catch (e) { /* next */ }
  }
  throw new Error('Playwright not found: npm i -D playwright, or install @playwright/cli');
}

// TYPESAFE_API_KEY from the environment, or from a .env file (JEV_ENV, or ~/.jev.env)
export function typesafeKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const file = process.env.JEV_ENV || path.join(os.homedir(), '.jev.env');
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch (e) { /* none */ }
  return null;
}

export function parseArgs(argv, defaults) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = isNaN(+next) ? next : +next; i++; }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Launch options for Chromium: if this Playwright wants a browser build that
// isn't installed, use the newest headless shell that is.
// Bots on one machine connect to each other over WebRTC: let Chromium use real
// local addresses instead of mDNS names (which the headless shell can't resolve).
const CHROME_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'];

// Prefer the installed Google Chrome: on a Mac with the firewall on, it's the
// browser allowed to accept the incoming WebRTC packets bots send each other.
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function chromiumLaunchOptions() {
  if (process.env.CT_CHROMIUM) return { headless: true, executablePath: process.env.CT_CHROMIUM, args: CHROME_ARGS };
  if (fs.existsSync(SYSTEM_CHROME) && !process.env.CT_NO_SYSTEM_CHROME) return { headless: true, executablePath: SYSTEM_CHROME, args: CHROME_ARGS };
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    const shells = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
    for (const d of shells) {
      const exe = path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
      if (fs.existsSync(exe)) return { headless: true, executablePath: exe, args: CHROME_ARGS };
    }
  } catch (e) { /* fall back to Playwright's default */ }
  return { headless: true, args: CHROME_ARGS };
}

// Serve the game straight from the repo to a Playwright context (no web
// server needed): any request to http://ct.local/ is answered from disk.
// The score API isn't there, so the game quietly uses local scores.
export const LOCAL_URL = 'http://ct.local/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
export async function serveRepo(context, root) {
  await context.route(LOCAL_URL + '**', async (route) => {
    const u = new URL(route.request().url());
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.startsWith('api/')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no api here' });
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
}
