// Multiplayer sessions (see MULTIPLAYER.md).  One browser is the HOST: it runs
// the real game for everyone, applies each guest's buttons to that guest's
// teapot, and sends a snapshot of the universe every tick.  A GUEST runs no
// simulation: it draws the latest snapshots (interpolated, like the normal
// renderer does between ticks) and sends its buttons.  When the host runs out
// of pots it hands the complete game state to a guest, which becomes the host
// of the same universe.
//
// Transports carry JSON messages and only need { send(obj), onmessage, close() }:
// LocalTransport (BroadcastChannel, for two tabs or two bots on one machine,
// with optional simulated lag and loss) and, in rtc.js, a WebRTC data channel.

import { Sprite, SDEF, steerBits, shipMotion, FIRING_POS } from './sprites.js';
import { Player } from './game.js';
import { encodeSnapshot, decodeSnapshot, isSnapshotBytes } from './wire.js';
import { ST, GS, TICK, KF, SF, SM, SND, BulletSpeed, Debounce, UziDebounce, kBulletLifeSpan, kMaxRotIdxAngles } from './constants.js';

const TICKMS = TICK * 1000;
// 2 (2026-10-09): numbered inputs (q), the host's events on the reliable
// channel, the input each guest is up to in the snapshot (prediction), and
// snapshots as bytes (wire.js)
const PROTO = 2;
// ?nopredict (testing, and to feel the difference): a guest draws its own
// teapot from the host's snapshots like everything else
const NOPREDICT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nopredict');
// sounds a predicting guest plays itself, when it steers and shoots
const PREDICTED_SOUNDS = new Set([SND.Thrust, SND.Shield, SND.POP, SND.Firing]);

const SPRITE_FIELDS = ['x', 'y', 'vx', 'vy', 'prevX', 'prevY', 'rad', 'collideRF', 'rotation', 'f1', 'f2',
  'state', 'state2', 'stateTimer', 'frameNbr', 'aniSpeed', 'aniDir', 'flags', 'targetFlags', 'maxHits',
  'hitsTaken', 'tickCtr', 'lifeSpan', 'rotIdx', 'visible', 'textureIndex', 'syOfs'];
const PLAYER_STATE = ['gameScore', 'remainingShips', 'lastScore', 'scoreMultiply', 'shieldPower', 'shipMode',
  'fireDelay', 'whorlPull', 'gameStartTime', 'offsetX', 'offsetY', 'message', 'spawnX', 'out', 'name', 'slot', 'bot', 'away'];
const GAME_STATE = ['gameLevel', 'gameClock', 'asteroidCnt', 'yummyCnt', 'minAsteroids', 'badGuyChance',
  'yummyChance', 'toasterChance', 'lastBestScore', 'noBots'];

let uidCounter = 0;
const uids = new WeakMap();
export const uidOf = (sp) => {
  let id = uids.get(sp);
  if (id === undefined) { id = ++uidCounter; uids.set(sp, id); }
  return id;
};

// ---------------------------------------------------------------- transports

export class LocalTransport {
  // opts: { lagMs, jitterMs, loss } simulate a network for testing
  constructor(channel, selfId, opts = {}) {
    this.bc = new BroadcastChannel('ct-mp-' + channel);
    this.selfId = selfId;
    this.opts = opts;
    this.onmessage = null;
    this.bc.onmessage = (e) => {
      const m = e.data;
      if (m.from === this.selfId || (m.to && (Array.isArray(m.to) ? !m.to.includes(this.selfId) : m.to !== this.selfId))) return;
      const { lagMs = 0, jitterMs = 0, loss = 0 } = this.opts;
      if (m.lossy && loss && Math.random() < loss) return;
      const deliver = () => this.onmessage && this.onmessage(m);
      if (lagMs || jitterMs) setTimeout(deliver, lagMs + Math.random() * jitterMs); else deliver();
    };
  }
  send(obj) { this.bc.postMessage({ ...obj, from: this.selfId }); }
  close() { this.bc.close(); }
}

// ---------------------------------------------------------------- serialization

function packSprite(sp) {
  return [uidOf(sp), sp.type, Math.round(sp.x * 10) / 10, Math.round(sp.y * 10) / 10,
    Math.round(sp.vx * 100) / 100, Math.round(sp.vy * 100) / 100, sp.frameNbr, Math.round(sp.rotation),
    Math.round((sp.rgba ? sp.rgba[3] : 1) * 100), sp.visible ? 1 : 0, sp.rad, sp.owner ? sp.owner.id : 0,
    sp.rotIdx, sp.state & 0x10 ? 1 : 0];
}

export function fullState(game) {
  const sprites = game.sprites.filter((sp) => sp.active).map((sp) => {
    const o = { uid: uidOf(sp), type: sp.type, owner: sp.owner ? sp.owner.id : 0, rgba: sp.rgba.slice() };
    for (const f of SPRITE_FIELDS) o[f] = sp[f];
    return o;
  });
  const players = game.players.map((p) => {
    const o = { id: p.id, ship: p.ship ? uidOf(p.ship) : 0, shield: p.shield ? uidOf(p.shield) : 0 };
    for (const f of PLAYER_STATE) o[f] = p[f];
    return o;
  });
  const g = {};
  for (const f of GAME_STATE) g[f] = game[f];
  return { g, sprites, players };
}

// Rebuild a running universe from fullState() (a guest taking over as host)
export function restoreState(game, st, localId) {
  const byUid = new Map();
  const players = st.players.map((o) => {
    const p = o.id === localId ? game.local : new Player(o.id, false);
    // (our own play clock stays ours: the old host's is another page's time)
    for (const f of PLAYER_STATE) if (!(o.id === localId && f === 'gameStartTime')) p[f] = o[f];
    p.local = o.id === localId;
    return p;
  });
  const pById = new Map(players.map((p) => [p.id, p]));
  game.sprites = st.sprites.map((o) => {
    const sp = new Sprite();
    sp.init(o.type, o.x, o.y, o.vx, o.vy, o.frameNbr, true);
    for (const f of SPRITE_FIELDS) sp[f] = o[f];
    sp.rgba = o.rgba.slice();
    sp.active = true;
    if (o.owner) sp.owner = pById.get(o.owner);
    if (sp.nbrFrames) sp.setFrameNbr(sp.frameNbr);
    byUid.set(o.uid, sp);
    uids.set(sp, o.uid);
    return sp;
  });
  game.spriteCnt = game.sprites.length;
  for (const o of st.players) {
    const p = pById.get(o.id);
    p.ship = byUid.get(o.ship) || null;
    p.shield = byUid.get(o.shield) || null;
  }
  for (const f of GAME_STATE) if (st.g[f] !== undefined) game[f] = st.g[f];
  game.players = players.filter((p) => !p.out || p.local);
  game.cur = game.local;
  game.prevOffX = game.offsetX;
  game.prevOffY = game.offsetY;
}

