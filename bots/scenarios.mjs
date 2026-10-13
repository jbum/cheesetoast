#!/usr/bin/env node
// Multiplayer flow checks with free (non-Jev) bots.
//
//   node bots/scenarios.mjs --local [--only name]          # private copy of the site (bots/localsite.mjs)
//   node bots/scenarios.mjs [--url https://ct.krazydad.com/]  # the live site (real players may join in)
//
// Each scenario drives real browsers through the matchmaker and WebRTC and
// checks what the players end up doing.  Prints PASS/FAIL per scenario.
import { loadPlaywright, parseArgs, chromiumLaunchOptions, sleep } from './lib.mjs';
import { startLocalSite } from './localsite.mjs';
import { makeHeuristic } from './policies/heuristic.mjs';
import { makeKamikaze } from './policies/kamikaze.mjs';

const args = parseArgs(process.argv.slice(2), { url: 'https://ct.krazydad.com/', only: '', local: false, verbose: false });   // --verbose: every bot's notes
const site = args.local ? await startLocalSite() : null;
if (site) args.url = site.url;
const { chromium } = loadPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's';

class Bot {
  constructor(name, policy) { this.name = name; this.policy = policy; this.events = []; this.running = false; }
  async open(mode, query = '') {
    this.ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', (e) => this.events.push('PAGE ERROR ' + e.message));
    await this.page.goto(args.url + '?agent&debug' + query);
    await this.page.waitForFunction(() => window.ctAgent && document.getElementById('start').classList.contains('ready'), null, { timeout: 60000 });
    this.mode = mode;
  }
  async play() {
    await this.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m }), [this.name, this.mode]);
    for (let i = 0; i < 150; i++) { if ((await this.info()).playing) break; await sleep(100); }
    this.loop();
  }
  async info() {
    return this.page.evaluate(() => {
      const st = ctAgent.state();
      const on = ctAgent.online();
      return { playing: st.playing, score: st.score, pots: st.pots_left, role: on.role, players: on.players, status: on.status,
        log: on.log, state: window.ct.state };
    }).catch((e) => ({ error: e.message }));
  }
  async loop() {
    this.running = true;
    while (this.running) {
      const st = await this.page.evaluate(() => ctAgent.state()).catch(() => null);
      if (!st || !st.playing) { await sleep(200); continue; }
      const d = await this.policy.decide(st, []);
      await this.page.evaluate((p) => ctAgent.runPlan(p), d.plan).catch(() => {});
    }
  }
  async poll() {
    const i = await this.info();
    for (const m of i.log || []) this.events.push(m);
    return i;
  }
  async close() { this.running = false; await this.page.evaluate(() => ctAgent.leaveOnline()).catch(() => {}); await this.ctx.close().catch(() => {}); }
  async crash() { this.running = false; await this.ctx.close().catch(() => {}); }   // no goodbye: like a closed laptop
}

async function waitFor(desc, fn, seconds) {
  for (let i = 0; i < seconds * 5; i++) { if (await fn()) return true; await sleep(200); }
  console.log(`${stamp()}   timed out waiting for: ${desc}`);
  return false;
}

const results = [];
async function scenario(name, fn) {
  if (args.only && args.only !== name) return;
  console.log(`${stamp()} --- ${name}`);
  let ok = false, bots = [];
  try { ok = await fn((b) => { bots.push(b); return b; }); }
  catch (e) { console.log(`${stamp()}   error: ${e.message}`); }
  for (const b of bots) {
    await b.poll().catch(() => {});
    for (const e of b.events) if (args.verbose || /ERROR|error/.test(e)) console.log(`${stamp()}   ${b.name}: ${e}`);
    await b.close();
  }
  if (!ok && site) for (const l of site.log.splice(0).filter((l) => !/ diag /.test(l)).slice(-14)) console.log(`${stamp()}   mm: ${l.slice(20)}`);
  else if (site) site.log.length = 0;
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${name}`);
  results.push([name, ok]);
}

const mode = 'coop';

await scenario('guest-loses', async (use) => {
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Loser', makeKamikaze())), third = use(new Bot('Third', makeHeuristic()));
  await host.open(mode); await guest.open(mode); await third.open(mode);
  await host.play(); await sleep(2500);
  await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  console.log(`${stamp()}   guest joined; waiting for the kamikaze to run out of pots`);
  if (!await waitFor('guest out of pots', async () => (await guest.poll()).state !== 1, 150)) return false;
  const g = await guest.poll();
  console.log(`${stamp()}   guest state ${g.state} (2 = game over), role ${g.role}`);
  const h = await host.poll();
  console.log(`${stamp()}   host still playing: ${h.playing}, players ${h.players}, status "${h.status}"`);
  if (!h.playing || h.players !== 1) return false;
  await sleep(1500);
  await third.play();
  const joined = await waitFor('third player joins the host', async () => (await host.poll()).players === 2 && (await third.poll()).role === 'guest', 20);
  console.log(`${stamp()}   third player ${joined ? 'joined the host' : 'did not join'}`);
  return joined;
});

await scenario('host-vanishes', async (use) => {
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic())), next = use(new Bot('Next', makeHeuristic()));
  await host.open(mode); await guest.open(mode); await next.open(mode);
  await host.play(); await sleep(2500); await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  await sleep(3000);
  const before = await guest.poll();
  console.log(`${stamp()}   closing the host's browser without a goodbye (guest score ${before.score}, pots ${before.pots})`);
  await host.crash();
  const carried = await waitFor('guest carries on as host', async () => { const g = await guest.poll(); return g.role === 'host' && g.playing; }, 15);
  const g = await guest.poll();
  console.log(`${stamp()}   guest role ${g.role}, playing ${g.playing}, score ${g.score}, pots ${g.pots}`);
  if (!carried) return false;
  // (closing the context fires pagehide, so this goes through the host's step-down)
  const prog = await guest.page.evaluate(() => ({ board: window.ct.scoreMode, secs: Math.round(window.ct.time - (window.ct.gameStartTime || window.ct.time)) }));
  console.log(`${stamp()}   carried on: board "${prog.board}", play clock ${prog.secs} s`);
  await sleep(1500); await next.play();
  const joined = await waitFor('next player joins the former guest', async () => (await guest.poll()).players === 2, 20);
  console.log(`${stamp()}   next player ${joined ? 'joined' : 'did not join'} the former guest`);
  return joined;
});

await scenario('host-freezes', async (use) => {
  // The host stops sending without any goodbye (a frozen or suspended page):
  // the guest carries on alone with its score, pots, level and play clock, and
  // the game still counts toward this mode's board.
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic()));
  await host.open(mode); await guest.open(mode);
  await host.play(); await sleep(2500); await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  await sleep(6000);
  const before = await guest.page.evaluate(() => ({ score: window.ct.local.gameScore, pots: window.ct.local.remainingShips, level: window.ct.gameLevel,
    secs: Math.round(window.ct.time - (window.ct.gameStartTime || window.ct.time)) }));
  console.log(`${stamp()}   host freezes (guest: score ${before.score}, pots ${before.pots}, level ${before.level}, play clock ${before.secs} s)`);
  await host.page.evaluate(() => { window.ct.onTickDone = null; });   // no more snapshots
  const carried = await waitFor('guest carries on as host', async () => { const g = await guest.poll(); return g.role === 'host' && g.playing; }, 15);
  if (!carried) return false;
  await sleep(1000);
  const after = await guest.page.evaluate(() => ({ score: window.ct.local.gameScore, pots: window.ct.local.remainingShips, level: window.ct.gameLevel,
    secs: Math.round(window.ct.time - (window.ct.gameStartTime || window.ct.time)), board: window.ct.scoreMode }));
  console.log(`${stamp()}   carried on: score ${after.score}, pots ${after.pots}, level ${after.level}, play clock ${after.secs} s, board "${after.board}"`);
  return after.score >= before.score && after.pots === before.pots && after.level === before.level && after.secs >= before.secs + 4 && after.board === mode;
});

await scenario('guest-vanishes', async (use) => {
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic())), next = use(new Bot('Next', makeHeuristic()));
  await host.open(mode); await guest.open(mode); await next.open(mode);
  await host.play(); await sleep(2500); await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  await sleep(2000);
  console.log(`${stamp()}   closing the guest's browser without a goodbye`);
  await guest.crash();
  const dropped = await waitFor('host drops the guest', async () => (await host.poll()).players === 1, 15);
  console.log(`${stamp()}   host ${dropped ? 'dropped the guest' : 'still has 2 players'}`);
  if (!dropped) return false;
  await sleep(1500); await next.play();
  return waitFor('next player joins the host', async () => (await host.poll()).players === 2, 20);
});

