// Online multiplayer flow (multiplayer test site): pick Duel or Co-op in
// attract mode; starting a game asks the matchmaker whether someone is playing
// solo in that mode.  If so we join their universe as a guest; if not we play
// solo and wait in the queue for someone to join us.  When a player runs out
// of pots they go back to attract mode; the player still flying is solo again
// and goes to the back of the queue.

import { Matchmaker, RTCTransport } from './rtc.js';
import { Session } from './net.js';
import { GS, SND } from './constants.js';
import { loadPref, savePref } from './util.js';

const MODE_KEY = 'cheesetoast.mpmode';
const MAX_KEY = 'cheesetoast.mpmax';    // most players you're open to (2-4)
const JOIN_TIMEOUT = 9000;
const JOIN_GIVEUP = 15000;   // host: a joiner that hasn't said hello by then isn't coming
const CLOSED_LEVEL = 2;      // a universe at this level takes no newcomers (the matchmaker agrees, CLOSED_LEVEL there)

// 'single': a plain solo game, no matchmaker (the Solo button)
const MODES = ['single', 'coop', 'duel', 'melee'];

export function installMultiplayer(game, ui) {
  game.boardModes = ['single', 'coop', 'duel', 'melee'];   // a Hall of Cheese per mode
  const mp = {
    mode: MODES.includes(loadPref(MODE_KEY, 'coop')) ? loadPref(MODE_KEY, 'coop') : 'coop',
    maxPlayers: Math.min(4, Math.max(2, +loadPref(MAX_KEY, 4) || 4)),   // (4 at most: lag grows with players)
    mm: null,
    session: null,
    transport: null,
    partner: '',
    status: '',
    log: [],
  };
  const say = (text) => { mp.status = text; ui.setStatus && ui.setStatus(text); };
  const note = (m) => { mp.log.push(m); if (mp.log.length > 200) mp.log.shift(); };
  const modeName = () => ({ single: 'Solo', coop: 'Co-op', duel: 'Duel', melee: 'Melee' }[mp.mode]);
  // players per mode: duel is one on one; co-op and melee take up to 4
  const modeMax = () => (mp.mode === 'duel' ? 2 : Math.min(4, mp.maxPlayers));
  const playerName = () => (game.nameBuf || loadPref('cheesetoast.name', '') || 'Teapot ' + (100 + Math.floor(Math.random() * 900)));

  mp.setMode = (m) => {
    mp.mode = MODES.includes(m) ? m : 'coop';
    savePref(MODE_KEY, mp.mode);
    ui.modeChanged && ui.modeChanged(mp.mode);
    return mp.mode;
  };

  mp.setMaxPlayers = (n) => {
    mp.maxPlayers = Math.min(4, Math.max(2, n | 0));
    savePref(MAX_KEY, mp.maxPlayers);
    updateQueue();   // hosting now: the matchmaker and the games list hear of it
    return mp.maxPlayers;
  };
  mp.modeMax = () => modeMax();
  // everyone in this universe but us, for the settings' mute list
  mp.otherPlayers = () => (game.remote ? ((mp.session && mp.session.others) || []).filter((o) => !o[8]).map((o) => ({ name: o[1], bot: !!o[14] }))
    : game.players.filter((p) => p !== game.local && !p.out).map((p) => ({ name: p.name, bot: !!p.bot })));

  // Stay in the queue while there's room for more players and the universe is
  // still easy enough for a newcomer (the matchmaker sends newcomers to the
  // lowest-level universe waiting); closed at CLOSED_LEVEL.
  const updateQueue = () => {
    if (!mp.mm || !mp.session || mp.session.role !== 'host') return;
    if (game.players.length < modeMax() && game.gameLevel < CLOSED_LEVEL) mp.mm.solo(game.players.filter((p) => !p.out).length, game.gameLevel);
    else mp.mm.busy();
    reportGame();
  };
  // our universe as the games list shows it (only the host describes it)
  const reportGame = () => {
    if (!mp.mm || !mp.session || mp.session.role !== 'host') return;
    mp.mm.game({
      hosting: true, players: game.players.filter((p) => !p.out).map((p) => [p.name || '', p.bot ? 1 : 0]),
      max: modeMax(), level: game.gameLevel, noBots: !!game.noBots,
    });
  };

  // ---- "no bots" (a setting for the whole universe, which any person in it can
  // change; bots can't).  The host holds it (game.noBots, carried by snapshots
  // and handoffs); the matchmaker then sends no bots, and bots already here leave.
  mp.noBots = () => (game.remote ? !!(mp.session && mp.session.snap && mp.session.snap.nb) : !!game.noBots);
  mp.canSetNoBots = () => !!mp.session && !game.local.bot && game.state === GS.Play;
  mp.setNoBots = (on) => {
    if (!mp.canSetNoBots()) return false;
    if (mp.session.role === 'host') mp.session.setNoBots(!!on, game.local);
    else { mp.session.sendNoBots(!!on); mp.askedNoBots = performance.now(); }
    return true;
  };

  // ---- pausing in a shared universe (main.js; also the settings screen and
  // a hidden page): the universe runs on, our teapot is frozen in place
  // (game.js freezePlayer) until we're back
  mp.sharing = () => !!mp.session && (game.players.length > 1 || !!game.remote);
  mp.setAway = (on) => {
    const L = game.local;
    L.wantAway = !!on;
    if (!mp.session || game.state !== GS.Play) return;
    if (game.remote) mp.session.sendInput();   // (the flag rides on our inputs)
    else if (on && game.players.length > 1 && !L.away) game.freezePlayer(L);
    else if (!on && L.away) game.unfreezePlayer(L);
  };
  // what a host alone is waiting for: a partner, or nobody once the universe is closed
  const closed = () => game.gameLevel >= CLOSED_LEVEL;
  const soloNote = () => (closed() ? `level ${game.gameLevel}, closed to newcomers` : 'waiting for a partner');
  // the level went up: tell the matchmaker (or close), and say so if we're alone
  game.onLevel = () => {
    updateQueue();
    if (mp.session && mp.session.role === 'host' && game.players.length < 2 && closed())
      say(`${modeName()}: playing solo, ${soloNote()}`);
  };

  // the status line for a host with n players in its universe, and the queue to match
  const showPeers = (n) => {
    if (n > 1) {
      const others = game.players.filter((p) => p !== game.local).map((p) => p.name || 'someone');
      mp.partner = others.join(', ');
      say(`${modeName()} with ${mp.partner}`);
    } else {
      say(`${modeName()}: playing solo, ${soloNote()}`);
    }
    updateQueue();
  };

  // a host listens for joiners (and connection setup) on the matchmaker's event stream
  function listenAsHost(t) {
    const sess = mp.session;
    mp.mm.onevent = (e) => {
      if (e.k === 'joining') {
        note(`${e.name || 'someone'} is joining`); say(`${modeName()}: ${e.name || 'someone'} is joining...`); t.connectTo(e.guest);
        // the matchmaker took us out of the queue for this joiner; if it never
        // arrives (its network can't reach us, or it left), get back in line
        setTimeout(() => {
          if (mp.session !== sess || sess.role !== 'host') return;
          if (game.players.some((p) => p.id === e.guest) || sess.lastHeard.has(e.guest)) return;
          note(`${e.name || 'someone'} never arrived`);
          t.dropPeer(e.guest);
          showPeers(game.players.length);
        }, JOIN_GIVEUP);
      } else if (e.k === 'signal') t.handleSignal(e.from, e.data);
    };
  }

  const soloBegin = game.beginGame.bind(game);

  function hooks() {
    return {
      log: note,
      onChat: (id, name, text) => mp.onChat && mp.onChat(id, name, text),
      onPeers: (n) => {
        // a joiner slipped in while we were paused alone: the universe has to run now
        if (n > 1 && game.state === GS.Pause && !document.hidden) game.resume();
        showPeers(n);
      },
      onNoBots: (on, who) => {
        // (a guest learns of it from the snapshots: it was us if we just asked)
        if (!who) who = performance.now() - (mp.askedNoBots || -1e9) < 3000 ? 'you' : 'someone';
        say(`${modeName()}: ${who} ${on ? 'turned bots off' : 'let bots join again'}`);
        reportGame();
      },
      onDropped: () => say(`${modeName()}: reconnecting to ${mp.partner || 'the universe'}...`),
      onWelcome: () => say(`${modeName()} with ${mp.partner || 'your partner'}`),
      onBecomeHost: (others = []) => {
        // the host ran out of pots: this universe is ours now
        if (mp.transport) {
          listenAsHost(mp.transport);
          for (const id of others) mp.transport.connectTo && mp.transport.connectTo(id);
        }
        if (others.length) say(`${modeName()}: you're hosting now`);
        else say(`${modeName()}: you outlasted ${mp.partner || 'your partner'}!` + (closed() ? ` (level ${game.gameLevel}, closed to newcomers)` : ' Waiting for a new partner'));
        updateQueue();
      },
      onStepDown: (heirName) => {
        mp.partner = heirName || 'someone';
        mp.mm && mp.mm.busy();   // not open to joiners: we're a guest now
        mp.mm && mp.mm.game({ hosting: false });   // and off the games list
        say(`${modeName()}: ${mp.partner} is hosting now`);
      },
      onRehost: (hostId, hostName) => {
        mp.partner = hostName || 'someone';
        say(`${modeName()}: ${mp.partner} is hosting now...`);
      },
      onEnd: (reason, sess) => {
        note('session ended: ' + reason);
        const handedOff = !!(sess && sess.handedOff);   // the session closes its own connections later
        mp.onSessionEnd && mp.onSessionEnd();
        mp.session = null;
        const keepPlaying = reason === 'host-gone';
        if (mp.transport && !handedOff) mp.transport.close();
        mp.transport = null;
        if (keepPlaying) { regroup(sess); return; }
        mp.mm && mp.mm.leave();
        mp.mm = null;
        game.players = [game.local];
        game.onPlayerOut = null;
        game.remote = null;
        say('');
        game.endGame();
      },
    };
  }

  // The host vanished.  Its guests regroup: by the last snapshot, the one with
  // the lowest id (people before bots) hosts a fresh universe (the snapshot
  // copies aren't a real simulation) and the others join it through the
  // matchmaker, keeping their ids, so it knows them and gives back the score,
  // pots and color they had.  Alone, or if that fails, carry on solo, with the
  // game's score, pots, level and play clock, which soloBegin resets, still
  // counting toward this mode's board.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function regroup(sess) {
    const L = game.local;
    const keep = { score: L.gameScore, pots: L.remainingShips, level: game.gameLevel, started: L.gameStartTime };
    const lost = mp.partner || 'your partner';
    // everyone in the last snapshot but the host that sent it (which is gone,
    // even if we had been told to follow someone else since)
    const gone = sess.snapFrom || sess.hostId;
    const others = (sess.snap ? sess.snap.players : []).filter((p) => p[0] !== gone && !p[8])
      .sort((a, b) => ((a[14] || 0) - (b[14] || 0)) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // the heir that host named in its snapshots, which every guest saw alike;
    // else (an older host) people before bots, then the lowest id
    const heir = others.find((p) => p[0] === (sess.snap && sess.snap.h)) || others[0];
    const hostOwn = async (fresh) => {
      game.remote = null;
      game.players = [game.local];
      // (a fill-in bot is joinOnly, which the matchmaker would refuse a universe of its own)
      if (fresh) { mp.mm = new Matchmaker(); await mp.mm.play(playerName(), mp.mode, { ...(mp.botOpts || {}), joinOnly: false, hostOnly: true }); }
      await startHosting(false);
      L.gameScore = L.lastScore = keep.score; L.remainingShips = keep.pots; L.gameStartTime = keep.started;
      game.gameLevel = keep.level; game.initLevel();
      game.scoreMode = mp.mode;
      // the others may come to us: their places, as of the last snapshot
      for (const p of others) if (p[0] !== mp.mm.id && mp.session)
        mp.session.departed.set(p[0], { gameScore: p[2], remainingShips: p[3], slot: p[13], at: performance.now() });
      updateQueue();
      say(`${modeName()}: lost contact with ${lost}; playing on`);
    };
    if (!heir || heir[0] === sess.id || !mp.mm) { await hostOwn(false); return; }
    say(`${modeName()}: lost contact with ${lost}; regrouping with ${heir[1]}...`);
    note(`regrouping with ${heir[1]}`);
    // hold the last picture (no local ticks on the copies) while the heir sets up
    game.remote = { frame() {}, slotOf: () => 0, isBot: () => false, snap: sess.snap };
    game.players = [game.local];
    await sleep(2000);
    let ok = false;
    try { const r = await mp.mm.join(heir[0]); if (r) ok = await startGuest(r); } catch (e) { note('regroup: ' + e.message); }
    if (ok) return;
    note(`couldn't regroup with ${heir[1]}`);
    dropJoin();
    await hostOwn(true);
  }

  // Play solo and accept joiners
  async function startHosting(already) {
    if (!already) soloBegin();
    const t = new RTCTransport(mp.mm);
    mp.transport = t;
    mp.session = new Session(game, t, { role: 'host', id: mp.mm.id, name: playerName(), mode: mp.mode, hooks: hooks() });
    listenAsHost(t);
    reportGame();   // on the games list from the start
    t.onpeer = (id, st) => note(`peer ${id} ${st}`);
    t.onlog = (m) => note('rtc: ' + m);
    say(`${modeName()}: playing solo, waiting for a partner`);
  }

  // Join a host's universe.  While connecting, the status line counts down and
  // any key or tap gives up on this host (some networks can't reach each other:
  // no TURN relay yet); resolves false then, or after JOIN_TIMEOUT.
  function startGuest(r) {
    return new Promise((resolve) => {
      game.clearSprites();
      game.textSprites = [];
      game.initStatusDisplay();
      game.local.gameScore = 0;
      game.local.remainingShips = 3;
      game.local.gameStartTime = game.time;   // play time goes with the score (a guest skips beginGame)
      game.realSnd.play(SND.LevelCompletion);   // the fanfare, as beginGame plays it
      game.anim = null; game.cameraRoll = 0; game.fgAlpha = 1; game.visH = game.playVisH;
      game.setState(GS.Play);
      const t = new RTCTransport(mp.mm);
      t.onlog = (m) => note('rtc: ' + m);
      mp.transport = t;
      mp.partner = r.hostName || 'someone';
      say(`${modeName()}: joining ${mp.partner}...`);
      mp.mm.onevent = (e) => { if (e.k === 'signal') t.handleSignal(e.from, e.data); };
      mp.session = new Session(game, t, { role: 'guest', id: mp.mm.id, name: playerName(), mode: mp.mode, hooks: hooks() });
      const t0 = performance.now();
      mp.connecting = true; mp.bailed = false;
      let idle = false;   // the key that started the game may still be down: wait for a release first
      const show = () => {
        const left = Math.max(0, Math.ceil((JOIN_TIMEOUT - (performance.now() - t0)) / 1000));
        say(`${modeName()}: connecting to ${mp.partner}... ${left}  (${game.touchMode ? 'tap' : 'any key'}: play solo instead)`);
      };
      show();
      const done = (ok) => { clearTimeout(timer); clearInterval(check); mp.connecting = false; resolve(ok); };
      const timer = setTimeout(() => done(false), JOIN_TIMEOUT);
      const check = setInterval(() => {
        if (mp.session && mp.session.welcomed) { say(`${modeName()} with ${mp.partner}`); done(true); return; }
        // (a person's key or button; bots steer from the start and never mean it)
        if (!game.input.flags) idle = true;
        else if (idle && !game.local.bot && performance.now() - t0 > 500) mp.bailed = true;
        if (mp.bailed) { note('gave up waiting for ' + mp.partner); done(false); return; }
        show();
      }, 100);
    });
  }
  // any key or tap while connecting (main.js)
  mp.bailJoin = () => { if (mp.connecting) mp.bailed = true; };

  // give up on a join that didn't connect
  function dropJoin() {
    if (mp.session) { mp.session.hooks = {}; mp.session.end('timeout'); }
    if (mp.transport) mp.transport.close();
    mp.session = null; mp.transport = null;
    if (mp.mm) mp.mm.leave();
    mp.mm = null;
  }

  // replaces game.beginGame: every way of starting a game goes through here
  // Diagnostics for debugging real devices: the game's version, view and
  // connection notes, sent to the matchmaker's log (match.log on the server) a few
  // seconds after the universe changes and every 20 s while sharing it.
  mp.version = '?';
  fetch('version.json', { cache: 'no-store' }).then((r) => r.json()).then((v) => { mp.version = v.v; }).catch(() => {});
  mp.diag = (why) => {
    if (!mp.mm || !mp.mm.id) return;
    const L = game.local, s = mp.session;
    const r2 = (v) => (typeof v === 'number' ? Math.round(v) : v);
    const d = {
      id: mp.mm.id, why, v: mp.version, name: playerName(), mode: mp.mode, role: s ? s.role : null,
      state: game.state, cur: game.cur === L, touch: !!game.touchMode,
      view: [r2(game.cssW), r2(game.cssH), game.cw, game.ch, r2(game.visH)],
      me: L.ship ? [r2(L.ship.x), r2(L.ship.y), L.ship.type, L.ship.rotIdx] : null,
      off: [r2(L.offsetX), r2(L.offsetY)], pots: L.remainingShips, out: L.out, score: L.gameScore,
      players: game.remote ? (s && s.snap ? s.snap.players.map((p) => [p[1], p[3], p[7], p[8], p[14] || 0]) : 'no snapshot')
        : game.players.map((p) => [p.name, p.remainingShips, p.ship && p.ship.type === 1 ? 1 : 0, p.out ? 1 : 0, p.bot ? 1 : 0]),
      net: window.__mpDbg ? (() => { try { return window.__mpDbg(); } catch (e) { return String(e); } })() : null,
      notes: mp.log.slice(-25),
      ua: navigator.userAgent.slice(0, 120),
    };
    fetch('mm/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).catch(() => {});
  };
  setInterval(() => { if (mp.session && game.state === GS.Play && (game.players.length > 1 || game.remote)) mp.diag('periodic'); }, 20000);

  // A bell when a player arrives in the universe, a clunk when one leaves (or is out of pots)
  mp.roster = null;
  mp.checkRoster = () => {
    const s = mp.session;
    if (!s || game.state !== GS.Play) { mp.roster = null; return; }
    const ids = game.remote ? (s.snap ? s.snap.players.filter((p) => !p[8]).map((p) => p[0]) : null)
      : game.players.filter((p) => !p.out).map((p) => p.id);
    if (!ids) return;
    const now = new Set(ids);
    // a guest's status line follows who's here (the host's follows onPeers): it
    // named only the host it joined, so later arrivals went unmentioned
    const changed = !mp.roster || ids.length !== mp.roster.size || ids.some((id) => !mp.roster.has(id));
    if (changed && game.remote && s.snap && s.welcomed && !/^That game had closed/.test(mp.status)) {
      const others = s.snap.players.filter((p) => p[0] !== s.id && !p[8]).map((p) => p[1] || 'someone');
      if (others.length) { mp.partner = others.join(', '); say(`${modeName()} with ${mp.partner}`); }
    }
    if (mp.roster) {
      const joined = ids.some((id) => !mp.roster.has(id)), left = [...mp.roster].some((id) => !now.has(id));
      if (joined) game.snd.play(SND.Bell, 0.8);
      else if (left) game.snd.play(SND.Clunk, 0.9);
      if (joined || left) setTimeout(() => mp.diag(joined ? 'joined+3s' : 'left+3s'), 3000);
    }
    mp.roster = now;
  };

  // the name dialog (names.js), before the first game or from the mode bar
  mp.askName = () => {
    if (mp.naming || !ui.askName) return Promise.resolve(null);
    mp.naming = true;
    return ui.askName().finally(() => { mp.naming = false; });
  };

  game.beginGame = () => {
    if (mp.session || mp.starting || mp.naming) return;
    if (!String(game.nameBuf || '').trim() && ui.askName) {
      mp.askName().then((name) => { if (name) game.beginGame(); });
      return;
    }
    if (mp.mode === 'single') { mp.joinHost = null; mp.newGame = null; soloBegin(); return; }   // Solo: no matchmaker
    mp.starting = true;
    mp.bailed = false;
    // a game picked on the games list (games/?: Join): that universe first
    const wantHost = mp.joinHost;
    mp.joinHost = null;
    // a fresh game asked for on the games page (?new=): host it, with its settings
    const fresh = mp.newGame;
    mp.newGame = null;
    (async () => {
      try {
        // Ask the matchmaker; if the host it picks can't be reached, ask again
        // avoiding that host (another may be waiting); after a second miss, or
        // when the player gives up waiting, host our own universe instead.
        const avoid = [];
        for (let attempt = 0; ; attempt++) {
          const giveUp = attempt >= 2 || mp.bailed || !!fresh || !!(mp.botOpts && mp.botOpts.hostOnly);
          mp.mm = new Matchmaker();
          // max: we join only games no bigger than we like (and host one that size)
          const r = await mp.mm.play(playerName(), mp.mode, { max: modeMax(), ...(mp.botOpts || {}), avoid, hostOnly: giveUp,
            host: attempt === 0 && wantHost ? wantHost : undefined });
          const missed = r.wanted === false;
          if (missed) note('the game picked on the games list had closed');
          // (said after the status line settles)
          const sayMissed = () => { if (missed) say(`That game had closed: ${mp.status.replace(/^[^:]*: /, '').replace(/^\w/, (c) => c.toLowerCase())}`); };
          if (r.role === 'none') {
            // a fill-in bot (joinOnly) found nobody waiting: stay in attract
            note('nobody to join');
            mp.mm = null;
            mp.noHost = true;
            return;
          }
          if (r.role !== 'guest') {
            await startHosting();
            if (fresh && fresh.noBots) { game.noBots = true; reportGame(); }
            sayMissed();
            return;
          }
          if (await startGuest(r)) { sayMissed(); return; }
          note(`couldn't reach ${r.hostName || r.host}` + (mp.bailed ? ' (gave up)' : ''));
          dropJoin();
          if (mp.botOpts && mp.botOpts.joinOnly) { note('join timed out (join only)'); mp.noHost = true; return; }
          avoid.push(r.host);
        }
      } catch (e) {
        // no matchmaker (offline, local dev server): plain solo game
        note('matchmaker unavailable: ' + e.message);
        mp.mm = null;
        if (game.state !== GS.Play) soloBegin();
        say('');
      } finally {
        mp.starting = false;
      }
    })();
  };

  // A solo host that pauses (or hides its tab) isn't playable: out of the queue
  // until it resumes.  (With a partner there is no pause: main.js steps away.)
  mp.setPaused = (on) => {
    if (!mp.mm || !mp.session || mp.session.role !== 'host') return;
    if (on) mp.mm.busy(); else updateQueue();
  };

  // the local game ended with no partner around: leave the queue
  mp.gameOver = () => {
    if (mp.session) { mp.session.hooks = {}; mp.session.end('game-over'); }
    mp.session = null;
    if (mp.transport) mp.transport.close();
    mp.transport = null;
    if (mp.mm) mp.mm.leave();
    mp.mm = null;
    game.duel = false;
    game.netMode = null;
    say('');
  };

  // diagnostics for the bots (?agent&debug): transport and session state
  window.__mpDbg = () => {
    const t = mp.transport, s = mp.session;
    return {
      role: s && s.role, welcomed: s && s.welcomed, id: s && String(s.id).slice(0, 6),
      peers: t ? [...t.peers].map(([id, p]) => ({ id: String(id).slice(0, 6), u: p.u && p.u.readyState, r: p.r && p.r.readyState,
        open: p.open, ub: p.u && p.u.bufferedAmount, rb: p.r && p.r.bufferedAmount, conn: p.pc.connectionState, route: p.route })) : [],
      turn: !!(mp.mm && mp.mm.ice && mp.mm.ice.length > 1),
      heard: s ? [...s.lastHeard].map(([id, t]) => [String(id).slice(0, 6), Math.round(performance.now() - t)]) : [],
      lag: s && s.netStats ? s.netStats() : null,   // round trips, snapshot gaps and losses, prediction, KB/s (net.js)
    };
  };
  // the stats overlay's network lines, while in a shared universe
  game.netInfo = () => (mp.session && mp.session.statsLines && (game.remote || game.players.length > 1) ? mp.session.statsLines() : []);

  window.addEventListener('pagehide', () => { if (mp.mm) mp.mm.leave(); });
  return mp;
}