// ---------------------------------------------------------------- session

export class Session {
  // role: 'host' | 'guest'.  hooks: { onEnd(reason), onBecomeHost(), log(msg) }
  constructor(game, transport, { role, id, name = '', mode = 'coop', hooks = {} }) {
    this.game = game;
    this.t = transport;
    this.role = role;
    this.id = id;
    this.name = name;
    this.mode = mode;
    game.netMode = mode;
    this.hooks = hooks;
    this.lastHeard = new Map();   // peer id -> time
    this.departed = new Map();    // host: guests dropped for silence, kept for a while in case they come back
    this.toldDropped = new Map();
    this.events = [];
    this.seq = 0;                 // guest: our input ticks, numbered
    this.rtt = new Map();         // peer id -> round trip ms (pings on the reliable channel)
    this.gaps = []; this.misses = []; this.ticksGot = 0; this.ticksLost = 0; this.dry = 0;   // guest: lag stats
    this.t.onmessage = (m) => this.receive(m);
    game.duel = mode === 'duel' || mode === 'melee';   // melee: duel rules, up to 4
    game.local.id = id;
    game.local.name = name;
    if (role === 'host') this.startHost(); else this.startGuest();
    this.watchdog = setInterval(() => this.checkPeers(), 1000);
    this.pingTimer = setInterval(() => this.ping(), 1000);
  }

  log(msg) { this.hooks.log && this.hooks.log(`[${this.role} ${this.id}] ${msg}`); }

  // ---- lag stats: round trips, snapshot gaps and losses, traffic

  ping() {
    this.t.send({ k: 'ping', t: performance.now() });
    // traffic per second (RTCTransport counts bytes)
    const t = this.t, now = performance.now();
    if (t.bytesIn !== undefined) {
      if (this.rateAt) {
        const s = (now - this.rateAt) / 1000;
        this.rate = { inK: (t.bytesIn - this.rateIn) / 1024 / s, outK: (t.bytesOut - this.rateOut) / 1024 / s };
      }
      this.rateAt = now; this.rateIn = t.bytesIn; this.rateOut = t.bytesOut;
    }
  }