await scenario('host-hands-off-4', async (use) => {
  const bots = ['Host', 'G1', 'G2', 'G3'].map((n) => use(new Bot(n, makeHeuristic())));
  for (const b of bots) await b.open(mode);
  for (const b of bots) await b.page.evaluate(() => 1);
  // everyone open to 4 players
  for (const b of bots) b.max = 4;
  const playMax = async (b) => {
    await b.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, max: 4 }), [b.name, b.mode]);
    for (let i = 0; i < 150; i++) { if ((await b.info()).playing) break; await sleep(100); }
    b.loop();
  };
  await playMax(bots[0]); await sleep(2500);
  for (const b of bots.slice(1)) { await playMax(b); await sleep(1500); }
  if (!await waitFor('all four in one universe', async () => (await bots[0].poll()).players === 4, 30)) return false;
  console.log(`${stamp()}   four players together; the host forfeits`);
  await bots[0].page.evaluate(() => ctAgent.forfeit());
  await sleep(10000);
  const infos = await Promise.all(bots.slice(1).map((b) => b.poll()));
  const hosts = infos.filter((i) => i.role === 'host');
  console.log(`${stamp()}   after 10 s: ${infos.map((i, k) => `${bots[k + 1].name}=${i.role}/${i.players}p/${i.playing ? 'playing' : 'not playing'}`).join(', ')}`);
  return hosts.length === 1 && hosts[0].players === 3 && infos.every((i) => i.playing);
});

await scenario('chat', async (use) => {
  // (both named Ann: the host makes the guest "Ann 2", and its chat must say so too)
  const a = use(new Bot('Ann', makeHeuristic())), b = use(new Bot('Ann', makeHeuristic()));
  await a.open(mode); await b.open(mode);
  await a.play(); await sleep(2500); await b.play();
  if (!await waitFor('joined', async () => (await a.poll()).players === 2, 15)) return false;
  await a.page.evaluate(() => { window.__heard = []; const m = window.__mpDbg; return true; });
  const sent1 = await a.page.evaluate(() => ctAgent.say('Hello from the host!'));
  const sent2 = await b.page.evaluate(() => ctAgent.say('Hi back from the guest'));
  // (one the local word list catches too: the local site has no Jev check)
  const rude = await b.page.evaluate(() => ctAgent.say('kys lol'));
  await sleep(1500);
  const logs = await Promise.all([a, b].map((x) => x.page.evaluate(() => {
    const c = window.__chatLog ? window.__chatLog() : null;
    return c;
  })));
  console.log(`${stamp()}   sent: host ${sent1}, guest ${sent2}, rude message sent: ${rude}`);
  console.log(`${stamp()}   host heard: ${JSON.stringify(logs[0])}`);
  console.log(`${stamp()}   guest heard: ${JSON.stringify(logs[1])}`);
  const hostHeardGuest = (logs[0] || []).some((l) => l.startsWith('Ann 2: Hi back'));
  const guestHeardHost = (logs[1] || []).some((l) => l.includes('Hello from the host'));
  const rudeBlocked = rude === false && !(logs[0] || []).some((l) => l.includes('kys'));
  return hostHeardGuest && guestHeardHost && rudeBlocked;
});

await scenario('guest-dropped', async (use) => {
  // A guest that goes quiet for 4 s (a tab in the background long enough for the
  // browser to throttle it, a closed laptop lid) is dropped by the host.  When it
  // comes back it must get its place and score back, not be left watching a
  // universe it is no longer in.
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic()));
  await host.open(mode); await guest.open(mode);
  await host.play(); await sleep(2500); await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  await sleep(4000);
  const before = await guest.poll();
  // hide the tab: like a throttled page, it stops sending inputs (snapshots keep arriving)
  await guest.page.evaluate(() => {
    window.__hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.ct.remote.sendInput = () => {};   // (silent: its inputs no longer go out)
  });
  // (its teapot sits still meanwhile and may be hit: what counts is the host's
  // record of it just before the drop)
  let lastRec = null;
  const dropped = await waitFor('host drops the quiet guest', async () => {
    const a = await host.page.evaluate(() => ctAgent.audit());
    const r = (a.players || []).find((p) => p.name === 'Guest');
    if (r) lastRec = r;
    return a.players && a.players.length === 1;
  }, 10);
  if (lastRec) { before.score = lastRec.score; before.pots = lastRec.pots; }
  console.log(`${stamp()}   host ${dropped ? 'dropped' : 'kept'} the guest after its silence (score then ${before.score}, pots ${before.pots})`);
  if (!dropped) return false;
  // the tab comes back
  await guest.page.evaluate(() => {
    window.__hidden = false;
    const s = window.ct.remote; if (s) delete s.sendInput;
  });
  const back = await waitFor('guest back in the universe', async () => {
    const h = await host.poll();
    const g = await guest.page.evaluate(() => { const s = window.ct.remote; return !!(s && s.snap && s.snap.players.some((p) => p[0] === s.id)); }).catch(() => false);
    return h.players === 2 && g;
  }, 8);
  const h = await host.page.evaluate(() => ctAgent.audit());
  const rec = (h.players || []).find((p) => p.name === 'Guest');
  console.log(`${stamp()}   guest ${back ? 'is back in play' : 'is a ghost: sees the universe, has no teapot, never ends'}; host's record: ${rec ? `score ${rec.score}, pots ${rec.pots}` : 'none'}`);
  return back && !!rec && rec.score >= before.score && rec.pots === before.pots;
});

await scenario('join-never-arrives', async (use) => {
  // The matchmaker takes a host out of the queue the moment it sends a joiner.
  // If that joiner never connects (its network can't, or it closed the tab),
  // the host must not be left out of the queue saying "X is joining..." forever.
  const host = use(new Bot('Host', makeHeuristic())), next = use(new Bot('Next', makeHeuristic()));
  await host.open(mode); await next.open(mode);
  await host.play(); await sleep(2500);
  // a dud: asks to play, gets paired with the host, then does nothing
  const r = await next.page.evaluate(async (m) => (await (await fetch('mm/play', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Dud', mode: m, bot: true }) })).json()), mode);
  console.log(`${stamp()}   dud paired as ${r.role}`);
  if (r.role !== 'guest') return false;
  await sleep(1500);
  console.log(`${stamp()}   host status: "${(await host.poll()).status}"`);
  const requeued = await waitFor('host gives up on the dud', async () => !/joining/.test((await host.poll()).status), 25);
  console.log(`${stamp()}   host status after: "${(await host.poll()).status}"`);
  await next.play();
  const joined = await waitFor('next player joins the host', async () => (await host.poll()).players === 2 && (await next.poll()).role === 'guest', 15);
  console.log(`${stamp()}   next player ${joined ? 'joined the host' : 'did not join: the host was out of the queue'}`);
  return requeued && joined;
});

await scenario('paused-host', async (use) => {
  // A solo host that pauses (or hides its tab) must leave the queue: a joiner
  // would be welcomed into a universe that isn't running, then lose contact.
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic())), third = use(new Bot('Third', makeHeuristic()));
  await host.open(mode); await guest.open(mode); await third.open(mode);
  await host.play(); await sleep(2500);
  await host.page.evaluate(() => window.ct.pause());
  await sleep(1500);
  await guest.play();
  await sleep(5000);
  const g = await guest.poll();
  const wasLetIn = guest.events.some((e) => /joined .* universe/.test(e));
  console.log(`${stamp()}   joiner while the host was paused: ${wasLetIn ? 'was let into the paused universe' : 'was not paired with it'}; now role ${g.role}, playing ${g.playing}`);
  await guest.page.evaluate(() => ctAgent.leaveOnline());
  await sleep(500);
  await host.page.evaluate(() => window.ct.resume());
  await sleep(1500);
  await third.play();
  const joined = await waitFor('a joiner after the host resumed', async () => (await host.poll()).players === 2 && (await third.poll()).role === 'guest', 15);
  console.log(`${stamp()}   after resuming, the next player ${joined ? 'joined the host' : 'did not join'}`);
  return !wasLetIn && joined;
});

await scenario('guest-seconds', async (use) => {
  // A guest never runs beginGame, so its play clock must start when it joins,
  // or the score server sees 0 s and refuses anything over 5000 as implausible.
  // An heir must keep its own clock: the old host's is another page's time.
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic()));
  await host.open(mode); await host.play();
  await sleep(8000);   // the host's page is older than the guest's
  await guest.open(mode); await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  await sleep(3000);
  const secs = (b) => b.page.evaluate(() => Math.round(window.ct.time - (window.ct.gameStartTime || window.ct.time)));
  const a = await secs(guest);
  console.log(`${stamp()}   guest's play clock after 3 s in the universe: ${a} s`);
  await host.page.evaluate(() => ctAgent.forfeit());
  if (!await waitFor('guest takes over', async () => (await guest.poll()).role === 'host', 10)) return false;
  await sleep(2000);
  const b = await secs(guest);
  console.log(`${stamp()}   heir's play clock 2 s after taking over: ${b} s${b < 0 ? ' (the old host\'s clock)' : ''}`);
  return a >= 2 && b >= a;
});

// a host whose connection setup never reaches anyone (its network can't; here
// its signaling is cut), still alive and queued
async function unreachableHost(use) {
  const a = use(new Bot('Unreachable', makeHeuristic()));
  await a.open(mode);
  await a.ctx.route('**/mm/signal', (r) => r.abort());
  await a.play();
  return a;
}

