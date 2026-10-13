#!/usr/bin/env node
// Play single-player Cheese Toast with a bot policy, headless, and log every
// tick of the universe for videos (tools/render-video.py).
//
//   node bots/run-solo.mjs --policy heuristic|jev [--url https://ctm.krazydad.com/ (default: this repo, from disk)]
//        [--games 1] [--seed 1] [--every 4] [--max-ticks 12000] [--parallel 1]
//        [--logdir bots/logs] [--tag name]
//
// The game is paused while the policy thinks (manual stepping), so a slow
// policy (Jev over the network) still plays at full game speed.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadPlaywright, parseArgs, chromiumLaunchOptions, serveRepo, LOCAL_URL } from './lib.mjs';
import { makeHeuristic } from './policies/heuristic.mjs';

const args = parseArgs(process.argv.slice(2), {
  policy: 'heuristic', url: LOCAL_URL, games: 1, seed: 1, every: 4,
  'max-ticks': 12000, parallel: 1, logdir: 'bots/logs', tag: '', kick: 5,
});

async function makePolicy(name) {
  if (name === 'heuristic') return makeHeuristic({ every: args.every });
  if (name === 'jev-old') return (await import('./policies/jev.mjs')).makeJev({ every: args.every, history: args.history ?? 0, modeAware: false });
  if (name === 'jev') return (await import('./policies/jev.mjs')).makeJev({ every: args.every, history: args.history ?? 0,
    brake: !!args.brake, thrust: args.thrust || 'fixed', turning: args.turning || 'coarse' });
  throw new Error('unknown policy ' + name);
}

async function playOne(browser, seed) {
  const policy = await makePolicy(args.policy);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (args.url === LOCAL_URL) await serveRepo(context, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const url = args.url + (args.url.includes('?') ? '&' : '?') + 'agent&solo';   // solo: no matchmaker
  await page.goto(url);
  await page.waitForFunction(() => window.ctAgent && document.getElementById('start').classList.contains('ready'), null, { timeout: 60000 });
  const textures = await page.evaluate(([s, k]) => { ctAgent.seed(s); ctAgent.setKick(k); ctAgent.manual(true); ctAgent.start(); return ctAgent.textures(); }, [seed, args.kick || 0]);

  fs.mkdirSync(args.logdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}-${args.policy}${args.tag ? '-' + args.tag : ''}-seed${seed}`;
  const logPath = path.join(args.logdir, name + '.jsonl.gz');
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(logPath);
  gz.pipe(out);
  gz.write(JSON.stringify({ meta: { seed, policy: args.policy, every: args.every, textures, universe: [3840, 1920], started: stamp } }) + '\n');

  const history = [];
  let tick = 0, decisions = 0, thinkMs = 0, deaths = 0, lastPots = null, lastAlive = true;
  const t0 = Date.now();
  while (tick < args['max-ticks']) {
    const st = await page.evaluate(() => ctAgent.state());
    if (!st.playing) break;
    if (lastPots !== null && st.pots_left < lastPots) deaths++;
    lastPots = st.pots_left;
    const tt = Date.now();
    const d = await policy.decide(st, history);
    thinkMs += Date.now() - tt;
    decisions++;
    const worlds = await page.evaluate((plan) => {
      const ws = [];
      for (const c of plan) {
        ctAgent.setControls(c);
        const r = ctAgent.step(1, true);
        ws.push(...r.worlds);
        if (r.state !== 1) break;
      }
      ctAgent.setControls({});
      return ws;
    }, d.plan);
    for (const w of worlds) { w.a = d.label; gz.write(JSON.stringify(w) + '\n'); }
    history.push({ st, action: d });
    if (history.length > 50) history.shift();
    tick = st.tick + worlds.length;
    if (decisions % 100 === 0)
      console.log(`  [seed ${seed}] tick ${tick} score ${st.score} level ${st.level} pots ${st.pots_left} (${(thinkMs / decisions).toFixed(0)} ms/decision)`);
  }
  const final = await page.evaluate(() => ctAgent.state());
  gz.end();
  await new Promise((r) => out.on('finish', r));
  await context.close();
  const result = { seed, policy: args.policy, score: final.score, level: final.level, ticks: tick,
    seconds: +(tick / 20).toFixed(1), gameOver: !final.playing, decisions,
    msPerDecision: Math.round(thinkMs / Math.max(1, decisions)), wallSeconds: Math.round((Date.now() - t0) / 1000), log: logPath,
    calls: policy.calls || 0, inputTokens: policy.inputTokens || 0,
    tokensPerCall: policy.calls ? Math.round((policy.inputTokens || 0) / policy.calls) : 0 };
  console.log(JSON.stringify(result));
  return result;
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const seeds = Array.from({ length: args.games }, (_, i) => args.seed + i);
const results = [];
for (let i = 0; i < seeds.length; i += args.parallel) {
  results.push(...await Promise.all(seeds.slice(i, i + args.parallel).map((s) => playOne(browser, s))));
}
await browser.close();
if (results.length > 1) {
  const scores = results.map((r) => r.score);
  console.log(`SUMMARY ${args.policy}: scores ${scores.join(', ')}  mean ${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}  max ${Math.max(...scores)}`);
}
