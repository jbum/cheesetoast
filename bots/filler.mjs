#!/usr/bin/env node
// Fill-in bot daemon: watches the live site's matchmaker and, when a person
// has waited --wait seconds for company, sends a bot into their universe.
// Bots are named after hurricanes with a robot prefix ("🤖 Arlene"), wear the
// blinking LED, never wait in the queue themselves (joinOnly), and leave once
// no people are left in their universe.  Runs on a spare machine (see MULTIPLAYER.md).
//
//   node bots/filler.mjs [--url https://ct.krazydad.com/] [--wait 30] [--max-bots 3]
//        [--policy heuristic|jev] [--poll 5] [--alone 15] [--once]
import { loadPlaywright, parseArgs, chromiumLaunchOptions, sleep } from './lib.mjs';
import { makeHeuristic } from './policies/heuristic.mjs';

const args = parseArgs(process.argv.slice(2), {
  url: 'https://ct.krazydad.com/', wait: 30, 'max-bots': 3, policy: 'heuristic', poll: 5, alone: 15, once: false,
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
const { chromium } = loadPlaywright();
let browser = null;
const bots = new Set();
const recentByMode = new Map();   // mode -> time of the last bot sent (one at a time per mode)

async function policy() {
  if (args.policy === 'jev') return (await import('./policies/jev.mjs')).makeJev({});
  return makeHeuristic({});
}

function pickName() {
  const used = new Set([...bots].map((b) => b.name));
  const free = HURRICANES.filter((n) => !used.has('🤖 ' + n));
  return '🤖 ' + free[Math.floor(Math.random() * free.length)];
}

async function runBot(mode) {
  const bot = { name: pickName(), mode };
  bots.add(bot);
  recentByMode.set(mode, Date.now());
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => log(`${bot.name}: page error: ${e.message}`));
    await page.goto(URL + '?agent');
    await page.waitForFunction(() => window.ctAgent && document.getElementById('start').classList.contains('ready'), null, { timeout: 60000 });
    await page.evaluate((o) => { ctAgent.setDraw(false); ctAgent.setKick(5); return ctAgent.playOnline({ name: o.name, mode: o.mode, max: 4, joinOnly: true }); }, bot);
    // wait to be in a game (or to learn nobody's waiting any more)
    let playing = false;
    for (let i = 0; i < 200 && !playing; i++) {
      await sleep(100);
      const o = await page.evaluate(() => ({ ...ctAgent.online(), playing: ctAgent.state().playing }));
      if (o.noHost) { log(`${bot.name}: nobody to join in ${mode}`); return; }
      playing = o.playing && !!o.role;
    }
    if (!playing) { log(`${bot.name}: couldn't join (${mode})`); return; }
    log(`${bot.name}: joined a ${mode} game`);
    const started = Date.now();
    let last = null;
    const pol = await policy();
    const history = [];
    let aloneSince = 0, decisions = 0;
    while (true) {
      const st = await page.evaluate(() => ctAgent.state());
      if (st.me) last = st;
      if (!st.playing) { log(`${bot.name}: game over (score ${st.score ?? '?'}, ${decisions} decisions)`); break; }
      const o = await page.evaluate(() => ctAgent.online());
      if (o.humans > 0) aloneSince = 0;
      else if (!aloneSince) aloneSince = Date.now();
      else if (Date.now() - aloneSince > args.alone * 1000) {
        const seen = await page.evaluate(() => { const s = window.__mpDbg ? window.__mpDbg() : null; return { s, a: ctAgent.audit ? ctAgent.audit() : null }; }).catch((e) => String(e));
        log(`${bot.name}: no people left, leaving; role ${o.role}, players ${o.players}; saw ${JSON.stringify(seen).slice(0, 1500)}`);
        break;
      }
      const d = await pol.decide(st, history);
      if (!d) break;
      history.push({ st, action: d });
      if (history.length > 20) history.shift();
      decisions++;
      await page.evaluate(([plan, label]) => { ctAgent.setLabel(label); return ctAgent.runPlan(plan); }, [d.plan, d.label]);
    }
    await page.evaluate(() => ctAgent.leaveOnline()).catch(() => {});
    if (last && last.score > 0) await postScore(bot, last, (Date.now() - started) / 1000);
  } catch (e) {
    log(`${bot.name}: ${e.message.split('\n')[0]}`);
  } finally {
    bots.delete(bot);
    await context.close().catch(() => {});
  }
}

// bots appear on the mode's Hall of Cheese like anyone else
async function postScore(bot, st, seconds) {
  try {
    const res = await fetch(URL + 'api/scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bot.name, score: st.score, level: st.level || 0, seconds: Math.round(seconds), mode: bot.mode }),
    });
    const r = await res.json();
    log(`${bot.name}: posted ${st.score} to ${bot.mode} (${r.ok ? (r.status === 'ok' ? 'rank ' + r.rank : r.status) : r.message || r.error})`);
  } catch (e) { log(`${bot.name}: couldn't post score: ${e.message}`); }
}

async function status() {
  const res = await fetch(URL + 'mm/status', { cache: 'no-store' });
  return res.json();
}

log(`filler: watching ${URL} (wait ${args.wait}s, up to ${args['max-bots']} bots, ${args.policy} policy)`);
browser = await chromium.launch(chromiumLaunchOptions());
const stop = async () => { log('stopping'); await browser.close().catch(() => {}); process.exit(0); };
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
    if (!browser.isConnected()) { log('browser closed; restarting it'); browser = await chromium.launch(chromiumLaunchOptions()); }
  } catch (e) {
    const m = e.message.split('\n')[0];
    if (m !== lastErr) log(`status: ${m}`);
    lastErr = m;
  }
  if (args.once && sentAny && bots.size === 0) break;   // testing: one round, then exit
  await sleep(args.poll * 1000);
}
log("done");
await browser.close();