await scenario('join-unreachable', async (use) => {
  // The first host the matchmaker picks can't be reached (no TURN relay yet):
  // the joiner's retry must avoid it and find the other host waiting, instead
  // of being sent back to the same one and ending up in a plain solo game.
  await unreachableHost(use);
  await sleep(1500);
  const b = use(new Bot('Reachable', makeHeuristic())), c = use(new Bot('Joiner', makeHeuristic()));
  await b.open(mode); await c.open(mode);
  // (a second host, queued behind the unreachable one)
  await b.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, hostOnly: true }), [b.name, b.mode]);
  await sleep(1500); b.loop();
  const t1 = Date.now();
  await c.play();
  const joined = await waitFor('joiner ends up with the reachable host', async () => (await b.poll()).players === 2 && (await c.poll()).role === 'guest', 25);
  const ci = await c.poll();
  console.log(`${stamp()}   joiner: role ${ci.role}, status "${ci.status}", after ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  return joined;
});

await scenario('join-bail', async (use) => {
  // While connecting, any key or tap gives up on that host and starts a solo
  // universe of our own, open to joiners.
  await unreachableHost(use);
  await sleep(1500);
  const c = use(new Bot('Impatient', makeHeuristic())), d = use(new Bot('Later', makeHeuristic()));
  await c.open(mode); await d.open(mode);
  await c.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m }), [c.name, c.mode]);
  await sleep(2000);
  const before = await c.page.evaluate(() => ctAgent.online());
  console.log(`${stamp()}   while connecting: "${before.status}"`);
  const t1 = Date.now();
  await c.page.evaluate(() => ctAgent.bailJoin());
  const solo = await waitFor('impatient player hosts its own universe', async () => { const i = await c.poll(); return i.role === 'host' && i.playing; }, 10);
  console.log(`${stamp()}   ${((Date.now() - t1) / 1000).toFixed(1)} s after the key: role ${(await c.poll()).role}, "${(await c.poll()).status}"`);
  if (!solo) return false;
  c.loop();
  await d.play();
  const joined = await waitFor('a later player joins it', async () => (await c.poll()).players === 2 && (await d.poll()).role === 'guest', 20);
  return joined;
});

await scenario('heir-is-alive', async (use) => {
  // The host hands the universe to a guest it has heard from lately, not to
  // the first joiner if that one has gone quiet (it would be dropped moments
  // later and everyone else would wait 10 s for a host that never comes).
  const bots = ['Host', 'G1', 'G2', 'G3'].map((n) => use(new Bot(n, makeHeuristic())));
  for (const b of bots) await b.open(mode);
  const playMax = async (b) => {
    await b.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, max: 4 }), [b.name, b.mode]);
    for (let i = 0; i < 150; i++) { if ((await b.info()).playing) break; await sleep(100); }
    b.loop();
  };
  await playMax(bots[0]); await sleep(2500);
  for (const b of bots.slice(1)) { await playMax(b); await sleep(1500); }
  if (!await waitFor('all four in one universe', async () => (await bots[0].poll()).players === 4, 30)) return false;
  // the first joiner goes quiet
  await bots[1].page.evaluate(() => { window.ct.remote.sendInput = () => {}; });   // (silent: its inputs no longer go out)
  await sleep(2500);
  console.log(`${stamp()}   G1 has been silent 2.5 s; the host forfeits`);
  await bots[0].page.evaluate(() => ctAgent.forfeit());
  await sleep(8000);
  const infos = await Promise.all(bots.slice(1).map((b) => b.poll()));
  console.log(`${stamp()}   after 8 s: ${infos.map((i, k) => `${bots[k + 1].name}=${i.role}/${i.players}p`).join(', ')}`);
  const hosts = infos.map((i, k) => [bots[k + 1].name, i]).filter(([, i]) => i.role === 'host');
  return hosts.length === 1 && hosts[0][0] !== 'G1' && hosts[0][1].players >= 2;
});

// one player's teapot as the host sees it
const hostRec = (page, name) => page.evaluate((n) => {
  const p = window.ct.players.find((q) => q.name === n);
  if (!p) return null;
  const sp = p.ship, alive = !!(sp && sp.active && sp.type === 1);
  return { alive, away: !!p.away, x: alive ? Math.round(sp.x) : null, y: alive ? Math.round(sp.y) : null, pots: p.remainingShips, out: !!p.out };
}, name);
// drop asteroids right on a player's teapot (host page)
const pelt = (page, name, n) => page.evaluate(([nm, k]) => {
  const g = window.ct, p = g.players.find((q) => q.name === nm);
  for (let i = 0; i < k; i++) { const a = g.newSprite(10, p.ship.x + (i % 3) * 8, p.ship.y); if (a) { a.vx = 0; a.vy = 0; } }
}, [name, n]);

await scenario('guest-away', async (use) => {
  // A guest whose page is hidden (another app, another tab) can't steer: its
  // teapot freezes in place, and in co-op nothing can hurt it (asteroids pass
  // through); it moves again when the page comes back.
  const host = use(new Bot('Host', makeHeuristic())), guest = use(new Bot('Guest', makeHeuristic()));
  await host.open(mode); await guest.open(mode);
  await host.play(); await sleep(2500); await guest.play();
  if (!await waitFor('guest joined', async () => (await host.poll()).players === 2, 15)) return false;
  await host.page.waitForFunction(() => { const p = window.ct.players.find((q) => q.name === 'Guest'); return p && p.ship && p.ship.type === 1; }, null, { timeout: 10000 });
  await sleep(1000);
  await guest.page.evaluate(() => {
    window.__hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor('frozen', async () => (await hostRec(host.page, 'Guest')).away, 5);
  const a = await hostRec(host.page, 'Guest');
  await pelt(host.page, 'Guest', 6);   // asteroids right on top of it
  await sleep(4000);
  const b = await hostRec(host.page, 'Guest');
  console.log(`${stamp()}   hidden: frozen ${a.away} at (${a.x},${a.y}) pots ${a.pots}; 4 s and 6 asteroids later at (${b.x},${b.y}) pots ${b.pots}, alive ${b.alive}`);
  await guest.page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await guest.page.evaluate(() => window.ct.resume());   // (its pause overlay: Resume)
  const back = await waitFor('moving again', async () => !(await hostRec(host.page, 'Guest')).away, 5);
  console.log(`${stamp()}   visible again and resumed: ${back ? 'unfrozen' : 'STILL FROZEN'}`);
  return a.away && b.alive && b.x === a.x && b.y === a.y && b.pots === a.pots && back;
});

await scenario('regroup', async (use) => {
  // The host of three vanishes: its two guests must end up together again (one
  // hosting, the other its guest), each with the score it had, instead of two
  // separate solo universes waiting for strangers.
  const host = use(new Bot('Host', makeHeuristic())), g1 = use(new Bot('G1', makeHeuristic())), g2 = use(new Bot('G2', makeHeuristic()));
  for (const b of [host, g1, g2]) await b.open(mode);
  const playMax = async (b) => {
    await b.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, max: 4 }), [b.name, b.mode]);
    for (let i = 0; i < 150; i++) { if ((await b.info()).playing) break; await sleep(100); }
    b.loop();
  };
  await playMax(host); await sleep(2500); await playMax(g1); await sleep(1500); await playMax(g2);
  if (!await waitFor('three in one universe', async () => (await host.poll()).players === 3, 20)) return false;
  await sleep(8000);
  const before = await Promise.all([g1, g2].map((b) => b.poll()));
  console.log(`${stamp()}   host freezes (G1 score ${before[0].score}, pots ${before[0].pots}; G2 score ${before[1].score}, pots ${before[1].pots})`);
  await host.page.evaluate(() => { window.ct.onTickDone = null; });
  const together = await waitFor('the two guests back in one universe', async () => {
    const [a, b] = await Promise.all([g1, g2].map((x) => x.poll()));
    return (a.role === 'host' && a.players === 2 && b.role === 'guest') || (b.role === 'host' && b.players === 2 && a.role === 'guest');
  }, 25);
  await sleep(1500);
  const after = await Promise.all([g1, g2].map((b) => b.poll()));
  console.log(`${stamp()}   ${together ? 'together again' : 'apart'}: G1 ${after[0].role}/${after[0].players}p score ${after[0].score} pots ${after[0].pots}; G2 ${after[1].role}/${after[1].players}p score ${after[1].score} pots ${after[1].pots}`);
  return together && after[0].score >= before[0].score && after[1].score >= before[1].score && after[0].pots === before[0].pots && after[1].pots === before[1].pots;
});

await scenario('low-level-first', async (use) => {
  // Newcomers go to the lowest-level universe waiting (the level follows the
  // best score, so a long-running winner's universe is hard for someone at 0),
  // and a universe at level 2 takes no newcomers at all.
  const a = use(new Bot('Older', makeHeuristic())), b = use(new Bot('Newer', makeHeuristic()));
  const c = use(new Bot('First', makeHeuristic())), d = use(new Bot('Second', makeHeuristic()));
  for (const x of [a, b, c, d]) await x.open(mode);
  const hostAt = async (x, level) => {
    await x.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, hostOnly: true }), [x.name, x.mode]);
    await sleep(1500); x.loop();
    await x.page.evaluate((l) => { window.ct.gameLevel = l; window.ct.onLevel && window.ct.onLevel(l); }, level);
  };
  await hostAt(a, 1); await hostAt(b, 0);   // the older universe is at level 1, the newer at 0
  await sleep(1000);
  await c.play();
  const toNewer = await waitFor('first newcomer joins the level-0 universe', async () => (await b.poll()).players === 2, 15);
  console.log(`${stamp()}   first newcomer joined ${toNewer ? 'the newer, level-0 universe' : (await a.poll()).players === 2 ? 'the OLDER, level-1 universe' : 'nobody'}`);
  // the level-0 universe climbs to level 2: closed; the level-1 one is still open
  await b.page.evaluate(() => { window.ct.gameLevel = 2; window.ct.onLevel && window.ct.onLevel(2); });
  await sleep(1000);
  // a lone host that reaches level 2 says it's closed, not that it's waiting
  const lone = use(new Bot('Lone', makeHeuristic()));
  await lone.open(mode); await hostAt(lone, 2);
  await sleep(500);
  const loneStatus = (await lone.poll()).status;
  console.log(`${stamp()}   lone host at level 2: "${loneStatus}"`);
  await d.play();
  const toOlder = await waitFor('second newcomer joins the level-1 universe', async () => (await a.poll()).players === 2, 15);
  console.log(`${stamp()}   after the first universe reached level 2, the second newcomer joined ${toOlder ? 'the level-1 universe' : (await b.poll()).players === 3 ? 'the CLOSED level-2 universe' : 'nobody'}`);
  return toNewer && toOlder && /closed to newcomers/.test(loneStatus);
});

// ---- the games list, joining from it, "no bots", settings, Solo (2026-10-05)

const games = async () => (await (await fetch(args.url + 'mm/games', { cache: 'no-store' })).json()).games;
// a page driven like a person: the start screen, the top line, the gear
async function personPage(name, query = '', { agent = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((n) => { try { localStorage.setItem('cheesetoast.name', JSON.stringify(n)); } catch (e) { /* */ } }, name);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(args.url + (agent ? '?agent&debug' : '?debug') + query);
  await page.waitForFunction((ag) => (!ag || window.ctAgent) && document.getElementById('start').classList.contains('ready'), agent, { timeout: 60000 });
  return { ctx, page, errors, close: () => ctx.close().catch(() => {}) };
}
const role = (p) => p.page.evaluate(() => (window.__mpDbg ? window.__mpDbg().role : null)).catch(() => null);
// a guest for real: welcomed by its host (role says 'guest' as soon as a join starts)
const joined = (p) => p.page.evaluate(() => { const d = window.__mpDbg && window.__mpDbg(); return !!(d && d.role === 'guest' && d.welcomed); }).catch(() => false);

await scenario('games-list-join', async (use) => {
  // Two co-op games waiting; normal matching would pick the older one.  A
  // person picks the newer one on the games list and lands in it.
  const a = use(new Bot('Older', makeHeuristic())), b = use(new Bot('Newer', makeHeuristic()));
  await a.open(mode); await b.open(mode);
  for (const x of [a, b]) { await x.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, hostOnly: true }), [x.name, x.mode]); await sleep(1500); x.loop(); }
  await sleep(1000);
  let list = await games();
  console.log(`${stamp()}   games list: ${list.map((g) => `${g.mode} [${g.players.map((p) => p.name).join(', ')}] ${g.open ? 'open' : 'closed'}`).join('; ')}`);
  const newer = list.find((g) => g.players.some((p) => p.name === 'Newer'));
  if (!newer || !newer.open || list.length !== 2) return false;
  // the list page itself shows both, with Join links
  const viewer = await personPage('Viewer');
  await viewer.page.goto(args.url + 'games/');
  await viewer.page.waitForSelector('a.join', { timeout: 8000 });
  const links = await viewer.page.$$eval('a.join', (as) => as.map((x) => x.getAttribute('href')));
  console.log(`${stamp()}   games page: ${links.length} Join links`);
  const href = links.find((h) => h.includes(newer.id));
  await viewer.close();
  if (!href) return false;
  // a person follows the Join link to the newer game
  // (no start screen: ?join goes straight in; without ?agent, as a person's page)
  const p = await personPage('Picker', '&' + href.split('?')[1], { agent: false });
  const splash = await p.page.isVisible('#start');
  console.log(`${stamp()}   start screen after following Join: ${splash ? 'SHOWN' : 'skipped'}`);
  if (splash) return false;
  const joined = await waitFor('the picker joins the newer game', async () => (await b.poll()).players === 2 && (await role(p)) === 'guest', 25);
  const older = (await a.poll()).players;
  // (checked after the list below: when the picker's game ends, back to the games list)
  console.log(`${stamp()}   picker is ${await role(p)}; Newer has ${(await b.poll()).players} players, Older ${older}`);
  list = await games();
  console.log(`${stamp()}   games list after: ${list.map((g) => `[${g.players.map((q) => q.name).join(', ')}]`).join('; ')}`);
  if (p.errors.length) console.log(`${stamp()}   page errors: ${p.errors.join(' | ')}`);
  // the picker's game ends: after the spin-out it goes back to the games list
  await p.page.evaluate(() => { window.ct.local.remainingShips = 0; window.ct.quitGame(); });
  const back = await waitFor('back on the games list', async () => /\/games\/$/.test(p.page.url()), 15);
  console.log(`${stamp()}   picker's game over: ${back ? 'back on the games list' : 'stayed at ' + p.page.url()}`);
  await p.close();
  return joined && older === 1 && back;
});

