#!/usr/bin/env node
// Two (or more) bots share one Cheese Toast universe in real time: the first
// hosts, the others join.  Local test transport (BroadcastChannel inside one
// headless browser), optional simulated lag.  The universe is recorded every
// tick from whichever bot is host, for tools/render-video.py.
//
//   node bots/run-mp.mjs --policies jev,heuristic --mode coop|duel [--seconds 180]
//        [--lag 40 --jitter 20 --loss 0.02] [--names Jev,Bot] [--every 4] [--tag name]
//
// --online: play on the live test site through the real matchmaker and WebRTC
// (each bot in its own browser context, like separate machines):
//   node bots/run-mp.mjs --online [--url https://ctm.krazydad.com/] --policies jev,jev --mode duel
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadPlaywright, parseArgs, chromiumLaunchOptions, serveRepo, LOCAL_URL, sleep } from './lib.mjs';
import { makeHeuristic } from './policies/heuristic.mjs';

const args = parseArgs(process.argv.slice(2), {
  policies: 'jev,heuristic', mode: 'coop', seconds: 180, lag: 30, jitter: 20, loss: 0, every: 4,
  names: '', tag: '', logdir: 'bots/logs', url: LOCAL_URL, 'stay-seconds': 0, online: false, chat: false, max: 0, kick: 5,
  'last-standing': 0,   // > 0: once one player is left, record this many more seconds, then stop
});
if (args.online && args.url === LOCAL_URL) args.url = 'https://ct.krazydad.com/';   // the live site (ctm redirects there)
const policyNames = String(args.policies).split(',');
const names = args.names ? String(args.names).split(',') : policyNames.map((p, i) => ({ jev: 'Jev', kamikaze: 'Kami' }[p] || 'Bot') + (policyNames.length > 1 ? ' ' + (i + 1) : ''));

