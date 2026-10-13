#!/usr/bin/env node
// Battle puzzles: set up each board in the real game (no game runs), ask the
// policy once per repeat, grade the answer against the puzzle's expectations.
//
//   node bots/puzzles/run.mjs --show                    boards only: what the bot sees (free)
//   node bots/puzzles/run.mjs --variants current,old [--repeat 3] [--only id,id] [--mined] [--suite coop]
//
// Grading: steer must be one of expect.steer; fire = noul > 0.5; shield = noul > --shield-at (0.5);
// thrust = noul > 0.5 (the thresholds the bots use).  Results go to bots/puzzles/results/.
import fs from 'fs';
import path from 'path';
import { loadPlaywright, parseArgs, chromiumLaunchOptions, serveRepo, LOCAL_URL } from '../lib.mjs';
import { makeJev } from '../policies/jev.mjs';
import { PUZZLES as MELEE } from './puzzles.mjs';
import { PUZZLES as COOP } from './puzzles-coop.mjs';
import { VARIANTS } from './prompts.mjs';

const args = parseArgs(process.argv.slice(2), { variants: 'current', repeat: 2, only: '', show: false, mined: false, 'mined-only': false, 'shield-at': 0.5, suite: 'melee' });
// suites: melee (puzzles.mjs + mined.json) or coop (puzzles-coop.mjs + mined-coop.json)
const SUITES = { melee: [MELEE, 'mined.json'], coop: [COOP, 'mined-coop.json'] };
const [PUZZLES, MINED] = SUITES[args.suite] || SUITES.melee;
const here = path.dirname(new URL(import.meta.url).pathname);
let puzzles = args['mined-only'] ? [] : [...PUZZLES];
if (args.mined || args['mined-only']) {
  const f = path.join(here, MINED);
  if (fs.existsSync(f)) puzzles.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
if (args.only) { const ids = new Set(String(args.only).split(',')); puzzles = puzzles.filter((p) => ids.has(p.id)); }

const { chromium } = loadPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await serveRepo(context, path.resolve(here, '../..'));
const page = await context.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(LOCAL_URL + '?agent&solo');
await page.waitForFunction(() => window.ctAgent && document.getElementById('start').classList.contains('ready'), null, { timeout: 60000 });
await page.evaluate(() => { ctAgent.seed(1); ctAgent.manual(true); ctAgent.start(); });

const states = {};
for (const p of puzzles) {
  states[p.id] = await page.evaluate((b) => ctAgent.setup(b), { mode: p.mode, me: p.me, things: p.things, rivals: p.rivals, rivalShots: p.rivalShots });
}
await browser.close();

if (args.show) {
  for (const p of puzzles) {
    const st = states[p.id];
    console.log(`\n${p.id} (${p.mode}): ${p.why}\n  expect ${JSON.stringify(p.expect)}`);
    for (const e of st.entities.slice(0, 8))
      console.log(`  ${e.kind.padEnd(10)} ${String(e.type).padEnd(10)} gap ${String(e.gap).padStart(4)} bearing ${String(e.bearing).padStart(4)} steps ${String(e.turn_steps).padStart(3)} closing ${String(e.closing).padStart(5)} impact ${String(e.ticks_to_impact).padStart(4)} ${e.in_fire_range ? 'in range' : ''}${e.on_radar_only ? ' (radar)' : ''}`);
  }
  process.exit(0);
}

function grade(p, raw) {
  const e = p.expect, fails = [];
  if (e.steer && !e.steer.includes(raw.steer)) fails.push(`steer ${raw.steer}`);
  if (e.fire !== undefined && (raw.fire > 0.5) !== e.fire) fails.push(`fire ${raw.fire}`);
  if (e.shield !== undefined && (raw.shield > args['shield-at']) !== e.shield) fails.push(`shield ${raw.shield}`);
  if (e.thrust !== undefined && (raw.thrust > 0.5) !== e.thrust) fails.push(`thrust ${raw.thrust}`);
  return fails;
}

const variants = String(args.variants).split(',');
const results = {};
let calls = 0, tokens = 0;
for (const v of variants) {
  if (!VARIANTS[v]) throw new Error('unknown variant ' + v);
  const pol = makeJev(VARIANTS[v]);
  results[v] = {};
  // all puzzles x repeats in parallel batches (independent calls)
  const jobs = [];
  for (const p of puzzles) for (let r = 0; r < args.repeat; r++) jobs.push(p);
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map(async (p) => {
      const d = await pol.decide(states[p.id], []);
      const raw = d.raw || { steer: '?', fire: 0, shield: 0, thrust: 0 };
      (results[v][p.id] ||= []).push({ raw, fails: d.raw ? grade(p, raw) : ['no answer'] });
    }));
  }
  calls += pol.calls; tokens += pol.inputTokens;
}

// report: puzzle x variant, passes / repeats
const w = Math.max(...puzzles.map((p) => p.id.length));
console.log('\n' + 'puzzle'.padEnd(w) + '  ' + variants.map((v) => v.padStart(9)).join(''));
const totals = Object.fromEntries(variants.map((v) => [v, 0]));
for (const p of puzzles) {
  const cells = variants.map((v) => {
    const rs = results[v][p.id];
    const ok = rs.filter((r) => !r.fails.length).length;
    totals[v] += ok / rs.length;
    return `${ok}/${rs.length}`.padStart(9);
  });
  console.log(p.id.padEnd(w) + '  ' + cells.join(''));
}
console.log('SCORE'.padEnd(w) + '  ' + variants.map((v) => `${(100 * totals[v] / puzzles.length).toFixed(0)}%`.padStart(9)).join(''));
console.log('\nfailures:');
for (const v of variants) for (const p of puzzles) {
  const bad = results[v][p.id].filter((r) => r.fails.length);
  if (bad.length) console.log(`  ${v} ${p.id}: ${bad.map((r) => r.fails.join(', ')).join(' | ')}`);
}
console.log(`\n${calls} Jev calls, ${tokens} input tokens (~$${(tokens * 0.042 / 1e6).toFixed(3)})`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.writeFileSync(path.join(here, 'results', `${stamp}-${args.suite}-${variants.join('-')}.json`), JSON.stringify({ variants, repeat: args.repeat, results }, null, 1));