await scenario('no-bots', async (use) => {
  // A person in the game (here a guest) switches "Let bots join" off in the
  // settings: the bot already there leaves, the matchmaker sends no more (nor
  // counts the game as waiting, which is what the fill-in daemon goes by), and
  // switching it back on lets them in again.
  const bot = use(new Bot('🤖 Robo', makeHeuristic()));
  await bot.open(mode);
  const host = await personPage('Hal'), person = await personPage('Pat');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  const players = () => host.page.evaluate(() => window.ct.players.length);
  try {
    await begin(host);
    if (!await waitFor('host playing', async () => (await role(host)) === 'host', 15)) return false;
    await sleep(1000);
    await begin(person);
    if (!await waitFor('the person joins', async () => (await players()) === 2, 15)) return false;
    await bot.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, joinOnly: true }), [bot.name, bot.mode]);
    if (!await waitFor('the bot joins', async () => (await players()) === 3, 15)) return false;
    bot.loop();
    console.log(`${stamp()}   two people and a bot together; the guest opens the settings`);
    await person.page.click('#btn-settings');
    await person.page.waitForSelector('#settings:not(.hidden) #set-bots', { timeout: 5000 });
    const shown = await person.page.isVisible('#set-game');
    await person.page.click('#set-bots');
    const gone = await waitFor('the bot is sent home', async () => (await players()) === 2, 10);
    await sleep(1500);
    const g = (await games())[0];
    const note = await person.page.textContent('#set-bots-note');
    const hostSays = await host.page.textContent('#mp-status');
    console.log(`${stamp()}   game settings shown: ${shown}; bot ${gone ? 'left' : 'is still there'}; list: noBots ${g && g.noBots}; note "${note}"; host's status "${hostSays}"`);
    const waiting = (await (await fetch(args.url + 'mm/status')).json()).waiting.coop;
    const r = await bot.page.evaluate(async (m) => (await (await fetch('mm/play', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '🤖 Next', mode: m, bot: true, joinOnly: true }) })).json()), mode);
    console.log(`${stamp()}   another fill-in bot asks to join: ${r.role}`);
    await person.page.click('#set-bots');   // let them in again
    await sleep(1500);
    const g2 = (await games())[0];
    await person.page.click('#set-close');
    console.log(`${stamp()}   switched back on: list noBots ${g2 && g2.noBots}`);
    const errs = [...host.errors, ...person.errors];
    if (errs.length) console.log(`${stamp()}   page errors: ${errs.join(' | ')}`);
    return shown && gone && g && g.noBots && r.role === 'none' && g2 && !g2.noBots && !errs.length;
  } finally { await host.close(); await person.close(); }
});