  netStats() {
    const pct = (a, q) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * q))]); };
    const peers = this.role === 'host' ? this.game.players.filter((p) => !p.local).map((p) => p.id) : [this.hostId];
    const rtt = peers.map((id) => this.rtt.get(id)).filter((x) => x != null).map(Math.round);
    const st = { rtt, kin: this.rate ? Math.round(this.rate.inK) : null, kout: this.rate ? Math.round(this.rate.outK) : null, skipped: this.t.skipped || 0, snapB: this.snapBytes || null };
    if (this.role === 'guest') {
      Object.assign(st, {
        gap50: pct(this.gaps, 0.5), gap95: pct(this.gaps, 0.95),
        lost: this.ticksGot + this.ticksLost ? Math.round(1000 * this.ticksLost / (this.ticksGot + this.ticksLost)) / 10 : 0,
        delay: Math.round(this.playDelay || 0), ahead: this.pred ? this.ahead : null, miss50: pct(this.misses, 0.5), miss95: pct(this.misses, 0.95), dry: this.dry,
      });
    }
    return st;
  }

  // for the stats overlay (backquote or ?stats)
  statsLines() {
    const n = this.netStats();
    const lines = ['net: ' + this.role + ', ping ' + (n.rtt.length ? n.rtt.join('/') + ' ms' : '?')];
    if (this.role === 'guest') {
      lines.push(`snaps: gap ${n.gap50}/${n.gap95}, lost ${n.lost}%, late ${n.delay}`);
      lines.push('predict: ' + (n.ahead == null ? 'off' : `${n.ahead} ahead, off ${n.miss50}/${n.miss95}`));
    }
    if (n.kin != null) lines.push(`KB/s: in ${n.kin}, out ${n.kout}` + (n.snapB ? `, snap ${n.snapB} B` : '') + (n.skipped ? `, ${n.skipped} skipped` : ''));
    return lines;
  }

  // ---- host

  startHost() {
    const g = this.game;
    g.onTickStart = () => this.applyInputs();
    g.onTickDone = () => this.broadcastSnapshot();
    g.onPlayerOut = (p) => this.playerOut(p);
    g.onSound = (id, p) => { this.events.push(['s', id, p && p.id || 0]); };
    g.onExplode = (sp) => {
      this.events.push(['x', sp.type, sp.textureID, sp.sx, sp.sy, sp.cell, Math.round(sp.x), Math.round(sp.y),
        sp.rad, Math.round(sp.rotation || 0), sp.syOfs || 0]);
    };
    g.onText = (x, y, str, flags) => { this.events.push(['t', Math.round(x), Math.round(y), str, flags]); };
    this.log('hosting');
  }

  playerById(id) { return this.game.players.find((p) => p.id === id); }

  broadcastSnapshot() {
    const g = this.game;
    if (g.players.length < 2 && !this.events.length) { this.events = []; return; }
    const players = g.players.map((p) => [p.id, p.name, p.gameScore, p.remainingShips, p.shieldPower, p.shipMode,
      p.ship ? uidOf(p.ship) : 0, p.ship && p.ship.active && p.ship.type === ST.Teapot ? 1 : 0, p.out ? 1 : 0,
      Math.round(p.offsetX), Math.round(p.offsetY), p.message || '', p.label || '', p.slot, p.bot ? 1 : 0, p.away ? 1 : 0,
      p.local ? 0 : p.inSeq || 0]);
    const sprites = [];
    for (const sp of g.sprites) if (sp.active && sp.nbrFrames) sprites.push(packSprite(sp));
    const snap = { k: 'snap', lossy: true, tick: g.gameClock, level: g.gameLevel, nb: g.noBots ? 1 : 0, h: this.currentHeir(), players, sprites };
    const ev = this.events;
    this.events = [];
    // the sounds, explosions and score popups go reliably (a lost snapshot
    // would lose them), except to guests from before 2026-10-09
    const now = [], old = [];
    for (const p of g.players) if (p !== g.local) (p.proto >= 2 ? now : old).push(p.id);
    if (now.length) {
      const bin = encodeSnapshot(snap, sprites);
      this.snapBytes = bin.byteLength;
      this.t.send({ k: 'snapb', lossy: true, to: now, bin });
      if (ev.length) this.t.send({ k: 'ev', to: now, tick: g.gameClock, ev });
    }
    if (old.length) this.t.send({ ...snap, to: old, ev });
  }

  // Each guest's inputs for this tick: the next of the numbered ones it sent,
  // one per tick, so none is skipped or used twice when they arrive bunched
  // up; nothing new, and its last input holds.  More than three waiting (a
  // burst after a stall) and we skip ahead, so its lag doesn't build up.
  applyInputs() {
    for (const p of this.game.players) {
      const q = p.inQ;
      if (!q || !q.size) continue;
      const seqs = [...q.keys()].sort((a, b) => a - b);
      const next = seqs[Math.max(0, seqs.length - 3)];
      const [f, d] = q.get(next);
      p.keyFlags = f; p.stickDir = d; p.inSeq = next;
      for (const k of seqs) if (k <= next) q.delete(k);
    }
  }

  // names are unique within a universe: a second "Ann" becomes "Ann 2"
  uniqueName(name) {
    const taken = new Set(this.game.players.map((q) => (q.name || '').toLowerCase()));
    if (!name || !taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
  }

  addGuest(id, name) {
    const known = this.playerById(id);
    if (known) {
      // already in this universe (e.g. it came with a handoff): just welcome it
      this.lastHeard.set(id, performance.now());
      this.t.send({ k: 'welcome', to: id, mode: this.mode, host: this.id, name: known.name, players: this.game.players.map((q) => [q.id, q.name]) });
      this.log(`${known.name || id} reconnected`);
      return known;
    }
    const p = this.game.addPlayer(id, this.uniqueName(name));
    const d = this.departed.get(id);
    if (d) {
      // back after being dropped for silence: its score, pots and color again
      this.departed.delete(id);
      p.gameScore = p.lastScore = d.gameScore;
      p.remainingShips = d.remainingShips;
      if (!this.game.players.some((q) => q !== p && q.slot === d.slot)) p.slot = d.slot;
    }
    this.lastHeard.set(id, performance.now());
    // (the welcome carries the name as made unique here, so chat says "Ann 2" too)
    this.t.send({ k: 'welcome', to: id, mode: this.mode, host: this.id, name: p.name, players: this.game.players.map((q) => [q.id, q.name]) });
    this.log(d ? `${p.name || id} is back` : `guest ${name || id} joined`);
    this.hooks.onPeers && this.hooks.onPeers(this.game.players.length);
    return p;
  }

  // The host is stepping away (tab hidden, app switched, pause pressed): a
  // shared universe can't wait, and a hidden page soon stops running (iOS
  // suspends it), so hand the universe to a guest (pickHeir) now and
  // carry on as its guest over the connection we already share.  If this page
  // doesn't come back, the new host drops it like any vanished guest.
  // Who gets the universe when the host leaves or steps away: a guest whose
  // connection is up and was heard from in the last 1.5 s (join order alone
  // could pick one that is 3.9 s from being dropped, and everyone would wait
  // 10 s for a host that never comes); of those, the shortest round trip
  // (it will be everyone's host: the best connected makes the least lag).
  pickHeir() {
    const g = this.game;
    const now = performance.now();
    const open = (id) => (this.t.peers ? !!(this.t.peers.get(id) || {}).open : true);
    const heard = (id) => Math.min(this.lastHeard.get(id) || 0, now);
    const fresh = (id) => (now - heard(id) < 1500 ? 1 : 0);
    const rtt = (id) => (this.rtt.has(id) ? this.rtt.get(id) : 1e4);
    return g.players.filter((q) => q !== g.local && !q.out)
      .sort((a, b) => (open(b.id) - open(a.id)) || (fresh(b.id) - fresh(a.id)) || (rtt(a.id) - rtt(b.id)) || (heard(b.id) - heard(a.id)))[0] || null;
  }

  // The heir named in every snapshot (h), so that if this host vanishes without
  // a word (or its handoff is lost with a closing page) every guest regroups
  // around the same player.  Stable: it changes only when the heir stops being
  // a good one (gone, out, or quiet for 2.5 s), so guests that missed a few
  // lossy snapshots still agree.
  currentHeir() {
    const g = this.game;
    const p = this.heirId && this.playerById(this.heirId);
    const fine = p && p !== g.local && !p.out && performance.now() - (this.lastHeard.get(p.id) || 0) < 2500;
    if (!fine) { const h = this.pickHeir(); this.heirId = h ? h.id : 0; }
    return this.heirId || 0;
  }

  stepDown(why = 'away') {
    const g = this.game;
    if (this.role !== 'host' || this.handedOff) return false;
    const heir = this.playerById(this.currentHeir());
    if (!heir) return false;
    const st = fullState(g);
    st.fromHost = this.id;
    st.hostStays = true;                 // keep our player (score, pots, teapot)
    const others = g.players.filter((q) => q !== g.local && q !== heir && !q.out).map((q) => q.id);
    // the small notices first (heir included), then the big handoff: on a page
    // that is closing, not everything gets out
    for (const id of [...others, heir.id]) this.t.send({ k: 'rehost', to: id, host: heir.id, hostName: heir.name });
    this.t.send({ k: 'handoff', to: heir.id, state: st, mode: this.mode, others });
    this.log(`stepping down (${why}): ${heir.name || heir.id} hosts now`);
    // become a guest of the heir
    g.onTickStart = g.onTickDone = g.onPlayerOut = g.onSound = g.onExplode = g.onText = null;
    g.input.releaseAll && g.input.releaseAll();
    g.players = [g.local];
    this.role = 'guest';
    this.hostId = heir.id;
    this.lastHeard.clear();
    this.lastHeard.set(heir.id, performance.now() + 6000);   // time to take over
    this.startGuest();
    this.hooks.onStepDown && this.hooks.onStepDown(heir.name);
    return true;
  }

  playerOut(p) {
    const g = this.game;
    this.log(`player ${p.name || p.id} is out of pots`);
    if (p === g.local) {
      // the host lost: hand the universe to its heir (currentHeir)
      const heir = this.playerById(this.currentHeir());
      if (heir) {
        const st = fullState(g);
        st.fromHost = this.id;
        st.players = st.players.filter((o) => o.id !== this.id);   // the old host leaves
        const others = g.players.filter((q) => q !== g.local && q !== heir && !q.out).map((q) => q.id);
        // everyone else: your new host is the heir (it will connect to you);
        // the small notices first (heir included), then the big handoff
        for (const id of [...others, heir.id]) this.t.send({ k: 'rehost', to: id, host: heir.id, hostName: heir.name });
        this.t.send({ k: 'handoff', to: heir.id, state: st, mode: this.mode, others });
        this.handedOff = true;
        this.log(`handing the universe to ${heir.name || heir.id}` + (others.length ? ` (with ${others.length} more)` : ''));
      }
      this.end('lost');
      return;
    }
    this.t.send({ k: 'out', to: p.id, score: p.gameScore });
    g.removePlayer(p);
    this.hooks.onPeers && this.hooks.onPeers(g.players.length);
  }

  // A guest is sending inputs for a player we no longer have (dropped for
  // silence while its page was throttled or asleep): tell it, so it asks to be
  // let back in instead of watching a universe it isn't in.
  tellDropped(id) {
    const now = performance.now();
    if (now - (this.toldDropped.get(id) || 0) < 2000) return;
    this.toldDropped.set(id, now);
    this.t.send({ k: 'dropped', to: id });
  }

  // ---- guest
  //
  // A guest draws the universe a little in the past and its own teapot in the
  // present.  Snapshots wait in a playout buffer and are shown about one tick
  // plus the network's jitter behind the newest (playDelay), interpolated by
  // time, so one late or lost snapshot costs nothing; when the buffer runs
  // dry, things carry on along their velocity for up to 3 ticks.  Our own
  // teapot (and with it the camera, our bullets and their sounds) is
  // predicted: every tick of our own we run its motion (shipMotion, the same
  // code the host runs) from our inputs, keep them numbered (hist), and send
  // the last few.  The host applies one input per tick and says which it got
  // to (players[16]); each new snapshot we start from the host's teapot,
  // replay the inputs it hasn't seen yet, and fade out whatever difference is
  // left (err) instead of jumping.  Collisions, deaths, scores and everything
  // else stay the host's.

  startGuest() {
    const g = this.game;
    this.snap = null;          // the newest snapshot
    this.buf = [];             // snapshots waiting to be shown, oldest first
    this.cur = null;           // the one being shown
    this.shown = [];           // [sprite, record] for this.cur
    this.arrivals = [];        // [time, time - tick * TICKMS]: the host's clock as seen here
    this.renderTick = null;    // the host tick being drawn (fractional)
    this.playDelay = TICKMS * 2;
    this.evQ = [];             // [tick, event] waiting for their snapshot to be shown
    this.spritesByUid = new Map();
    this.pred = null;          // our teapot, predicted: { uid, x, y, vx, vy, rotIdx, state, state2, frameNbr }
    this.hold = null;          // where we last drew it, while the host's picture catches up with its end
    this.err = { x: 0, y: 0 }; // the prediction's last miss, fading out
    this.hist = [];            // [seq, flags, stickDir] of our recent ticks
    this.predBullets = [];     // shots we fired that the host's picture doesn't show yet
    this.fireDelay = 0;
    this.live = 0;             // our teapot's state bits last tick (for the start/stop sounds)
    this.tickAcc = 0;
    g.remote = this;
    // inputs go out with our own ticks (frame); this keeps them coming when the
    // page draws no frames (hidden, or frozen for a moment)
    this.sendInputTimer = setInterval(() => { if (performance.now() - (this.lastInputAt || 0) > 200) this.sendInput(); }, 250);
    this.welcomed = false;   // (a former guest that became host and is stepping down was welcomed long ago)
    this.startHello();
    this.log('joining');
  }

  // Ask the host to let us in, every half second until it welcomes us.  After
  // being dropped, a hidden page doesn't ask (it would only be dropped again
  // for silence); it asks as soon as it is visible.
  startHello() {
    clearInterval(this.helloTimer);
    const g = this.game;
    const hello = () => {
      if (this.welcomed || (this.dropped && typeof document !== 'undefined' && document.hidden)) return;
      // (to the host we're following, when we know it: after a handoff the old
      // host's connection may still be open for a moment)
      this.t.send({ k: 'hello', to: this.hostId || undefined, id: this.id, name: this.name, mode: this.mode, kick: g.local.kick || 0, bot: !!g.local.bot, p: PROTO });
    };
    hello();
    this.helloTimer = setInterval(hello, 500);
  }

  // our page is hidden, or we paused or are in the settings (the host freezes our teapot until we're back)
  isAway() { return (typeof document !== 'undefined' && document.hidden) || !!this.game.local.wantAway; }

  sendInput() {
    if (this.role !== 'guest' || !this.welcomed) return;
    const g = this.game;
    // q: our last few ticks' inputs, numbered (any one message that gets
    // through fills the gaps); f, d: the newest, for hosts from before 2026-10-09
    const q = this.hist.slice(-4);
    const last = q[q.length - 1];
    this.t.send({ k: 'in', lossy: true, id: this.id, q, f: last ? last[1] : g.input.flags, d: last ? last[2] : g.local.stickDir,
      a: g.local.label || '', w: this.isAway() ? 1 : 0 });
    this.lastInputAt = performance.now();
  }

  // called by Game.frame for a guest instead of running ticks
  frame(dt) {
    // our own ticks: inputs out, our teapot moved
    this.tickAcc += dt;
    let n = 0;
    while (this.tickAcc >= TICK && n++ < 5) { this.tickAcc -= TICK; this.guestTick(); }
    if (this.tickAcc >= TICK) this.tickAcc = 0;
    this.present(dt);
  }

  guestTick() {
    const g = this.game;
    const away = this.isAway();
    const f = away ? 0 : g.input.flags, d = away ? -1 : g.local.stickDir;
    this.hist.push([++this.seq, f, d]);
    if (this.hist.length > 60) this.hist.shift();
    if (this.pred) this.predictStep(this.pred, f, d, away, true);
    for (const b of this.predBullets) { b.x += b.vx; b.y += b.vy; b.age++; g.bindToUniverseTorus(b); }
    this.predBullets = this.predBullets.filter((b) => b.age < kBulletLifeSpan);
    this.sendInput();
  }

  // One tick of our teapot, as the host's shipMove does it (live: this tick,
  // with sounds and shots; otherwise a replay of one the host hasn't seen)
  predictStep(s, f, d, away, live) {
    const g = this.game, L = g.local;
    s.state = steerBits(s.rotIdx, f, d);
    shipMotion(s, away);
    g.bindToUniverseTorus(s);
    if (!live) return;
    const shieldOn = (f & KF.Shield && L.shieldPower > 0) || (L.shipMode & SM.AutoShield);
    if (s.state & SF.Thrust && !(this.live & SF.Thrust)) g.realSnd.play(SND.Thrust);
    if (shieldOn && !(this.live & SF.Shield)) g.realSnd.play(SND.Shield);
    else if (!shieldOn && this.live & SF.Shield) g.realSnd.play(SND.POP);
    this.live = s.state | (shieldOn ? SF.Shield : 0);
    let fire = false;
    if (f & KF.Fire) {
      if (this.fireDelay === 0) { fire = true; this.fireDelay = (L.shipMode & SM.Uzi) ? UziDebounce : Debounce; } else this.fireDelay--;
    } else if (this.fireDelay) this.fireDelay--;
    if (fire) {
      const vt = g.vecTable, fp = FIRING_POS[s.frameNbr & 15];
      const type = (L.shipMode & SM.CreamBullet) ? ST.CreamBullet : ST.Bullet;
      const shot = (idx) => {
        const b = new Sprite();
        b.init(type, s.x + fp[0], s.y + fp[1], s.vx + vt[idx].x * BulletSpeed, s.vy + vt[idx].y * BulletSpeed, 0, true);
        b.age = 0;
        this.predBullets.push(b);
      };
      shot(s.rotIdx);
      if (L.shipMode & SM.Triple) { shot((s.rotIdx + kMaxRotIdxAngles - 1) % kMaxRotIdxAngles); shot((s.rotIdx + 1) % kMaxRotIdxAngles); }
      g.realSnd.play(SND.Firing);
    }
  }

  // a snapshot arrived: into the playout buffer (in tick order: the lossy
  // channel can reorder); the newest also updates our prediction and the HUD
  receiveSnapshot(m) {
    const g = this.game;
    const now = performance.now();
    if (this.snapFrom && m.from !== this.snapFrom) {
      // a new host (a handoff): its clock is another page's
      this.buf = []; this.cur = null; this.arrivals = []; this.renderTick = null; this.lastSnapTick = null;
    }
    this.snapFrom = m.from;   // (the host these came from: regrouping leaves it out)
    m.byUid = new Map();
    for (const a of m.sprites) m.byUid.set(a[0], a);
    for (const e of m.ev || []) this.queueEvent(m.tick, e);   // (hosts from before 2026-10-09 send them here)
    const newest = !this.snap || this.snap.from !== m.from || m.tick > this.snap.tick;
    if (!this.cur || m.tick > this.cur.tick) {
      let i = this.buf.length;
      while (i && this.buf[i - 1].tick > m.tick) i--;
      if (!(i && this.buf[i - 1].tick === m.tick)) this.buf.splice(i, 0, m);
    }
    if (!newest) return;

    // the host's clock: the earliest arrivals of the last 3 s are the least
    // delayed; how much later the rest come is the jitter we wait out
    this.arrivals.push([now, now - m.tick * TICKMS]);
    while (this.arrivals.length && now - this.arrivals[0][0] > 3000) this.arrivals.shift();
    const offs = this.arrivals.map((a) => a[1]).sort((a, b) => a - b);
    this.clockBase = offs[0];
    this.playDelay = Math.max(TICKMS + 10, Math.min(250, TICKMS + 10 + offs[Math.floor(offs.length * 0.9)] - offs[0]));
    // snapshot gaps and lost ticks, for the stats
    if (this.snapTime) {
      const gap = now - this.snapTime;
      this.gaps.push(gap);
      if (this.gaps.length > 100) this.gaps.shift();
      this.gapMax = Math.max(this.gapMax || 0, gap);
      if (gap > 1000) this.stalls = (this.stalls || 0) + 1;
    }
    if (this.lastSnapTick != null && m.tick > this.lastSnapTick) {
      this.ticksGot++;
      this.ticksLost += Math.min(20, m.tick - this.lastSnapTick - 1);
    }
    this.lastSnapTick = m.tick;
    this.snapTime = now;

    if (this.snap && !!m.nb !== !!this.snap.nb) this.hooks.onNoBots && this.hooks.onNoBots(!!m.nb, '');
    this.snap = m;
    const me = m.players.find((p) => p[0] === this.id);
    this.others = m.players.filter((p) => p[0] !== this.id);
    if (me) {
      const [, , score, pots, shield, mode, , alive, , , , msg] = me;
      const L = g.local;
      const old = L.gameScore;
      L.gameScore = score;
      if (score !== old) g.beginScoreAnimation(old, score);
      L.remainingShips = pots; L.shieldPower = shield; L.shipMode = mode; L.message = msg;
      L.alive = !!alive;
    }
    this.reconcile(me, m);
  }

  // Start our teapot again from the host's, plus the inputs it hasn't applied
  reconcile(me, m) {
    const g = this.game;
    const ack = me && me[16];
    const rec = me && me[7] && m.byUid.get(me[6]);
    if (!ack || !rec || rec[1] !== ST.Teapot || NOPREDICT) {
      // not predicting (no teapot flying, or a host from before 2026-10-09):
      // if we were, hold our teapot where it was until the picture catches up
      if (this.pred) this.hold = { uid: this.pred.uid, x: this.pred.x + this.err.x, y: this.pred.y + this.err.y, rotIdx: this.pred.rotIdx, frameNbr: this.pred.frameNbr };
      this.pred = null;
      return;
    }
    const s = { uid: rec[0], x: rec[2], y: rec[3], vx: rec[4], vy: rec[5], rotIdx: rec[12], state: 0, state2: Math.floor(rec[6] / 16) % 4, frameNbr: rec[6] };
    const away = this.isAway();
    for (const [seq, f, d] of this.hist) if (seq > ack) this.predictStep(s, f, d, away, false);
    this.ahead = this.seq - ack;
    if (this.pred && this.pred.uid === s.uid) {
      // what we drew a moment ago stays put; the difference fades out (present)
      const e = { x: this.pred.x + this.err.x - s.x, y: this.pred.y + this.err.y - s.y };
      g.bindToUniverseTorus(e);
      const miss = { x: this.pred.x - s.x, y: this.pred.y - s.y };   // (how far off the prediction was)
      g.bindToUniverseTorus(miss);
      this.misses.push(Math.hypot(miss.x, miss.y));
      if (this.misses.length > 100) this.misses.shift();
      this.err = Math.hypot(e.x, e.y) < 150 ? e : { x: 0, y: 0 };
    } else {
      this.err = { x: 0, y: 0 };
      this.fireDelay = 0;
    }
    this.pred = s;
    this.hold = null;
  }

  queueEvent(tick, e) {
    if (this.cur && tick <= this.cur.tick) { this.playEvent(e); return; }   // (its moment is already on screen)
    let i = this.evQ.length;
    while (i && this.evQ[i - 1][0] > tick) i--;
    this.evQ.splice(i, 0, [tick, e]);
  }

  // Draw the buffered universe at renderTick, and our teapot where we predict it
  present(dt) {
    const g = this.game, L = g.local;
    const now = performance.now();
    if (!this.buf.length) { g.acc = 0; return; }
    const target = (now - this.clockBase - this.playDelay) / TICKMS;
    if (this.renderTick == null || Math.abs(target - this.renderTick) > 4) this.renderTick = target;
    else this.renderTick += dt / TICK + (target - this.renderTick) * Math.min(1, dt * 2);
    let i = 0;
    while (i + 1 < this.buf.length && this.buf[i + 1].tick <= this.renderTick) i++;
    if (i) this.buf.splice(0, i);
    const A = this.buf[0], B = this.buf[1] || null;
    if (A !== this.cur) this.showSnapshot(A);
    const t = this.renderTick - A.tick;   // ticks past A
    const frac = B ? Math.max(0, Math.min(1, t / (B.tick - A.tick))) : 0;
    const ext = B ? 0 : Math.max(0, Math.min(3, t));
    if (!B && t > 0.5) this.dry++;
    g.acc = Math.max(0, Math.min(0.999, t)) * TICK;   // (sparks, stepped per snapshot, still interpolate by it)
    const W = g.univWidth, H = g.univHeight, RX = g.univRadX, RY = g.univRadY;
    const wrapX = (x) => (x < -RX ? x + W : x > RX ? x - W : x), wrapY = (y) => (y < -RY ? y + H : y > RY ? y - H : y);
    const along = (a, b, k) => {
      let dx = b - a;
      if (dx > RX) dx -= W; else if (dx < -RX) dx += W;
      return a + dx * k;
    };
    const lead = this.pred ? this.ahead || 0 : 0;
    for (const [sp, a] of this.shown) {
      const b = B && B.byUid.get(a[0]);
      let x, y;
      if (b && b[1] === a[1]) {
        let dy = b[3] - a[3];
        if (dy > RY) dy -= H; else if (dy < -RY) dy += H;
        x = along(a[2], b[2], frac); y = a[3] + dy * frac;
      } else { x = a[2] + a[4] * ext; y = a[3] + a[5] * ext; }
      // our shots fly with our teapot, in the present, then ease back into the
      // host's timeline over 10 ticks (they'd fly through what they hit otherwise)
      if (sp.ownerId === this.id && (a[1] === ST.Bullet || a[1] === ST.CreamBullet)) {
        const k = lead * Math.max(0, 1 - (this.renderTick - sp.seenAt) / 10);
        x += a[4] * k; y += a[5] * k;
      }
      sp.x = sp.prevX = wrapX(x); sp.y = sp.prevY = wrapY(y);
    }

    // our teapot
    const fade = Math.exp(-dt / 0.12);
    this.err.x *= fade; this.err.y *= fade;
    let own = null;
    if (this.pred) {
      const s = this.pred;
      own = this.spritesByUid.get(s.uid);
      if (!own) {   // (it's newer than the snapshot on screen: a teapot that just appeared)
        own = new Sprite();
        own.init(ST.Teapot, s.x, s.y, s.vx, s.vy, 0, true);
        own.ownerId = this.id;
        this.spritesByUid.set(s.uid, own);
      }
      if (!g.sprites.includes(own)) g.sprites.push(own);
      own.x = own.prevX = wrapX(s.x + this.err.x); own.y = own.prevY = wrapY(s.y + this.err.y);
      own.vx = s.vx; own.vy = s.vy; own.rotIdx = s.rotIdx; own.setFrameNbr(s.frameNbr % own.nbrFrames); own.visible = true;
    } else if (this.hold && this.spritesByUid.has(this.hold.uid) && A.byUid.has(this.hold.uid)) {
      own = this.spritesByUid.get(this.hold.uid);
      own.x = own.prevX = this.hold.x; own.y = own.prevY = this.hold.y; own.rotIdx = this.hold.rotIdx;
      own.setFrameNbr(this.hold.frameNbr % own.nbrFrames);
    } else this.hold = null;
    const meA = A.players.find((p) => p[0] === this.id);
    if (!own && meA && meA[7]) own = this.spritesByUid.get(meA[6]) || null;
    L.ship = own;
    L.shield = null;
    for (const [sp] of this.shown) if (sp.type === ST.Shield && sp.ownerId === this.id) L.shield = sp;
    if (L.shield && own && (this.pred || this.hold)) {
      L.shield.x = L.shield.prevX = own.x; L.shield.y = L.shield.prevY = own.y;
      if (this.pred) L.shield.visible = !!(this.live & SF.Shield);
    }
    // our shots the host's picture doesn't have yet
    for (const pb of this.predBullets) { pb.prevX = pb.x; pb.prevY = pb.y; if (!g.sprites.includes(pb)) g.sprites.push(pb); }

    // the camera: on our teapot when we predict it, else the host's (interpolated)
    let ox, oy;
    if (own && (this.pred || this.hold)) { ox = own.x; oy = own.y; }
    else if (meA) {
      const meB = B && B.players.find((p) => p[0] === this.id);
      ox = meA[9]; oy = meA[10];
      if (meB) {
        ox = wrapX(along(meA[9], meB[9], frac));
        let dy = meB[10] - meA[10];
        if (dy > RY) dy -= H; else if (dy < -RY) dy += H;
        oy = wrapY(meA[10] + dy * frac);
      }
    }
    if (ox !== undefined) {
      // across the universe's edge: the stars come along (the host does this in bindShipToUniverseTorus)
      const jx = ox - L.offsetX, jy = oy - L.offsetY;
      if (Math.abs(jx) > RX) g.stars.wrap(jx > 0 ? W : -W, 0);
      if (Math.abs(jy) > RY) g.stars.wrap(0, jy > 0 ? H : -H);
      L.offsetX = L.prevOffX = ox; L.offsetY = L.prevOffY = oy;
    }
  }

  // A buffered snapshot's moment has come: its sprites, events, sparks
  showSnapshot(A) {
    const g = this.game;
    const prev = this.cur;
    // explosion sparks are local: step them once per host tick (catching up a few)
    const steps = prev ? Math.max(0, Math.min(5, A.tick - prev.tick)) : 1;
    for (let i = 0; i < steps; i++) g.sparks.update((x) => g.bindXToPlayer(x), (y) => g.bindYToPlayer(y));
    g.updateTextSprites();   // (score popups: without this a guest showed 32 and no more)
    g.gameClock = A.tick;
    g.gameLevel = A.level;
    this.cur = A;
    while (this.evQ.length && this.evQ[0][0] <= A.tick) this.playEvent(this.evQ.shift()[1]);
    const seen = new Set();
    const list = [], shown = [];
    for (const a of A.sprites) {
      const [uid, type, x, y, vx, vy, frame, rot, alpha, vis, rad, owner, rotIdx, shielded] = a;
      let sp = this.spritesByUid.get(uid);
      if (!sp || sp.type !== type) {
        sp = new Sprite();
        sp.init(type, x, y, vx, vy, 0, true);
        this.spritesByUid.set(uid, sp);
        sp.uid = uid;
        sp.seenAt = A.tick;
        // one of our shots: the predicted one it replaces goes
        if (owner === this.id && (type === ST.Bullet || type === ST.CreamBullet)) this.claimShot(sp, x + vx * (this.ahead || 0), y + vy * (this.ahead || 0));
      }
      sp.vx = vx; sp.vy = vy;
      if (sp.nbrFrames) sp.setFrameNbr(frame % sp.nbrFrames);
      sp.rotation = rot; sp.rgba[3] = alpha / 100; sp.visible = !!vis; sp.rad = rad;
      sp.rotIdx = rotIdx; sp.ownerId = owner; sp.state = shielded ? 0x10 : 0;
      sp.active = true;
      seen.add(uid);
      list.push(sp);
      shown.push([sp, a]);
    }
    for (const [uid] of this.spritesByUid) if (!seen.has(uid) && !(this.pred && this.pred.uid === uid)) this.spritesByUid.delete(uid);
    g.sprites = list;
    g.spriteCnt = list.length;
    this.shown = shown;
  }

  // the host's version of a shot we predicted has reached the screen: drop
  // ours (the nearest, if it's anywhere near; else the oldest)
  claimShot(sp, x, y) {
    let best = -1, bestD = 120;
    this.predBullets.forEach((b, i) => {
      const d = { x: b.x - x, y: b.y - y };
      this.game.bindToUniverseTorus(d);
      const dd = Math.hypot(d.x, d.y);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (best < 0 && this.predBullets.length) best = 0;
    if (best >= 0) this.predBullets.splice(best, 1);
  }

  playEvent(e) {
    const g = this.game;
    if (e[0] === 's') {
      const [, id, pid] = e;
      if (pid === this.id) {
        // (the sounds of our own steering and shooting played when we did it)
        if (!(this.pred && PREDICTED_SOUNDS.has(id))) g.realSnd.play(id);
      } else if (pid && g.local.ship) {
        const p = this.snap && this.snap.players.find((q) => q[0] === pid);
        if (p) {
          const u = { x: 0, y: 0 };
          const d = g.distanceToPoint(p[9], p[10], g.local.offsetX, g.local.offsetY, u, null);
          g.realSnd.playFrom(id, d, -u.x, g);
        }
      } else g.realSnd.play(id, 0.5);
    } else if (e[0] === 'x') {
      const [, type, textureID, sx, sy, cell, x, y, rad, rotation, syOfs] = e;
      g.sparks.explode({ x, y, vx: 0, vy: 0, rad, rotation, sx, sy, cell, syOfs, def: SDEF[type] },
        g.textures[textureID].image, 30, g.vecTable);
    } else if (e[0] === 't') {
      const [, x, y, str, flags] = e;
      g.addTextSprite(x, y, str, flags);
    }
  }

  // ---- "no bots" for this universe (any person in it may set it; mp.js)

  // host: set it (by = the player who asked); bots already here are sent home
  setNoBots(on, by) {
    const g = this.game;
    if (by && by.bot) return;
    g.noBots = !!on;
    if (on) for (const p of g.players.filter((q) => q.bot && q !== g.local)) {
      this.log(`sending ${p.name || p.id} home (no bots)`);
      this.t.send({ k: 'out', to: p.id, score: p.gameScore, why: 'no-bots' });
      g.removePlayer(p);
    }
    this.log(`${by ? by.name || by.id : 'someone'} turned bots ${on ? 'off' : 'on'}`);
    this.hooks.onPeers && this.hooks.onPeers(g.players.length);
    this.hooks.onNoBots && this.hooks.onNoBots(!!on, by && by !== g.local ? by.name : 'you');
  }

  // guest: ask the host to set it
  sendNoBots(on) { this.t.send({ k: 'nobots', on: !!on }); }

  // ---- chat (reliable channel; the host relays between guests)

  sendChat(text) {
    const msg = { k: 'chat', id: this.id, name: this.name, text: String(text).slice(0, 100) };
    this.hooks.onChat && this.hooks.onChat(msg.id, msg.name, msg.text);
    this.t.send(msg);
  }

  // where a player's teapot is (world units), for chat balloons
  // Where a player's teapot is drawn this frame (name tags, chat balloons):
  // interpolated between ticks with the frame's lerp, exactly as drawSprite
  // does, so a tag rides along with the teapot instead of stepping 20 times a
  // second (it jittered against fast-moving teapots).
  positionOf(id, lerp = 1) {
    const g = this.game;
    let sp = null;
    if (id === this.id) sp = g.local.ship;
    else if (this.role === 'host') { const p = this.playerById(id); sp = p && p.ship; }
    else {
      const o = this.others && this.others.find((q) => q[0] === id);
      if (!o) return null;
      sp = this.spritesByUid && this.spritesByUid.get(o[6]);
      if (!sp) return { x: o[9], y: o[10] };   // not in this snapshot: the camera spot
    }
    if (!sp) return null;
    let x = sp.x, y = sp.y;
    if (lerp < 1 && sp.prevX !== undefined) {
      const dx = x - sp.prevX, dy = y - sp.prevY;
      if (Math.abs(dx) < g.univRadX && Math.abs(dy) < g.univRadY) { x = sp.prevX + dx * lerp; y = sp.prevY + dy * lerp; }
    }
    return { x, y };
  }

  // guest: a player's color slot and bot flag, from the latest snapshot
  playerInfo(id) { return (this.snap && this.snap.players.find((q) => q[0] === id)) || null; }
  slotOf(id) { const p = this.playerInfo(id); return p ? p[13] || 0 : 0; }
  isBot(id) { const p = this.playerInfo(id); return !!(p && p[14]); }

  // ---- both

  receive(m) {
    if (this.ended) return;   // (an old host's connection stays open a moment after a handoff)
    // a guest only listens for its host's heartbeat and welcome; other peers (an
    // old host saying goodbye after a handoff) don't count
    if (m.from && this.role === 'guest' && m.k === 'welcome') {
      if (this.hostId && m.from !== this.hostId) return;
      this.hostId = m.host;
    }
    if (m.k === 'chat') {
      const id = m.id || m.from;
      this.hooks.onChat && this.hooks.onChat(id, m.name, m.text);
      // host passes a guest's message on to the other guests
      if (this.role === 'host') {
        for (const p of this.game.players)
          if (p !== this.game.local && p.id !== m.from) this.t.send({ k: 'chat', to: p.id, id, name: m.name, text: m.text });
      }
      return;
    }
    // (pings don't count as a sign of life: a host whose game has stopped,
    // hidden or stuck, still answers them from its timers)
    if (m.k === 'ping') { this.t.send({ k: 'pong', to: m.from, t: m.t }); return; }
    if (m.k === 'pong') {
      const ms = performance.now() - m.t, was = this.rtt.get(m.from);
      this.rtt.set(m.from, was == null ? ms : was * 0.7 + ms * 0.3);
      return;
    }
    if (m.from && (this.role === 'host' || !this.hostId || m.from === this.hostId)) this.lastHeard.set(m.from, performance.now());
    const g = this.game;
    if (this.role === 'host') {
      if (m.k === 'hello') {
        const p = this.addGuest(m.from, m.name);
        if (p && m.kick) p.kick = m.kick;
        if (p && m.bot) p.bot = true;
        if (p) p.proto = m.p || 1;
      } else if (m.k === 'in') {
        const p = this.playerById(m.from);
        if (p) {
          if (Array.isArray(m.q) && m.q.length) {
            // numbered inputs (applyInputs takes them one a tick)
            p.proto = Math.max(p.proto || 0, 2);
            if (!p.inQ) p.inQ = new Map();
            const first = m.q[0][0];
            if (p.inSeq == null || first < p.inSeq - 200) p.inSeq = first - 1;   // (new, or its count started over)
            for (const [sq, f, d] of m.q) if (sq > p.inSeq && !p.inQ.has(sq)) p.inQ.set(sq, [f, typeof d === 'number' ? d : -1]);
          } else { p.keyFlags = m.f; p.stickDir = typeof m.d === 'number' ? m.d : -1; }
          p.label = m.a;
          if (!!m.w !== !!p.away) { if (m.w) g.freezePlayer(p); else g.unfreezePlayer(p); this.log(`${p.name || m.from} is ${m.w ? 'paused' : 'back'}`); }
        } else this.tellDropped(m.from);
      } else if (m.k === 'nobots') {
        const p = this.playerById(m.from);
        if (p && !p.bot) this.setNoBots(!!m.on, p);
      } else if (m.k === 'bye') {
        const p = this.playerById(m.from);
        if (p) { g.removePlayer(p); this.hooks.onPeers && this.hooks.onPeers(g.players.length); }
      }
    } else {
      if (m.k === 'snap') this.receiveSnapshot(m);
      else if (m.k === 'snapb') {
        if (!isSnapshotBytes(m.bin)) return;
        const d = decodeSnapshot(m.bin);
        this.snapBytes = m.bin.byteLength;
        d.from = m.from;
        this.receiveSnapshot(d);
      }
      else if (m.k === 'ev') { if (m.from === this.snapFrom || !this.snapFrom) for (const e of m.ev) this.queueEvent(m.tick, e); }
      else if (m.k === 'welcome') {
        this.welcomed = true; clearInterval(this.helloTimer);
        if (m.name) { this.name = m.name; g.local.name = m.name; }
        this.log(this.dropped ? `back in ${m.host}'s universe` : `joined ${m.host}'s universe`);
        this.dropped = false;
        this.hooks.onWelcome && this.hooks.onWelcome(m.host);
      } else if (m.k === 'dropped') {
        // the host dropped us for silence (a throttled or sleeping page): ask back in
        if (this.welcomed) {
          this.welcomed = false; this.dropped = true;
          this.log('dropped by the host for silence; asking back in');
          this.startHello();
          this.hooks.onDropped && this.hooks.onDropped();
        }
      } else if (m.k === 'out') { this.log('out of pots'); this.end('lost'); }
      else if (m.k === 'handoff') this.becomeHost(m.state, m.others || []);
      else if (m.k === 'rehost') {
        // naming us: we're the heir and the handoff follows (if it never comes,
        // the old host's silence ends this session and we host the regroup)
        if (m.host === this.id) this.log('named heir; waiting for the handoff');
        else this.followNewHost(m.host, m.hostName);
      }
    }
  }

  // the host ran out of pots and handed the universe to another guest:
  // stop listening for the old host and say hello to the new one
  followNewHost(hostId, hostName) {
    this.hostId = hostId;
    for (const id of [...this.lastHeard.keys()]) if (id !== hostId) this.lastHeard.delete(id);
    this.lastHeard.set(hostId, performance.now() + 6000);   // allow time to connect
    this.welcomed = false;
    this.startHello();
    this.log(`following the universe to ${hostName || hostId}`);
    this.hooks.onRehost && this.hooks.onRehost(hostId, hostName);
  }

  becomeHost(state, others = []) {
    const g = this.game;
    clearInterval(this.sendInputTimer);
    g.remote = null;
    restoreState(g, state, this.id);
    // drop the old host (it's out), unless it only stepped away (stepDown): then
    // it stays as a guest, with a few seconds' grace to start sending input
    if (!state.hostStays) g.players = g.players.filter((p) => p.local || p.id !== state.fromHost);
    else {
      const old = g.players.find((p) => p.id === state.fromHost);
      if (old) old.keyFlags = 0;
      others = [...others, state.fromHost];
    }
    this.role = 'host';
    this.startHost();
    this.log('took over the universe' + (others.length ? `, ${others.length} more to reconnect` : ''));
    for (const id of others) this.lastHeard.set(id, performance.now() + 6000);
    // the old host is already connected to us: no new connection for it
    this.hooks.onBecomeHost && this.hooks.onBecomeHost(others.filter((id) => id !== state.fromHost || !state.hostStays));
  }

  checkPeers() {
    const now = performance.now();
    const g = this.game;
    for (const [id, t] of this.lastHeard) {
      if (now - t < 4000) continue;
      if (this.role === 'guest' && this.hostId && id !== this.hostId) { this.lastHeard.delete(id); continue; }
      this.lastHeard.delete(id);
      if (this.role === 'host') {
        const p = this.playerById(id);
        if (p) {
          this.log(`lost contact with ${p.name || id}`);
          // keep its place for a while: a page that was only throttled or asleep
          // comes back and says hello again (addGuest)
          this.departed.set(id, { gameScore: p.gameScore, remainingShips: p.remainingShips, slot: p.slot, at: now });
          for (const [k, d] of this.departed) if (now - d.at > 90000) this.departed.delete(k);
          g.removePlayer(p);
          this.t.send({ k: 'dropped', to: id });
          this.hooks.onPeers && this.hooks.onPeers(g.players.length);
        }
      } else {
        this.log('lost contact with the host');
        this.end('host-gone');
      }
    }
  }

  end(reason) {
    clearInterval(this.watchdog);
    clearInterval(this.pingTimer);
    clearInterval(this.sendInputTimer);
    clearInterval(this.helloTimer);
    const g = this.game;
    if (this.role === 'guest') g.remote = null;
    g.onTickStart = g.onTickDone = g.onPlayerOut = g.onSound = g.onExplode = g.onText = null;
    try { this.t.send({ k: 'bye' }); } catch (e) { /* closed */ }
    // after a handoff, let the (large) message finish sending before closing
    if (this.handedOff && this.t.closeWhenFlushed) this.t.closeWhenFlushed();
    else this.t.close();
    this.ended = reason;
    this.hooks.onEnd && this.hooks.onEnd(reason, this);
  }
}
