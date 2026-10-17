#!/usr/bin/env node
// One bot in an online universe, with no browser (headless.mjs runs the game
// in this process).  filler.mjs starts one of these per fill-in bot; it also
// runs by hand for testing:
//
//   node bots/headless-bot.mjs --url https://ct.krazydad.com/ --name '🤖 Test' --mode coop
//        [--code DIR]      the game code to run (default: the site's own, copied by syncSiteCode)
//        [--policy heuristic|jev] [--alone 15] [--kick 5]
//        [--host-only]     testing: queue as a host and wait for a joiner, instead of
//                          joining only someone already waiting (fill-in bots)
//        [--person]        testing: not flagged as a bot (with --host-only, a stand-in
//                          for a person waiting: fill-in bots join it)
//        [--max-seconds N] testing: leave after N seconds
//
// Prints one line per event; exits when the game is over for this bot.
import os from 'os';
import path from 'path';
import { parseArgs, sleep } from './lib.mjs';
import { startHeadless, syncSiteCode } from './headless.mjs';
import { makeHeuristic } from './policies/heuristic.mjs';

const args = parseArgs(process.argv.slice(2), {
  url: 'https://ct.krazydad.com/', code: '', name: '🤖 Bot', mode: 'coop', policy: 'heuristic', alone: 15, kick: 5,
  'host-only': false, person: false, 'max-seconds': 0,
});
const URL_ = args.url.endsWith('/') ? args.url : args.url + '/';
const say = (m) => console.log(m);

// started by filler.mjs: go when it goes
if (process.send) process.on('disconnect', () => process.exit(0));

const code = args.code ? path.resolve(String(args.code)) : await syncSiteCode(URL_, path.join(os.homedir(), '.ct-bot-code'));
const { game, agent, stop } = await startHeadless({ url: URL_, code, log: (m) => say('game: ' + m) });

let quitting = false;
const leave = async (why) => {
  if (quitting) return;
  quitting = true;
  say(`leaving (${why})`);
  try { agent.leaveOnline(); } catch (e) { /* gone */ }
  await sleep(500);   // the matchmaker hears we've left
  stop();
  process.exit(0);
};
process.on('SIGTERM', () => leave('stopped'));
process.on('SIGINT', () => leave('stopped'));
process.on('unhandledRejection', (e) => say('unhandled: ' + (e && e.stack || e)));

async function policy() {
  if (args.policy === 'jev') return (await import('./policies/jev.mjs')).makeJev({});
  return makeHeuristic({});
}

// bots appear on the mode's Hall of Cheese like anyone else
async function postScore(st, seconds) {
  try {
    const res = await fetch(URL_ + 'api/scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.name, score: st.score, level: st.level || 0, seconds: Math.round(seconds), mode: args.mode }),
    });
    const r = await res.json();
    say(`posted ${st.score} to ${args.mode} (${r.ok ? (r.status === 'ok' ? 'rank ' + r.rank : r.status) : r.message || r.error})`);
  } catch (e) { say(`couldn't post score: ${e.message}`); }
}

agent.setKick(args.kick);
const hostOnly = !!args['host-only'];
agent.playOnline({ name: args.name, mode: args.mode, max: 4, joinOnly: !hostOnly, hostOnly, person: !!args.person });

// wait to be in a game (or to learn nobody's waiting any more)
let playing = false;
for (let i = 0; i < 200 && !playing; i++) {
  await sleep(100);
  const o = agent.online();
  if (o.noHost) { say(`nobody to join in ${args.mode}`); await leave('nobody waiting'); }
  playing = agent.state().playing && !!o.role && !o.connecting;
}
if (!playing) await leave(`couldn't join (${args.mode})`);
say(`${hostOnly ? 'hosting' : 'joined'} a ${args.mode} game`);

const started = Date.now();
const pol = await policy();
const history = [];
let last = null, aloneSince = 0, decisions = 0, hadCompany = !hostOnly, lastReport = Date.now();
while (!quitting) {
  const st = agent.state();
  if (st.me) last = st;
  if (!st.playing) { say(`game over (score ${st.score ?? '?'}, ${decisions} decisions)`); break; }
  if (args['max-seconds'] && Date.now() - started > args['max-seconds'] * 1000) { say('time is up'); break; }
  const o = agent.online();
  for (const l of o.log) say('mp: ' + l);
  if (Date.now() - lastReport > 60000) {
    lastReport = Date.now();
    const mem = process.memoryUsage().rss / 1e6, cpu = process.cpuUsage();
    say(`${o.role}, ${o.players} players (${o.humans} people), score ${st.score}, level ${st.level}, pots ${st.pots_left}; ` +
      `${Math.round(mem)} MB, cpu ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s`);
  }
  if (o.humans > 0) { aloneSince = 0; hadCompany = true; }
  else if (!hadCompany) { /* a test host waiting for company */ }
  else if (!aloneSince) aloneSince = Date.now();
  else if (Date.now() - aloneSince > args.alone * 1000) {
    say(`no people left, leaving; role ${o.role}, players ${o.players}; saw ${JSON.stringify(agent.audit()).slice(0, 1500)}`);
    break;
  }
  const d = await pol.decide(st, history);
  if (!d) break;
  history.push({ st, action: d });
  if (history.length > 20) history.shift();
  decisions++;
  agent.setLabel(d.label);
  await agent.runPlan(d.plan);
}
if (last && last.score > 0 && !hostOnly) await postScore(last, (Date.now() - started) / 1000);
await leave('done');