await scenario('settings-park', async (use) => {
  // The gear in a shared universe: nothing pauses, the opener's teapot is
  // parked and comes back on closing (a guest, then the host); alone, it pauses.
  const host = await personPage('Hana'), guest = await personPage('Gus');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  try {
    await begin(host);
    await waitFor('host playing', async () => (await role(host)) === 'host', 15);
    // alone first: the gear pauses
    await host.page.click('#btn-settings');
    const soloState = await host.page.evaluate(() => window.ct.state);
    await host.page.click('#set-close');
    const soloAfter = await host.page.evaluate(() => window.ct.state);
    console.log(`${stamp()}   alone: settings ${soloState === 3 ? 'paused the game' : 'state ' + soloState}, closing ${soloAfter === 1 ? 'resumed it' : 'left state ' + soloAfter}`);
    await sleep(1000);
    await begin(guest);
    if (!await waitFor('guest joins', async () => joined(guest), 15)) return false;
    await sleep(2500);
    const rec = async (name) => { const r = await hostRec(host.page, name); return r && { ...r, pos: r.alive && !r.away }; };
    await guest.page.click('#btn-settings');
    await sleep(1500);
    const gAway = await rec('Gus');
    await guest.page.click('#set-close');
    await waitFor('guest back in play', async () => (await rec('Gus')).pos, 4);
    const gBack = await rec('Gus');
    console.log(`${stamp()}   guest in settings: ${gAway.pos ? 'teapot still in play' : 'frozen'} (alive ${gAway.alive}); closed: ${gBack.pos ? 'back in play' : 'still frozen'}`);
    const clock0 = await host.page.evaluate(() => window.ct.gameClock);
    await host.page.click('#btn-settings');
    await sleep(1500);
    const hAway = await rec('Hana');
    const running = (await host.page.evaluate(() => window.ct.gameClock)) > clock0 + 10;
    const note = await host.page.textContent('#set-away-note');
    await host.page.click('#set-close');
    await waitFor('host back in play', async () => (await rec('Hana')).pos, 4);
    const hBack = await rec('Hana');
    console.log(`${stamp()}   host in settings: ${hAway.pos ? 'teapot still in play' : 'frozen'}, universe ${running ? 'still running' : 'STOPPED'}, note "${note}"; closed: ${hBack.pos ? 'back in play' : 'still frozen'}`);
    const errs = [...host.errors, ...guest.errors];
    if (errs.length) console.log(`${stamp()}   page errors: ${errs.join(' | ')}`);
    return soloState === 3 && soloAfter === 1 && !gAway.pos && gAway.alive && gBack.pos && !hAway.pos && hAway.alive && running && hBack.pos && !errs.length;
  } finally { await host.close(); await guest.close(); }
});

await scenario('solo-button', async (use) => {
  // Solo on the top line: a plain game, no matchmaker, nobody joins.
  const p = await personPage('Sol');
  try {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.click('#mp-single');
    await p.page.keyboard.press('Enter');
    await sleep(2000);
    const st = await p.page.evaluate(() => ({ state: window.ct.state, role: window.__mpDbg().role }));
    const list = await games();
    console.log(`${stamp()}   after Solo + Enter: state ${st.state} (1 = playing), session ${st.role}, games listed ${list.length}`);
    return st.state === 1 && !st.role && list.length === 0;
  } finally { await p.close(); }
});

await scenario('settings-personal', async (use) => {
  // The personal settings, through the settings screen: max players steers
  // matchmaking, mutes and chat off hide lines, name tags, reduce motion, and
  // the touch buttons' side and size.
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
  };
  const ann = await personPage('Ann'), ben = await personPage('Ben'), cy = await personPage('Cy');
  try {
    for (const p of [ann, ben, cy]) await begin(p);
    // Ann hosts (up to 4); Ben wants games of 2 at most, so he gets a game of his own
    await ann.page.evaluate(() => window.ct.beginGame());
    await waitFor('Ann hosts', async () => (await role(ann)) === 'host', 15);
    await ben.page.click('#mp-settings');
    await ben.page.click('#set-max button[data-n="2"]');
    await ben.page.click('#set-close');
    await ben.page.evaluate(() => window.ct.beginGame());
    await waitFor('Ben starts', async () => !!(await role(ben)), 15);
    await sleep(1500);
    let list = await games();
    const benAlone = (await role(ben)) === 'host';
    console.log(`${stamp()}   Ben (up to 2) is ${await role(ben)}; games: ${list.map((g) => `[${g.players.map((q) => q.name).join(', ')}] max ${g.max}`).join('; ')}`);
    // Cy (up to 4, the default) joins the lowest-level oldest that fits: Ann
    await cy.page.evaluate(() => window.ct.beginGame());
    await waitFor('Cy joins', async () => joined(cy), 15);
    const cyWithAnn = await waitFor('the list shows Cy with Ann', async () => (await games()).some((g) => g.players.map((q) => q.name).join() === 'Ann,Cy'), 5);
    list = await games();
    console.log(`${stamp()}   Cy (up to 4): ${list.map((g) => `[${g.players.map((q) => q.name).join(', ')}]`).join('; ')}`);
    // Cy mutes Ann; Ann's line doesn't reach Cy, Cy's own does
    await cy.page.click('#btn-settings');
    await cy.page.waitForSelector('#set-mutes .mute-row', { timeout: 5000 });
    const muteLabel = await cy.page.textContent('#set-mutes .mute-row span');
    await cy.page.click('#set-mutes .mute-row input');
    await cy.page.click('#set-tags');                        // name tags off
    await cy.page.click('#set-close');
    await ann.page.evaluate(() => window.ctAgent.say('hello from Ann'));
    await cy.page.evaluate(() => window.ctAgent.say('hi from Cy'));
    await sleep(1500);
    const cyLog = await cy.page.evaluate(() => window.__chatLog());
    const annLog = await ann.page.evaluate(() => window.__chatLog());
    const tagsOff = await cy.page.evaluate(() => localStorage.getItem('cheesetoast.nameTags'));
    console.log(`${stamp()}   mute row "${muteLabel}"; Cy's chat: ${JSON.stringify(cyLog)}; Ann's chat: ${JSON.stringify(annLog)}; tags pref ${tagsOff}`);
    const muted = !cyLog.some((l) => l.includes('Ann')) && cyLog.some((l) => l.includes('hi from Cy')) && annLog.some((l) => l.includes('hi from Cy'));
    // reduce motion: Ben's game over doesn't spin
    await ben.page.click('#btn-settings');
    await ben.page.click('#set-motion');
    await ben.page.click('#set-close');
    await ben.page.evaluate(() => window.ct.quitGame());
    await sleep(2000);
    const roll = await ben.page.evaluate(() => window.ct.cameraRoll);
    console.log(`${stamp()}   Ben's game over with reduce motion: camera roll ${Math.round(roll)} (a spin reaches hundreds of degrees)`);
    return benAlone && cyWithAnn && muted && tagsOff === 'false' && Math.abs(roll) < 1;
  } finally { await ann.close(); await ben.close(); await cy.close(); }
});

await scenario('guest-status', async () => {
  // A guest's status line names everyone here, including those who arrive after it.
  const a = await personPage('Wendy'), b = await personPage('Jim'), c = await personPage('Zolarp');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  try {
    await begin(a); await waitFor('Wendy hosts', async () => (await role(a)) === 'host', 15);
    await begin(b); await waitFor('Jim joins', async () => joined(b), 15);
    await begin(c); await waitFor('Zolarp joins', async () => joined(c), 15);
    const ok = await waitFor("Jim's status names Zolarp", async () => /Zolarp/.test(await b.page.textContent('#mp-status')), 5);
    if (args.verbose) for (const [n, p] of [['Wendy', a], ['Jim', b], ['Zolarp', c]])
      console.log(`${stamp()}   ${n} (${(await p.page.evaluate(() => window.__mpDbg().id))}): ${JSON.stringify(await p.page.evaluate(() => ctAgent.online().log))}`.slice(0, 1500));
    console.log(`${stamp()}   Jim's status: "${await b.page.textContent('#mp-status')}"; Zolarp's: "${await c.page.textContent('#mp-status')}"`);
    return ok;
  } finally { await a.close(); await b.close(); await c.close(); }
});

await scenario('settings-touch', async () => {
  // Touch buttons: left-handed puts fire on the left; button size scales them.
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => localStorage.setItem('cheesetoast.name', JSON.stringify('Tia')));
  const page = await ctx.newPage();
  try {
    await page.goto(args.url + '?debug&solo');
    await page.waitForFunction(() => document.getElementById('start').classList.contains('ready'));
    await page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await page.evaluate(() => window.ct.beginGame());
    await sleep(800);
    const box = async () => page.evaluate(() => { const f = document.querySelector('.tc-fire').getBoundingClientRect(); return { x: Math.round(f.left), w: Math.round(f.width) }; });
    const before = await box();
    await page.tap('#btn-settings');
    const touchShown = await page.isVisible('#set-touch');
    await page.tap('#set-lefty');
    await page.evaluate(() => { const r = document.getElementById('set-btn'); r.value = 120; r.dispatchEvent(new Event('input')); });
    await page.tap('#set-close');
    await sleep(300);
    const after = await box();
    console.log(`${stamp()}   touch settings shown: ${touchShown}; fire button x ${before.x} -> ${after.x}, width ${before.w} -> ${after.w}`);
    return touchShown && after.x < 200 && before.x > 500 && after.w > before.w * 1.1;
  } finally { await ctx.close(); }
});