async function makePolicy(name) {
  if (name === 'heuristic') return makeHeuristic({ every: args.every });
  if (name === 'jev-old') return (await import('./policies/jev.mjs')).makeJev({ every: args.every, history: args.history ?? 0, modeAware: false });
  if (name === 'jev') return (await import('./policies/jev.mjs')).makeJev({ every: args.every, history: args.history ?? 0 });
  if (name === 'kamikaze') return (await import('./policies/kamikaze.mjs')).makeKamikaze({ every: args.every });
  throw new Error('unknown policy ' + name);
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
// ---- consistency checks (online): each guest's view against its host's, every 2 s
const issues = [];
const strikes = new Map();
const gapMaxes = [];
const tor = (dx, dy) => { dx = ((dx % 3840) + 5760) % 3840 - 1920; dy = ((dy % 1920) + 2880) % 1920 - 960; return Math.hypot(dx, dy); };
function flag(key, msg, sec) {   // only a problem if it shows in two samples in a row
  const n = (strikes.get(key) || 0) + 1;
  strikes.set(key, n);
  if (n === 2) issues.push(`${sec}s ${msg}`);
}
const ok = (key) => strikes.delete(key);
const lastClock = new Map();
async function audit(bots, sec) {
  const au = await Promise.all(bots.map((b) => b.page.evaluate(() => ctAgent.audit()).catch(() => null)));
  const byId = new Map();
  au.forEach((a, i) => { if (a && a.id) byId.set(a.id, { a, b: bots[i] }); });
  au.forEach((a, i) => {
    if (!a) return;
    const name = bots[i].name;
    if (a.role === 'host' && a.state === 1) {
      const prev = lastClock.get(name);
      if (prev) {
        const rate = (a.clock - prev.clock) / ((Date.now() - prev.t) / 1000);
        if (rate < 15) flag('rate ' + name, `host ${name} ticking slowly: ${rate.toFixed(1)} ticks/s`, sec); else ok('rate ' + name);
      }
      lastClock.set(name, { clock: a.clock, t: Date.now() });
      const guests = au.filter((g) => g && g.role === 'guest' && g.hostId === a.id).length;
      if ((a.players || []).length !== guests + 1) flag('count ' + name, `host ${name} has ${(a.players || []).length} players but ${guests + 1} pages think they're in its game`, sec);
      else ok('count ' + name);
    }
    if (a.role === 'guest' && a.state === 1) {
      gapMaxes.push(a.gapMax);
      if (a.stalls) issues.push(`${sec}s ${name}: ${a.stalls} snapshot stall(s) over 1 s`);
      const H = byId.get(a.hostId);
      if (!H || H.a.role !== 'host') { flag('nohost ' + name, `${name}'s host isn't hosting`, sec); return; }
      ok('nohost ' + name);
      const me = (H.a.players || []).find((p) => p.id === a.id);
      if (!me) { flag('missing ' + name, `${name} isn't in its host's player list`, sec); return; }
      ok('missing ' + name);
      if (me.score !== a.local.score) flag('score ' + name, `${name} sees score ${a.local.score}, host has ${me.score}`, sec); else ok('score ' + name);
      if (me.pots !== a.local.pots) flag('pots ' + name, `${name} sees ${a.local.pots} pots, host has ${me.pots}`, sec); else ok('pots ' + name);
      if (me.pos && a.local.pos) {
        const d = tor(me.pos[0] - a.local.pos[0], me.pos[1] - a.local.pos[1]);
        if (d > 90) flag('pos ' + name, `${name}'s teapot is ${Math.round(d)} units from where the host has it`, sec); else ok('pos ' + name);
      }
    }
  });
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shared = await browser.newContext({ viewport: { width: 1280, height: 720 } });
if (args.url.startsWith(LOCAL_URL)) await serveRepo(shared, repoRoot);   // e.g. LOCAL_URL + "?solo"

const channel = 'test-' + Date.now();
const net = { lagMs: args.lag, jitterMs: args.jitter, loss: args.loss };
const bots = [];
for (let i = 0; i < policyNames.length; i++) {
  // online: a separate context per bot (separate "machines"); local: one context so BroadcastChannel connects them
  const context = args.online ? await browser.newContext({ viewport: { width: 1280, height: 720 } }) : shared;
  const page = await context.newPage();
  page.on('pageerror', (e) => { console.error(`page ${i} error:`, e.message); issues.push(`page error (${names[i]}): ${e.message}`); });
  await page.goto(args.url + (args.url.includes('?') ? '&' : '?') + 'agent' + (args.debug ? '&debug' : ''));
  await page.waitForFunction(() => window.ctAgent && document.getElementById('start').classList.contains('ready'), null, { timeout: 60000 });
  const id = i + 1;
  const opts = { channel, id, name: names[i], mode: args.mode, ...net };
  if (args.online) {
    if (i > 0) await sleep(3000);
    await page.evaluate((o) => { ctAgent.setDraw(false); ctAgent.setKick(o.kick); ctAgent.playOnline({ name: o.name, mode: o.mode, max: o.max }); ctAgent.record(true); },
      { ...opts, max: args.max || Math.max(2, policyNames.length), kick: args.kick || 0 });
  } else if (i === 0) await page.evaluate((o) => { ctAgent.setDraw(false); ctAgent.setKick(o.kick); ctAgent.host(o); ctAgent.record(true); }, { ...opts, kick: args.kick || 0 });
  else { await sleep(1500); await page.evaluate((o) => { ctAgent.setDraw(false); ctAgent.setKick(o.kick); ctAgent.join(o); ctAgent.record(true); }, { ...opts, kick: args.kick || 0 }); }   // (the kick was online-only before 2026-10-05)
  bots.push({ i, id, name: names[i], page, policy: await makePolicy(policyNames[i]), history: [], done: false, decisions: 0 });
}
const textures = await bots[0].page.evaluate(() => ctAgent.textures());

fs.mkdirSync(args.logdir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logPath = path.join(args.logdir, `${stamp}-mp-${args.mode}-${policyNames.join('-')}${args.tag ? '-' + args.tag : ''}.jsonl.gz`);
const gz = zlib.createGzip();
const out = fs.createWriteStream(logPath);
gz.pipe(out);
gz.write(JSON.stringify({ meta: { mode: args.mode, policies: policyNames, names, net, textures, universe: [3840, 1920],
  title: args.mode === 'coop' ? `Co-op: ${names.join(' & ')}` : `${args.mode === 'melee' ? 'Melee' : 'Duel'}: ${names.join(' vs ')}` } }) + '\n');

// each bot decides and acts in real time
async function botLoop(b) {
  // starting online is asynchronous (matchmaker, then connecting): wait until in a game
  for (let i = 0; i < 300; i++) {
    const playing = await b.page.evaluate(() => { const st = ctAgent.state(); return st.playing && !!st.me; }).catch(() => false);
    if (playing) break;
    await sleep(100);
  }
  // Pipelined: ask for the next decision while the current plan is still
  // running (timed so the answer lands as the plan ends), so there's no idle
  // gap while the policy thinks.  --no-pipeline restores think-then-act.
  const decideFresh = async () => {
    const st = await b.page.evaluate(() => ctAgent.state());
    if (!st.playing) return { st, d: null };
    const d = await b.policy.decide(st, b.history);
    return { st, d };
  };
  const lead = Math.max(0, args['lead-ms'] ?? 150);
  let next = decideFresh().catch(() => ({ st: null, d: null }));
  const say = (t) => args.chat && b.page.evaluate((x) => ctAgent.say(x), t).catch(() => {});
  if (args.chat) setTimeout(() => say(args.mode !== 'coop' ? `${b.name} here. En garde!` : `Hi! ${b.name} here, let's clean up this breakfast.`), 2500 + b.i * 1500);
  let lastPots = null, lastScore = 0;
  while (!b.done) {
    const { st, d } = await next;
    if (!st || !st.playing || !d) { b.done = true; break; }
    if (args.chat && st.me) {
      if (lastPots !== null && st.pots_left < lastPots) say(['Argh!', 'Ouch!', 'Not again...', 'I meant to do that.'][b.decisions % 4]);
      if (st.score - lastScore >= 2000 && args.mode !== 'coop') say('Gotcha!');
      lastPots = st.pots_left; lastScore = st.score;
    }
    b.decisions++;
    b.history.push({ st, action: d });
    if (b.history.length > 50) b.history.shift();
    let planDone;
    try {
      planDone = b.page.evaluate(([plan, label]) => { ctAgent.setLabel(label); return ctAgent.runPlan(plan); }, [d.plan, d.label]);
    } catch (e) { b.done = true; break; }
    if (args['no-pipeline']) {
      await planDone.catch(() => {});
      await b.page.evaluate(() => ctAgent.setControls({})).catch(() => {});
      next = decideFresh().catch(() => ({ st: null, d: null }));
    } else {
      await sleep(Math.max(0, d.plan.length * 50 - lead));
      next = decideFresh().catch(() => ({ st: null, d: null }));
      await planDone.catch(() => {});
    }
  }
}
const loops = bots.map(botLoop);

// gather recordings and events; keep frames from the current host
const lastTick = { v: -1 };
let debugUntil = 0;
const t0 = Date.now();
let frames = 0;
let auditTick = 0;
let deadline = t0 + args.seconds * 1000, lastStanding = false;
while (Date.now() < deadline && bots.some((b) => !b.done)) {
  await sleep(1000);
  if (args.online && ++auditTick % 2 === 0) await audit(bots, Math.round((Date.now() - t0) / 1000));
  for (const b of bots) {
    let rec = [], ev = [];
    try {
      [rec, ev] = await b.page.evaluate(() => {
        const on = ctAgent.online();
        return [ctAgent.drainRecording(), [...ctAgent.drainEvents(), ...on.log, ...(on.status ? ['status: ' + on.status] : [])]];
      });
    } catch (e) { continue; }
    ev = ev.filter((m) => { if (!m.startsWith('status: ')) return true; if (b.lastStatus === m) return false; b.lastStatus = m; return true; });
    for (const m of ev) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s ${b.name}: ${m}`);
    if (ev.some((m) => m.includes('took over'))) debugUntil = Date.now() + 8000;
    if (args.debug && Date.now() < debugUntil) {
      const d = await b.page.evaluate(() => ({ dbg: window.__mpDbg && window.__mpDbg(), clock: window.ct && window.ct.gameClock,
        players: window.ct && window.ct.players.length, remote: !!(window.ct && window.ct.remote), tickHook: !!(window.ct && window.ct.onTickDone),
        buffered: window.__mpDbg ? undefined : 0 })).catch((e) => ({ err: e.message }));
      console.log(`  DEBUG ${b.name}: ${JSON.stringify(d)}`);
    }
    for (const w of rec) {
      if (!w.host || w.t <= lastTick.v) continue;
      lastTick.v = w.t;
      gz.write(JSON.stringify(w) + '\n');
      frames++;
      // last one standing: a little more, then stop
      if (args['last-standing'] > 0 && frames > 100 && (w.ships || []).length <= 1 && !lastStanding) {
        lastStanding = true;
        deadline = Math.min(deadline, Date.now() + args['last-standing'] * 1000);
        console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s one player left: stopping in ${args['last-standing']} s`);
      }
    }
  }
}
for (const b of bots) b.done = true;
await Promise.allSettled(loops);
const final = [];
for (const b of bots) {
  try { const st = await b.page.evaluate(() => ctAgent.state()); final.push({ name: b.name, score: st.score, pots: st.pots_left, playing: st.playing, decisions: b.decisions, jevCalls: b.policy.calls || 0 }); }
  catch (e) { final.push({ name: b.name, error: e.message }); }
}
gz.end();
await new Promise((r) => out.on('finish', r));
for (const b of bots) await b.page.evaluate(() => ctAgent.leaveOnline && ctAgent.leaveOnline()).catch(() => {});
await browser.close();
console.log(JSON.stringify({ mode: args.mode, seconds: Math.round((Date.now() - t0) / 1000), frames, log: logPath, final }, null, 1));
if (args.online) {
  const g = gapMaxes.filter((x) => x > 0).sort((a, b) => a - b);
  const pct = (q) => (g.length ? g[Math.min(g.length - 1, Math.floor(q * g.length))] : 0);
  console.log(`SNAPSHOT GAPS (worst gap per 2 s sample, ms): median ${pct(0.5)}, 95th ${pct(0.95)}, max ${g.length ? g[g.length - 1] : 0}`);
  console.log(issues.length ? 'CHECKS FAILED:\n  ' + issues.join('\n  ') : 'CHECKS OK: guests and hosts agreed on players, scores, pots and positions; no stalls, no page errors');
}
