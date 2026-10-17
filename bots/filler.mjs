#!/usr/bin/env node
// Fill-in bot daemon: watches the live site's matchmaker and, when a person
// has waited --wait seconds for company, sends a bot into their universe.
// Bots are named after hurricanes with a robot prefix ("🤖 Arlene"), wear the
// blinking LED, never wait in the queue themselves (joinOnly), and leave once
// no people are left in their universe.  Runs on a spare machine (see MULTIPLAYER.md).
// No browser: each bot is its own Node process (headless-bot.mjs) running the
// game's code, copied from the site before each bot starts (headless.mjs
// syncSiteCode), so the bots always speak the protocol that's deployed.
//
//   node bots/filler.mjs [--url https://ct.krazydad.com/] [--wait 30] [--max-bots 3]
//        [--policy heuristic|jev] [--poll 5] [--alone 15] [--once] [--code DIR]
//   --code: run this copy of the game's code instead of the site's (local tests)
import { fork } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { parseArgs, sleep } from './lib.mjs';
import { syncSiteCode } from './headless.mjs';

const args = parseArgs(process.argv.slice(2), {
  url: 'https://ct.krazydad.com/', wait: 30, 'max-bots': 3, policy: 'heuristic', poll: 5, alone: 15, once: false, code: '',
});
const URL = args.url.endsWith('/') ? args.url : args.url + '/';

// Atlantic hurricane names (the six-year rotation)
const HURRICANES = `Arlene Bret Cindy Don Emily Franklin Gert Harold Idalia Jose Katia Lee Margot Nigel Ophelia
  Philippe Rina Sean Tammy Vince Whitney Alberto Beryl Chris Debby Ernesto Francine Gordon Helene Isaac Joyce Kirk
  Leslie Milton Nadine Oscar Patty Rafael Sara Tony Valerie William Andrea Barry Chantal Dexter Erin Fernand Gabrielle
  Humberto Imelda Jerry Karen Lorenzo Melissa Nestor Olga Pablo Rebekah Sebastien Tanya Van Wendy Arthur Bertha
  Cristobal Dolly Edouard Fay Gonzalo Hanna Isaias Josephine Kyle Leah Marco Nana Omar Paulette Rene Sally Teddy
  Vicky Wilfred Ana Bill Claudette Danny Elsa Fred Grace Henri Ida Julian Kate Larry Mindy Nicholas Odette Peter
  Rose Sam Teresa Victor Wanda Alex Bonnie Colin Danielle Earl Farrah Gaston Hermine Ian Julia Karl Lisa Martin
  Nicole Owen Paula Richard Shary Tobias Virginie Walter`.split(/\s+/);

const log = (m) => console.log(`${new Date().toISOString().slice(0, 19)} ${m}`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(os.homedir(), '.ct-bot-code');
const bots = new Set();
const recentByMode = new Map();   // mode -> time of the last bot sent (one at a time per mode)

function pickName() {
  const used = new Set([...bots].map((b) => b.name));
  const free = HURRICANES.filter((n) => !used.has('🤖 ' + n));
  return '🤖 ' + free[Math.floor(Math.random() * free.length)];
}

// the game's code for the next bot: the site's current files (or --code)
let lastCode = null;
async function gameCode() {
  if (args.code) return path.resolve(String(args.code));
  const dir = await syncSiteCode(URL, CACHE);
  if (dir !== lastCode) {
    log(`game code: ${path.basename(dir)}`);
    lastCode = dir;
    // keep the newest few copies (a running bot may still use an older one)
    const old = fs.readdirSync(CACHE).map((d) => path.join(CACHE, d)).filter((d) => d !== dir)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(3);
    for (const d of old) fs.rmSync(d, { recursive: true, force: true });
  }
  return dir;
}

async function runBot(mode) {
  const bot = { name: pickName(), mode };
  bots.add(bot);
  recentByMode.set(mode, Date.now());
  try {
    const code = await gameCode();
    const child = fork(path.join(HERE, 'headless-bot.mjs'), ['--url', URL, '--code', code, '--name', bot.name, '--mode', mode,
      '--policy', args.policy, '--alone', String(args.alone)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    bot.child = child;
    for (const s of [child.stdout, child.stderr]) readline.createInterface({ input: s }).on('line', (l) => log(`${bot.name}: ${l}`));
    const how = await new Promise((resolve) => child.on('exit', (c, sig) => resolve(sig || c)));
    if (how) log(`${bot.name}: exited (${how})`);
  } catch (e) {
    log(`${bot.name}: ${e.message.split('\n')[0]}`);
  } finally {
    bots.delete(bot);
  }
}

async function status() {
  const res = await fetch(URL + 'mm/status', { cache: 'no-store' });
  return res.json();
}

log(`filler: watching ${URL} (wait ${args.wait}s, up to ${args['max-bots']} bots, ${args.policy} policy)`);
const stop = async () => {
  log('stopping');
  for (const b of bots) b.child && b.child.kill('SIGTERM');   // they leave their games
  await sleep(1500);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let lastErr = '', sentAny = false;
while (true) {
  try {
    const s = await status();
    lastErr = '';
    for (const [mode, ages] of Object.entries(s.waiting || {})) {
      const longest = Math.max(0, ...ages);
      const sending = [...bots].some((b) => b.mode === mode) && Date.now() - (recentByMode.get(mode) || 0) < 20000;
      if (longest >= args.wait && !sending && bots.size < args['max-bots']) {
        log(`someone has waited ${longest}s for ${mode}: sending a bot`);
        sentAny = true;
        runBot(mode);
      }
    }
  } catch (e) {
    const m = e.message.split('\n')[0];
    if (m !== lastErr) log(`status: ${m}`);
    lastErr = m;
  }
  if (args.once && sentAny && bots.size === 0) break;   // testing: one round, then exit
  await sleep(args.poll * 1000);
}
log('done');