await scenario('host-leaves-bots', async (use) => {
  // From the live log of 2026-10-05 20:10: a person hosts a melee with three
  // fill-in bots and closes the page.  The bots must end up in one universe,
  // not scattered (they disagreed on who should host, and one joined the
  // person who had just left).
  const host = await personPage('f');
  const bots = ['🤖 Rafael', '🤖 William', '🤖 Francine'].map((n) => use(new Bot(n, makeHeuristic())));
  try {
    await host.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await host.page.evaluate(() => { document.getElementById('mp-melee').click(); window.ct.beginGame(); });
    if (!await waitFor('f hosts', async () => (await role(host)) === 'host', 15)) return false;
    for (const b of bots) {
      await b.open('melee');
      await b.page.evaluate((n) => { ctAgent.setDraw(false); ctAgent.setKick(5); return ctAgent.playOnline({ name: n, mode: 'melee', max: 4, joinOnly: true }); }, b.name);
      await waitFor(`${b.name} joins`, async () => joined(b), 15);
      b.loop();
    }
    if (!await waitFor('four in one universe', async () => (await host.page.evaluate(() => window.ct.players.length)) === 4, 10)) return false;
    await sleep(3000);
    // as on the live site: of f's last messages only one "follow the heir"
    // notice gets out (the handoff and the other notice die with the page)
    const lost = await host.page.evaluate(() => {
      const t = window.__mp.transport, send = t.send.bind(t);
      let rehosts = 0; const dropped = [];
      t.send = (m) => {
        if (m.k === 'handoff' || (m.k === 'rehost' && rehosts++ > 0)) { dropped.push(m.k); return; }
        send(m);
      };
      return new Promise((r) => setTimeout(() => r(dropped), 0)) && dropped;
    });
    console.log(`${stamp()}   f closes the page (losing its handoff and one notice)`);
    await host.close();
    // where does everyone end up?
    const view = async () => Promise.all(bots.map(async (b) => {
      const i = await b.poll();
      const id = await b.page.evaluate(() => window.__mpDbg().id).catch(() => '?');
      return { name: b.name, role: i.role, players: i.players, id };
    }));
    const together = await waitFor('the three bots in one universe', async () => {
      const v = await view();
      return v.filter((x) => x.role === 'host').length === 1 && v.some((x) => x.role === 'host' && x.players === 3);
    }, 30);
    const v = await view();
    console.log(`${stamp()}   ${together ? 'together' : 'SCATTERED'}: ${v.map((x) => `${x.name}=${x.role}/${x.players}p (id ${x.id})`).join(', ')}`);
    if (!together && args.verbose) for (const b of bots) console.log(`${stamp()}   ${b.name}: ${b.events.filter((e) => !/rtc: /.test(e)).slice(-10).join(' | ')}`);
    return together && v.every((x) => x.id && x.id !== 'null');
  } finally { await host.close(); }
});

await scenario('turn-relay', async () => {
  // Two players whose networks can't reach each other directly (?relay allows
  // only relayed routes, like the strict networks in the 2026-10-05 log): with
  // the TURN relay they connect through it; without it they can't.  Needs the
  // relay's secret for the local matchmaker (CT_TURN_SECRET; see CLAUDE.md).
  const a = await personPage('Michael', '&relay'), b = await personPage('chicken', '&relay');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  try {
    await begin(a); await waitFor('Michael hosts', async () => (await role(a)) === 'host', 15);
    const turn = await a.page.evaluate(() => window.__mpDbg().turn);
    await begin(b);
    const ok = await waitFor('chicken joins Michael', async () => joined(b), 15);
    await sleep(1000);
    const route = await b.page.evaluate(() => (window.__mpDbg().peers[0] || {}).route || null);
    const status = await b.page.textContent('#mp-status');
    console.log(`${stamp()}   relay credentials: ${turn ? 'yes' : 'NO (STUN only)'}; chicken ${ok ? 'joined Michael' : "couldn't join"}; route ${route}; "${status}"`);
    return ok && /^relay/.test(route || '');
  } finally { await a.close(); await b.close(); }
});

await scenario('turn-relay-tls', async () => {
  // The same over the relay's TLS address only (5349: networks that block UDP)
  const a = await personPage('Pat', '&relay=tls'), b = await personPage('Sam', '&relay=tls');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  try {
    await begin(a); await waitFor('Pat hosts', async () => (await role(a)) === 'host', 15);
    await begin(b);
    const ok = await waitFor('Sam joins Pat', async () => joined(b), 15);
    await sleep(1000);
    const route = await b.page.evaluate(() => (window.__mpDbg().peers[0] || {}).route || null);
    console.log(`${stamp()}   Sam ${ok ? 'joined Pat' : "couldn't join"}; route ${route}`);
    return ok && /via tls/.test(route || '');
  } finally { await a.close(); await b.close(); }
});

// the steering circle, driven like a thumb (pointer events at points in the circle)
async function stickPage(name, query, url = args.url) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript((n) => localStorage.setItem('cheesetoast.name', JSON.stringify(n)), name);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '?debug' + query);
  await page.waitForFunction(() => window.ct && window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 20000 });
  const box = async () => page.evaluate(() => { const r = document.getElementById('tc-stick').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, R: r.width / 2 }; });
  // a point in the circle: deg clockwise from up, k = fraction of the radius
  const at = async (deg, k) => { const b = await box(); const a = deg * Math.PI / 180; return [b.x + Math.sin(a) * k * b.R, b.y - Math.cos(a) * k * b.R]; };
  return { ctx, page, errors, at, close: () => ctx.close().catch(() => {}) };
}

await scenario('touch-stick', async () => {
  // Point in the circle: the teapot turns to face that way one step a tick
  // (like a held arrow key: a quarter turn takes 4 ticks), drag to keep
  // steering, a flick finishes its turn, and a double-tap in the middle
  // brakes without turning.
  const t = await stickPage('Thumb', '&solo');
  const { page } = t;
  try {
    await page.evaluate(() => window.ct.beginGame());
    await page.waitForFunction(() => window.ct.local.ship && window.ct.local.ship.type === 1, null, { timeout: 10000 });
    const rot = () => page.evaluate(() => window.ct.local.ship.rotIdx);
    // follow the heading every frame while something happens
    const watch = async (fn, ms) => {
      await page.evaluate(() => { window.__rots = []; const f = () => { if (window.__rots) { window.__rots.push(window.ct.local.ship ? window.ct.local.ship.rotIdx : -1); requestAnimationFrame(f); } }; f(); });
      await fn(); await sleep(ms);
      return page.evaluate(() => { const r = window.__rots; window.__rots = null; return r.filter((x, i) => i === 0 || x !== r[i - 1]); });
    };
    const results = [];
    // 1. thumb down at 3 o'clock: 0 -> 8, by steps of 2
    let seq = await watch(async () => { await page.mouse.move(...await t.at(90, 0.85)); await page.mouse.down(); }, 600);
    results.push(['thumb at 3 o\'clock', seq, seq[seq.length - 1] === 8 && seq.every((x, i) => i === 0 || Math.abs(x - seq[i - 1]) === 2)]);
    // 2. drag round to 6 o'clock, then 9
    seq = await watch(async () => { for (const d of [120, 150, 180]) { await page.mouse.move(...await t.at(d, 0.85)); await sleep(60); } }, 500);
    results.push(['dragged to 6 o\'clock', seq, seq[seq.length - 1] === 16]);
    seq = await watch(async () => { for (const d of [210, 240, 270]) { await page.mouse.move(...await t.at(d, 0.85)); await sleep(60); } }, 500);
    results.push(['dragged to 9 o\'clock', seq, seq[seq.length - 1] === 24]);
    seq = await watch(async () => { await page.mouse.up(); }, 400);
    results.push(['thumb lifted', seq, seq[seq.length - 1] === 24 && seq.length === 1]);
    // 3. a flick at 12 o'clock: down and up at once; the turn still completes (24 -> 0 is 4 steps)
    seq = await watch(async () => { await page.mouse.move(...await t.at(0, 0.9)); await page.mouse.down(); await page.mouse.up(); }, 600);
    results.push(['flick at 12 o\'clock', seq, seq[seq.length - 1] === 0]);
    // 4. one tap in the middle: nothing
    await page.evaluate(() => { const s = window.ct.local.ship; s.vx = 4; s.vy = 3; });
    await page.mouse.move(...await t.at(0, 0)); await page.mouse.down(); await page.mouse.up();
    await sleep(150);
    const v1 = await page.evaluate(() => Math.hypot(window.ct.local.ship.vx, window.ct.local.ship.vy));
    results.push(['one tap in the middle', [`speed ${v1.toFixed(1)}`, `heading ${await rot()}`], v1 > 3 && (await rot()) === 0]);
    // 5. double-tap in the middle, holding the second: stops dead, no turn
    await sleep(500);
    await page.mouse.down(); await page.mouse.up(); await sleep(120); await page.mouse.down();
    await sleep(200);
    const v2 = await page.evaluate(() => Math.hypot(window.ct.local.ship.vx, window.ct.local.ship.vy));
    const braking = await page.evaluate(() => document.getElementById('tc-stick').classList.contains('braking'));
    await page.mouse.up();
    results.push(['double-tap in the middle', [`speed ${v2.toFixed(1)}`, `heading ${await rot()}`, `brake lit ${braking}`], v2 === 0 && (await rot()) === 0 && braking]);
    for (const [what, s, ok] of results) console.log(`${stamp()}   ${ok ? 'ok ' : 'BAD'} ${what}: ${JSON.stringify(s)}`);
    if (t.errors.length) console.log(`${stamp()}   page errors: ${t.errors.join(' | ')}`);
    return results.every((r) => r[2]) && !t.errors.length;
  } finally { await t.close(); }
});

await scenario('touch-stick-guest', async () => {
  // A guest steering with the circle: the host turns its teapot to the target
  // (sent with its inputs), at the same rate, no overshoot from the lag.
  const host = await personPage('Host');
  const g = await stickPage('Thumb', '');
  try {
    await host.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await host.page.evaluate(() => window.ct.beginGame());
    await waitFor('host', async () => (await role(host)) === 'host', 15);
    await g.page.evaluate(() => window.ct.beginGame());
    if (!await waitFor('guest joins', async () => joined(g), 15)) return false;
    await host.page.waitForFunction(() => { const p = window.ct.players.find((q) => q.name === 'Thumb'); return p && p.ship && p.ship.type === 1; }, null, { timeout: 10000 });
    await host.page.evaluate(() => { window.__grots = []; const f = () => { if (window.__grots) { const p = window.ct.players.find((q) => q.name === 'Thumb'); window.__grots.push(p && p.ship ? p.ship.rotIdx : -1); requestAnimationFrame(f); } }; f(); });
    await g.page.mouse.move(...await g.at(135, 0.85)); await g.page.mouse.down();
    await sleep(1200);
    await g.page.mouse.up();
    const seq = await host.page.evaluate(() => { const r = window.__grots; window.__grots = null; return r.filter((x, i) => i === 0 || x !== r[i - 1]); });
    console.log(`${stamp()}   host's view of the guest's heading: ${JSON.stringify(seq)} (target 12)`);
    return seq[seq.length - 1] === 12 && seq.filter((x) => x === 12).length === 1;
  } finally { await host.close(); await g.close(); }
});

await scenario('pause-shared', async () => {
  // P in a shared universe (2026-10-08: hosts pressing P handed the universe
  // around five times in two minutes; the user's design): the pause overlay,
  // sound off, your teapot frozen in place while the others play on; the host
  // stays the host; P again and you're back.
  const host = await personPage('Hana'), guest = await personPage('Gus');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  const ui = (p) => p.page.evaluate(() => ({ role: window.__mpDbg().role, overlay: !document.getElementById('paused').classList.contains('hidden'),
    note: document.getElementById('paused-note').textContent, audio: window.ct.realSnd.ctx ? window.ct.realSnd.ctx.state : '?' }));
  try {
    await begin(host); await waitFor('host', async () => (await role(host)) === 'host', 15);
    await begin(guest); if (!await waitFor('guest joins', async () => joined(guest), 15)) return false;
    await host.page.waitForFunction(() => window.ct.players.every((p) => p.ship && p.ship.type === 1), null, { timeout: 10000 });
    await sleep(500);
    const clock = await host.page.evaluate(() => window.ct.gameClock);
    await host.page.keyboard.press('KeyP');
    await sleep(1500);
    const h1 = await ui(host), hr1 = await hostRec(host.page, 'Hana'), g1 = await ui(guest);
    const running = (await host.page.evaluate(() => window.ct.gameClock)) > clock + 20;
    console.log(`${stamp()}   host pressed P: still ${h1.role}, overlay ${h1.overlay}, audio ${h1.audio}, teapot frozen ${hr1.away} (alive ${hr1.alive}), universe ${running ? 'running' : 'STOPPED'}; guest is ${g1.role}; note "${h1.note}"`);
    await host.page.keyboard.press('KeyP');
    await sleep(800);
    const h2 = await ui(host), hr2 = await hostRec(host.page, 'Hana');
    console.log(`${stamp()}   P again: overlay ${h2.overlay}, audio ${h2.audio}, frozen ${hr2.away}`);
    await guest.page.keyboard.press('KeyP');
    await waitFor('guest frozen', async () => (await hostRec(host.page, 'Gus')).away, 4);
    const gr = await hostRec(host.page, 'Gus'), g2 = await ui(guest);
    const tag = await host.page.evaluate(() => { const p = window.ct.players.find((q) => q.name === 'Gus'); return p.away; });
    await guest.page.keyboard.press('Escape');
    await waitFor('guest back', async () => !(await hostRec(host.page, 'Gus')).away, 4);
    const gr2 = await hostRec(host.page, 'Gus');
    console.log(`${stamp()}   guest pressed P: overlay ${g2.overlay}, frozen ${gr.away}, alive ${gr.alive}; Esc: frozen ${gr2.away}; host still ${(await ui(host)).role}`);
    return h1.role === 'host' && h1.overlay && hr1.away && hr1.alive && running && g1.role === 'guest' && !h2.overlay && !hr2.away
      && g2.overlay && gr.away && gr.alive && !gr2.away && (await ui(host)).role === 'host';
  } finally { await host.close(); await guest.close(); }
});

await scenario('pause-melee-shot', async () => {
  // In melee a paused (frozen) teapot can still be shot by a rival.
  const host = await personPage('Shooter'), guest = await personPage('Sitter');
  try {
    for (const p of [host, guest]) await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await host.page.evaluate(() => { document.getElementById('mp-melee').click(); window.ct.beginGame(); });
    await waitFor('host', async () => (await role(host)) === 'host', 15);
    await guest.page.evaluate(() => { document.getElementById('mp-melee').click(); window.ct.beginGame(); });
    if (!await waitFor('guest joins', async () => joined(guest), 15)) return false;
    await host.page.waitForFunction(() => window.ct.players.length === 2 && window.ct.players.every((p) => p.ship && p.ship.type === 1 && p.ship.tickCtr > 45), null, { timeout: 15000 });
    await guest.page.keyboard.press('KeyP');
    await waitFor('frozen', async () => (await hostRec(host.page, 'Sitter')).away, 4);
    const before = await hostRec(host.page, 'Sitter');
    const score0 = await host.page.evaluate(() => window.ct.local.gameScore);
    // the shooter, 120 below the frozen teapot, pointing up, firing
    await host.page.evaluate(() => {
      const g = window.ct, me = g.local.ship, t = g.players.find((q) => q.name === 'Sitter').ship;
      me.x = me.prevX = t.x; me.y = me.prevY = t.y - 120; me.vx = me.vy = 0; me.rotIdx = 0;
      g.input.botFlags = 1;   // KF.Fire
    });
    const hit = await waitFor('the frozen teapot is hit', async () => {
      const r = await hostRec(host.page, 'Sitter');
      return r.pots < before.pots || !r.alive;
    }, 5);
    await host.page.evaluate(() => { window.ct.input.botFlags = 0; });
    const score1 = await host.page.evaluate(() => window.ct.local.gameScore);
    console.log(`${stamp()}   rival fired at the frozen teapot: ${hit ? 'hit' : 'NOT hit'}; shooter's score ${score0} -> ${score1}`);
    return hit && score1 >= score0 + 2000;
  } finally { await host.close(); await guest.close(); }
});

await scenario('games-list-new', async () => {
  // "+ New game" on the games page: a dialog with the game's settings, then
  // straight into a game of your own with them (no start screen), listed with
  // them; when it ends, back on the games page.
  const p = await personPage('Nova', '', { agent: false });
  try {
    await p.page.goto(args.url + 'games/');
    await p.page.click('#new-game');
    await p.page.waitForSelector('#new-dlg[open]', { timeout: 5000 });
    await p.page.click('#new-mode button[data-mode="melee"]');
    await p.page.click('#new-max button[data-n="3"]');
    await p.page.click('#new-bots');   // bots off
    const hint = await p.page.textContent('#new-hint');
    await p.page.click('#new-start');
    // (the page it lands on has no ?debug: judged by what a person sees)
    await p.page.waitForFunction(() => /Melee/.test(document.getElementById('mp-status').textContent), null, { timeout: 20000 });
    const splash = await p.page.evaluate(() => !document.getElementById('start').classList.contains('hidden'));
    const status = await p.page.textContent('#mp-status');
    const g = await waitFor('the new game is listed', async () => (await games()).some((x) => x.players.some((q) => q.name === 'Nova')), 8);
    const mine = (await games()).find((x) => x.players.some((q) => q.name === 'Nova'));
    console.log(`${stamp()}   dialog hint "${hint}"; "${status}", start screen ${splash ? 'SHOWING' : 'gone'}; listed: ${mine ? `${mine.mode}, up to ${mine.max}, noBots ${mine.noBots}` : 'no'}`);
    await p.page.keyboard.press('KeyQ');   // end the game
    const back = await waitFor('back on the games list', async () => /\/games\/$/.test(p.page.url()), 20);
    console.log(`${stamp()}   game over: ${back ? 'back on the games list' : 'stayed at ' + p.page.url()}`);
    return !splash && g && mine.mode === 'melee' && mine.max === 3 && mine.noBots && back;
  } finally { await p.close(); }
});

await scenario('attract-silent', async () => {
  // No click to start: the page goes to the attract mode by itself, silently;
  // the fanfare plays when a game begins.
  const p = await personPage('Quiet', '', { agent: false });
  try {
    const t0 = Date.now();
    await p.page.waitForFunction(() => window.ct.state === 0, null, { timeout: 15000 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const before = await p.page.evaluate(() => window.ct.realSnd.playing.reduce((n, a) => n + a.length, 0));
    await p.page.waitForFunction(() => window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.keyboard.press('KeyP');   // a key starts a game (and unlocks audio)
    await p.page.waitForFunction(() => window.ct.state === 1, null, { timeout: 15000 });
    await sleep(300);
    const after = await p.page.evaluate(() => window.ct.realSnd.playing.map((a, i) => [i, a.length]).filter(([, k]) => k));
    console.log(`${stamp()}   attract mode after ${secs} s with no click; sounds started by then: ${before}; after P: ${JSON.stringify(after)} (SND.LevelCompletion is the fanfare)`);
    return before === 0 && after.length > 0;
  } finally { await p.close(); }
});

await scenario('predict-lag', async () => {
  // A guest on a bad network (?netsim: 160 ms more round trip, up to 40 ms
  // jitter each way, 3% of snapshots and inputs lost): its own teapot answers
  // the keys at once (predicted), the host ends up agreeing with where it
  // went, and the rest of the universe moves smoothly (no frame where things
  // stop while the buffer is dry for long).
  const host = await personPage('Hana'), guest = await personPage('Gus', '&netsim=160,40,0.03');
  const begin = async (p) => {
    await p.page.waitForFunction(() => window.ct.state === 0 && window.ct.canStartFromAttract(), null, { timeout: 15000 });
    await p.page.evaluate(() => window.ct.beginGame());
  };
  try {
    await begin(host); await waitFor('host', async () => (await role(host)) === 'host', 15);
    await begin(guest); if (!await waitFor('guest joins', async () => joined(guest), 15)) return false;
    await host.page.waitForFunction(() => window.ct.players.length === 2 && window.ct.players.every((p) => p.ship && p.ship.type === 1), null, { timeout: 15000 });
    if (!await waitFor('the guest predicting', async () => guest.page.evaluate(() => { const d = window.__mpDbg(); return !!(d.lag && d.lag.ahead != null); }), 10)) {
      console.log(`${stamp()}   guest: ${JSON.stringify(await guest.page.evaluate(() => { const s = window.ct.remote; return { lag: window.__mpDbg().lag, buf: s.buf.map((b) => b.tick), rt: s.renderTick, me: s.snap && s.snap.players.find((p) => p[0] === s.id), rec: s.snap && s.snap.sprites.find((a) => a[0] === (s.snap.players.find((p) => p[0] === s.id) || [])[6]) }; }))}`);
      return false;
    }
    await sleep(1500);
    // record the guest's own heading and position every frame, and when the key went down
    await guest.page.evaluate(() => {
      window.__rec = []; window.__keyAt = null;
      addEventListener('keydown', (e) => { if (e.code === 'ArrowLeft' && window.__keyAt == null) window.__keyAt = performance.now(); }, true);
      const f = () => { if (!window.__rec) return; const s = window.ct.local.ship; window.__rec.push([performance.now(), s ? s.rotIdx : -1, s ? s.x : 0, s ? s.y : 0]); requestAnimationFrame(f); };
      f();
    });
    await sleep(300);
    await guest.page.keyboard.down('ArrowLeft'); await sleep(500); await guest.page.keyboard.up('ArrowLeft');
    await guest.page.keyboard.down('KeyZ'); await sleep(700); await guest.page.keyboard.up('KeyZ');
    await sleep(1500);
    const r = await guest.page.evaluate(() => {
      const rec = window.__rec; window.__rec = null;
      const k = window.__keyAt, before = rec.filter((x) => x[0] < k).pop();
      const turned = rec.find((x) => x[0] >= k && x[1] !== before[1]);
      // frames where the teapot jumped (more than its top speed plus a margin)
      let jumps = 0;
      for (let i = 1; i < rec.length; i++) { const dx = rec[i][2] - rec[i - 1][2], dy = rec[i][3] - rec[i - 1][3]; if (Math.abs(dx) < 1900 && Math.hypot(dx, dy) > 30) jumps++; }
      const s = window.ct.local.ship;
      return { answer: turned ? Math.round(turned[0] - k) : null, jumps, lag: window.__mpDbg().lag, at: s ? [s.x, s.y, s.rotIdx] : null };
    });
    const h = await host.page.evaluate(() => { const p = window.ct.players.find((q) => q.name === 'Gus'); return p && p.ship ? [p.ship.x, p.ship.y, p.ship.rotIdx] : null; });
    const apart = r.at && h ? Math.hypot(r.at[0] - h[0], r.at[1] - h[1]) : 1e9;
    const L = r.lag;
    console.log(`${stamp()}   Left answered on the guest in ${r.answer} ms; round trip ${JSON.stringify(L.rtt)} ms, snapshot gaps ${L.gap50}/${L.gap95} ms, ${L.lost}% lost, shown ${L.delay} ms late, prediction ${L.ahead} ticks ahead, off by ${L.miss50}/${L.miss95} (median/95%), ${L.dry} dry frames, ${r.jumps} jumps; snapshots ${L.snapB} bytes, ${L.kin} KB/s in`);
    console.log(`${stamp()}   after coasting: guest sees itself at ${r.at && r.at.map(Math.round)}, the host has it at ${h && h.map(Math.round)} (${apart.toFixed(0)} apart, heading ${r.at && r.at[2]} vs ${h && h[2]})`);
    const errs = [...host.errors, ...guest.errors];
    if (errs.length) console.log(`${stamp()}   page errors: ${errs.join(' | ')}`);
    return r.answer != null && r.answer <= 120 && L.snapB > 0 && L.rtt[0] > 140 && L.miss95 <= 12 && r.jumps === 0 && r.at[2] === h[2] && apart < 150 && !errs.length;
  } finally { await host.close(); await guest.close(); }
});

await scenario('busy-4', async (use) => {
  // Four bots in one co-op universe for 40 s, two of them on bad networks
  // (?netsim): nobody's page errs, every guest predicts its teapot closely,
  // snapshots go as bytes and stay small, few frames find the buffer dry,
  // and host and guests agree on scores and pots.
  const nets = ['', '', '&netsim=120,30,0.02', '&netsim=200,60,0.05'];
  const bots = ['B0', 'B1', 'B2', 'B3'].map((n) => use(new Bot(n, makeHeuristic())));
  for (let i = 0; i < 4; i++) await bots[i].open('coop', nets[i]);
  const playMax = async (b) => {
    await b.page.evaluate(([n, m]) => ctAgent.playOnline({ name: n, mode: m, max: 4 }), [b.name, b.mode]);
    for (let i = 0; i < 150; i++) { if ((await b.info()).playing) break; await sleep(100); }
    b.loop();
  };
  await playMax(bots[0]); await sleep(2500);
  for (const b of bots.slice(1)) { await playMax(b); await sleep(1500); }
  if (!await waitFor('all four in one universe', async () => (await bots[0].poll()).players === 4, 30)) return false;
  await sleep(40000);
  const lags = await Promise.all(bots.map((b) => b.page.evaluate(() => ({ role: window.__mpDbg().role, lag: window.__mpDbg().lag, frames: window.ct.fps }))));
  const au = await Promise.all(bots.map((b) => b.page.evaluate(() => ctAgent.audit())));
  const host = au.find((a) => a.role === 'host');
  let agree = true;
  for (const a of au.filter((x) => x.role === 'guest')) {
    const me = host && (host.players || []).find((p) => p.id === a.id);
    if (!me || me.score !== a.local.score || me.pots !== a.local.pots) { agree = false; console.log(`${stamp()}   disagree: ${JSON.stringify(a.local)} vs ${JSON.stringify(me)}`); }
  }
  let ok = !!host && agree;
  lags.forEach((l, i) => {
    const L = l.lag || {};
    console.log(`${stamp()}   ${bots[i].name} (${nets[i] || 'no netsim'}): ${l.role}, rtt ${JSON.stringify(L.rtt)}, ` + (l.role === 'guest'
      ? `gaps ${L.gap50}/${L.gap95} ms, lost ${L.lost}%, shown ${L.delay} ms late, prediction ${L.ahead} ahead, off by ${L.miss50}/${L.miss95}, dry ${L.dry}, ` : '')
      + `in ${L.kin} KB/s, out ${L.kout} KB/s, snapshots ${L.snapB} bytes, ${L.skipped} skipped`);
    if (l.role === 'guest' && (!(L.snapB > 0) || L.miss50 > 2)) ok = false;
  });
  const errs = bots.flatMap((b) => b.events.filter((e) => /PAGE ERROR/.test(e)));
  if (errs.length) { console.log(`${stamp()}   ${errs.join(' | ')}`); ok = false; }
  return ok;
});

await browser.close();
if (site) site.close();
console.log('\nSUMMARY: ' + results.map(([n, ok]) => `${ok ? 'PASS' : 'FAIL'} ${n}`).join(', '));
