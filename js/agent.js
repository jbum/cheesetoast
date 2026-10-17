// Bot interface (multiplayer test site only).  Loaded when the URL has ?agent.
//
//   window.ctAgent.seed(n)          make Math.random reproducible (call before start)
//   window.ctAgent.manual(true)     stop real-time ticking; the bot steps the game
//   window.ctAgent.start()          skip the start screen and attract mode, begin a game
//   window.ctAgent.step(n, log)     run n logic ticks; with log, returns a universe
//                                   snapshot per tick (for videos)
//   window.ctAgent.state()          what a player needs to decide, in symbols
//   window.ctAgent.world()          everything in the universe (compact, for logs)
//   window.ctAgent.setControls({left, right, thrust, fire, shield, brake})
//   window.ctAgent.setAwareness('radar' | 'screen' | 'universe')
//
// Awareness (default 'radar', what a human player has): things on screen are
// fully identified; things beyond the screen but within the radar's range show
// only as radar blips (kind and position, no type or points; enemy bullets,
// which the radar doesn't show, are unknown); nothing beyond the radar.
// 'screen' drops the radar blips; 'universe' sees everything.
//
// Geometry in state(): world units, y up.  Headings and bearings are degrees,
// clockwise, 0 = 12 o'clock.  An entity's "bearing" is relative to where the
// spout points: +30 means 30 degrees to the right.  The teapot turns in steps
// of 22.5 degrees, one step per tick, so "turn_steps" is how many ticks of
// turning would aim the spout at it (negative = left).

import { Session, LocalTransport } from './net.js';
import { ST, KF, GS, SM, BF_ShipCollideFlag, kAsterColor, kBadColor, kYummyColor,
  BulletSpeed, kBulletLifeSpan, kMaxRotIdxAngles, TEXTURE_DEFS } from './constants.js';

const TYPE_NAMES = [];
for (const [name, i] of Object.entries(ST)) TYPE_NAMES[i] = name;

const STEP_DEG = 360 / kMaxRotIdxAngles * 2;          // one tick of turning: 22.5 degrees
const FIRE_RANGE = BulletSpeed * kBulletLifeSpan;       // how far a bullet flies (still air)

let uidCounter = 0;
const uids = new WeakMap();
const uid = (sp) => {
  let id = uids.get(sp);
  if (id === undefined) { id = ++uidCounter; uids.set(sp, id); }
  return id;
};

// mulberry32: small, fast, good enough for a reproducible universe
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm180 = (d) => ((d % 360) + 540) % 360 - 180;
const headingOf = (x, y) => (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;   // clockwise from up

function kindOf(sp) {
  if (sp.type === ST.Photon) return 'enemy_shot';
  if (sp.type === ST.Teeth) return 'teeth';          // can't be shot; avoid
  const c = sp.def.radarColor;
  if (c === kYummyColor) return 'powerup';
  if (c === kBadColor) return 'enemy';
  if (c === kAsterColor) return 'asteroid';
  return 'other';
}

export function installAgent(game, input, hooks = {}) {
  input.botFlags = 0;
  let awareness = 'radar';

  const agent = {
    seed(n) { Math.random = seeded(n); return true; },

    // start each new teapot with a push at this speed (units/tick), random direction
    setKick(speed) { game.local.kick = +speed || 0; return game.local.kick; },

    setAwareness(a) { awareness = a; return awareness; },

    manual(on = true) { game.manualTicks = !!on; return game.manualTicks; },

    // headless bots: skip drawing the game while playing (saves most of the
    // page's CPU, so decisions keep up with real time); recordings don't need it
    setDraw(on = true) { game.noDraw = !on; return on; },

    // Battle puzzles (bots/puzzles/): set up a board and return the state a bot
    // would see on it, without running the game.  Coordinates are relative to
    // your teapot at the origin (y up); headings in degrees clockwise from up.
    //   { mode: 'single'|'coop'|'duel'|'melee',
    //     me: { heading, vx, vy, shield (0-100), canFire, invulnerable },
    //     things: [{ type: 'Wheel', x, y, vx, vy, rad, hits }],   // ST names
    //     rivals: [{ x, y, vx, vy, heading }], rivalShots: [{ x, y, vx, vy }] }
    setup(b = {}) {
      if (game.state !== GS.Play) agent.start();
      game.manualTicks = true;
      game.clearSprites();
      game.cur = game.local;
      game.players = [game.local];
      const mode = b.mode || 'single';
      game.netMode = mode === 'single' ? null : mode;
      game.duel = mode === 'duel' || mode === 'melee';
      const me = b.me || {};
      const ship = game.newSprite(ST.Teapot, 0, 0);
      game.ship = ship;
      ship.rotIdx = Math.round((me.heading || 0) / (360 / kMaxRotIdxAngles)) % kMaxRotIdxAngles;
      ship.vx = me.vx || 0; ship.vy = me.vy || 0;
      game.offsetX = game.offsetY = 0;
      game.shieldPower = me.shield ?? 100;
      game.fireDelay = me.canFire === false ? 5 : 0;
      game.shipMode = me.invulnerable ? SM.AutoShield : 0;
      const place = (type, o) => {
        const sp = game.newSprite(type, o.x || 0, o.y || 0);
        if (!sp) return null;
        sp.vx = o.vx || 0; sp.vy = o.vy || 0;
        if (o.rad) sp.rad = o.rad;
        if (o.hits) { sp.maxHits = o.hits; sp.hitsTaken = 0; }
        return sp;
      };
      for (const t of b.things || []) {
        if (ST[t.type] === undefined) throw new Error('unknown sprite type ' + t.type);
        place(ST[t.type], t);
      }
      const rivals = (b.rivals || []).map((r, i) => {
        const p = new game.local.constructor('rival' + i, false, 'Rival ' + (i + 1));
        game.players.push(p);
        const sp = place(ST.Teapot, r);
        sp.owner = p;
        sp.rotIdx = Math.round((r.heading || 0) / (360 / kMaxRotIdxAngles)) % kMaxRotIdxAngles;
        p.ship = sp;
        return p;
      });
      for (const s of b.rivalShots || []) {
        let p = rivals[0];
        if (!p) { p = new game.local.constructor('rivalX', false, 'Rival'); game.players.push(p); }
        const sp = place(ST.Bullet, s);
        if (sp) sp.owner = p;
      }
      game.cur = game.local;
      return agent.state();
    },

    start() {
      hooks.hideStart && hooks.hideStart();
      game.snd.setEnabled(false);
      game.anim = null;
      game.cameraRoll = 0;
      game.fgAlpha = 1;
      game.beginGame();
      return game.state;
    },

    setControls(c = {}) {
      let f = 0;
      if (c.left) f |= KF.Left;
      if (c.right) f |= KF.Right;
      if (c.thrust) f |= KF.Thrust;
      if (c.fire) f |= KF.Fire;
      if (c.shield) f |= KF.Shield;
      if (c.brake) f |= KF.Brake;
      input.botFlags = f;
      return f;
    },

    step(n = 1, log = false) {
      const worlds = [];
      for (let i = 0; i < n && game.state === GS.Play; i++) {
        game.keyFlags = input.flags;
        game.gameTick();
        game.time += 1 / 20;
        if (log) worlds.push(agent.world());
      }
      return { state: game.state, tick: game.gameClock, worlds };
    },

    state() {
      const ship = game.ship;
      const alive = !!(ship && ship.active && ship.type === ST.Teapot);
      const out = {
        tick: game.gameClock,
        playing: game.state === GS.Play,
        score: game.gameScore,
        level: game.gameLevel,
        pots_left: game.remainingShips,
        // single (no session), or the multiplayer mode: coop | duel | melee
        mode: game.netMode || 'single',
        me: null,
        entities: [],
      };
      if (!ship) return out;
      const heading = (ship.rotIdx / kMaxRotIdxAngles) * 360;
      const shipRad = ship.rad || 24;
      out.me = {
        alive,
        x: Math.round(ship.x), y: Math.round(ship.y),
        vx: +ship.vx.toFixed(2), vy: +ship.vy.toFixed(2),
        speed: +Math.hypot(ship.vx, ship.vy).toFixed(2),
        heading: Math.round(heading),
        moving_toward: Math.hypot(ship.vx, ship.vy) > 0.3 ? Math.round(headingOf(ship.vx, ship.vy)) : null,
        shield_power: game.shieldPower,
        invulnerable: alive && !!(game.shipMode & SM.AutoShield),   // spawn auto-shield
        can_fire: game.fireDelay === 0,
        whorl_pull: Math.round((game.whorlPull || 0) * 100),
      };
      for (const sp of game.sprites) {
        if (!sp.active || sp === ship || sp === game.shield) continue;
        let kind = kindOf(sp);
        if (sp.type === ST.Teapot) kind = game.duel ? 'rival' : 'ally';   // another player's teapot
        // another player's bullet: harmless in co-op, deadly in duel/melee
        if (sp.type === ST.Bullet || sp.type === ST.CreamBullet) {
          const mine = game.remote ? sp.ownerId === game.local.id : sp.owner === game.local;
          if (!game.duel || mine || !(sp.owner || sp.ownerId)) continue;
          kind = 'rival_shot';
        }
        if (kind === 'other') continue;
        if (kind === 'ally') continue;
        if (kind !== 'enemy_shot' && kind !== 'rival_shot' && kind !== 'rival' && !(sp.def.bulletFlag & BF_ShipCollideFlag)) continue;
        const d = { x: sp.x - ship.x, y: sp.y - ship.y };
        game.bindToUniverseTorus(d);
        const dist = Math.hypot(d.x, d.y);
        const gap = Math.max(0, dist - (sp.rad || 0) - shipRad);
        const bearing = norm180(headingOf(d.x, d.y) - heading);
        const rvx = sp.vx - ship.vx, rvy = sp.vy - ship.vy;
        const closing = dist > 0 ? -(rvx * d.x + rvy * d.y) / dist : 0;   // + = getting closer
        out.entities.push({
          id: uid(sp),
          type: TYPE_NAMES[sp.type],
          kind,
          points: kind === 'rival' ? 2000 : (sp.def.points || 0),
          hits_left: Math.max(1, (sp.maxHits || 1) - (sp.hitsTaken || 0)),
          dx: Math.round(d.x), dy: Math.round(d.y),
          dist: Math.round(dist),
          gap: Math.round(gap),
          bearing: Math.round(bearing),
          turn_steps: Math.round(bearing / STEP_DEG),
          closing: +closing.toFixed(2),
          ticks_to_impact: closing > 0.05 ? Math.round(gap / closing) : null,
          in_fire_range: gap < FIRE_RANGE * 0.9,
        });
      }
      out.entities.sort((a, b) => a.gap - b.gap);
      if (awareness !== 'universe') {
        // what's on screen (this game's view) and what the radar shows
        const ppu = game.baseScale * 600 / (game.visH || 600);
        const halfW = game.cw / (2 * ppu), halfH = game.ch / (2 * ppu);
        const radarR = game.normalVisPlayRad * 2;
        out.entities = out.entities.filter((e) => {
          const onScreen = Math.abs(e.dx) <= halfW && Math.abs(e.dy) <= halfH;
          if (onScreen) return true;
          if (awareness === 'screen' || e.dist > radarR || e.kind === 'enemy_shot' || e.kind === 'rival_shot') return false;
          e.type = 'radar blip';
          e.points = 0;
          e.hits_left = 1;
          e.on_radar_only = true;
          return true;
        });
        out.awareness = awareness;
      }
      return out;
    },

    // Everything visible, compactly: [type, x, y, texture, cell, radius, rotation, alpha%]
    world() {
      const s = [];
      for (const sp of game.sprites) {
        if (!sp.active || !sp.visible || !sp.nbrFrames) continue;
        s.push([sp.type, Math.round(sp.x), Math.round(sp.y), sp.textureID,
          (sp.textureIndex ?? sp.def.textureIndex) + sp.frameNbr, Math.round(sp.rad), Math.round(sp.rotation || 0),
          Math.round(100 * (sp.rgba ? sp.rgba[3] : 1))]);
      }
      const ship = game.ship;
      return {
        t: game.gameClock,
        score: game.gameScore,
        level: game.gameLevel,
        pots: game.remainingShips,
        shield: game.shieldPower,
        ship: ship ? [Math.round(ship.x), Math.round(ship.y), ship.rotIdx, ship.type === ST.Teapot ? 1 : 0] : null,
        s,
      };
    },

    textures() { return TEXTURE_DEFS.map(([file, cell]) => [file.replace(/\?.*$/, ''), cell]); },

    // ---- multiplayer (net.js); real time, no manual stepping

    setLabel(text) { game.local.label = text; },

    // Play online through the real matchmaker and WebRTC (js/mp.js), like a person would
    // joinOnly (fill-in bots, bots/filler.mjs): only join a person who is
    // waiting; if there's none, stay in attract (online().noHost turns true)
    // hostOnly (tests): just queue up, never join anyone
    // person (tests): not flagged as a bot, so fill-in bots will join it
    playOnline({ name, mode = 'coop', max = 4, joinOnly = false, hostOnly = false, person = false }) {
      if (!hooks.mp) return 'multiplayer is off (?solo)';
      hooks.mp.botOpts = { bot: !person, joinOnly: !!joinOnly, hostOnly: !!hostOnly };
      hooks.mp.noHost = false;
      hooks.mp.setMaxPlayers(max);
      hooks.hideStart && hooks.hideStart();
      game.snd.setEnabled(false);
      game.nameBuf = name;
      game.local.bot = !person;
      hooks.mp.setMode(mode);
      game.anim = null; game.cameraRoll = 0; game.fgAlpha = 1;
      game.manualTicks = false;
      game.beginGame();
      return true;
    },
    leaveOnline() { if (hooks.mp) hooks.mp.gameOver(); return true; },
    // give up on a host that isn't connecting (what a key or tap does for a person)
    bailJoin() { if (hooks.mp && hooks.mp.bailJoin) { hooks.mp.bailJoin(); return true; } return false; },

    // testing: lose all remaining pots now (a host running out triggers the handoff)
    forfeit() {
      if (game.remote) return 'guests lose pots on the host';
      game.cur = game.local;
      game.local.remainingShips = 0;
      if (game.local.ship && game.local.ship.active) game.explodeSprite(game.local.ship, 30);
      game.newShip();
      game.cur = game.local;
      return true;
    },
    say(text) { return hooks.mp && hooks.mp.chat ? hooks.mp.chat.say(text) : false; },

    // what this page believes, for consistency checks (bots/run-mp.mjs)
    audit() {
      const m = hooks.mp, s = m && m.session;
      const pos = (sp) => (sp ? [Math.round(sp.x), Math.round(sp.y)] : null);
      const out = {
        state: game.state, clock: game.gameClock, role: s ? s.role : null, id: s ? s.id : null,
        hostId: s ? (s.role === 'host' ? s.id : s.hostId || null) : null,
        local: { score: game.local.gameScore, pots: game.local.remainingShips, pos: pos(game.local.ship) },
        gapMax: s ? Math.round(s.gapMax || 0) : 0, stalls: s ? s.stalls || 0 : 0,
      };
      if (s) { s.gapMax = 0; }
      if (s && s.role === 'host')
        out.players = game.players.map((p) => ({ id: p.id, name: p.name, score: p.gameScore, pots: p.remainingShips,
          pos: p.ship && p.ship.type === ST.Teapot ? pos(p.ship) : null }));
      return out;
    },

    online() {
      const m = hooks.mp;
      const s = m && m.session;
      // people (not bots) here with us, still playing
      let humans = 0;
      if (s && game.remote) humans = s.snap ? s.snap.players.filter((p) => p[0] !== s.id && !p[14] && !p[8]).length : 0;
      else if (s) humans = game.players.filter((p) => p !== game.local && !p.bot && !p.out).length;
      return { status: m ? m.status : '', role: s ? s.role : null, players: game.players.length,
        partner: m ? m.partner : '', log: m ? m.log.splice(0) : [], noHost: !!(m && m.noHost), starting: !!(m && m.starting),
        connecting: !!(m && m.connecting), humans };
    },

    // Start a solo game and host a session on a local channel
    host({ channel, id, name, mode = 'coop', lagMs = 0, jitterMs = 0, loss = 0 }) {
      agent.start();
      game.manualTicks = false;
      const t = new LocalTransport(channel, id, { lagMs, jitterMs, loss });
      agent.session = new Session(game, t, { role: 'host', id, name, mode, hooks: agent.sessionHooks() });
      return true;
    },

    // Join a host's session as a guest
    join({ channel, id, name, mode = 'coop', lagMs = 0, jitterMs = 0, loss = 0 }) {
      hooks.hideStart && hooks.hideStart();
      game.snd.setEnabled(false);
      game.anim = null; game.cameraRoll = 0; game.fgAlpha = 1; game.visH = game.playVisH;
      game.manualTicks = false;
      game.clearSprites();
      game.textSprites = [];
      game.initStatusDisplay();
      game.local.gameScore = 0;
      game.setState(GS.Play);
      const t = new LocalTransport(channel, id, { lagMs, jitterMs, loss });
      agent.session = new Session(game, t, { role: 'guest', id, name, mode, hooks: agent.sessionHooks() });
      return true;
    },

    sessionHooks() {
      return {
        log: (m) => agent.events.push(m),
        onBecomeHost: () => agent.events.push('became host'),
        onPeers: (n) => agent.events.push('players: ' + n),
        onEnd: (reason) => {
          agent.events.push('session ended: ' + reason);
          agent.ended = reason;
          // this player is done: show game over like a solo game
          game.players = [game.local];
          game.onPlayerOut = null;
          game.remote = null;
          game.endGame();
        },
      };
    },
    events: [],
    drainEvents() { const e = agent.events; agent.events = []; return e; },

    // Record the universe once per tick (real time) for videos
    record(on = true) {
      clearInterval(agent.recTimer);
      agent.recBuf = agent.recBuf || [];
      if (!on) return;
      let last = -1;
      agent.recTimer = setInterval(() => {
        if (game.gameClock === last || game.state !== GS.Play) return;
        last = game.gameClock;
        const w = agent.world();
        const sess = agent.session || (hooks.mp && hooks.mp.session);
        w.host = !sess || sess.role === 'host';
        w.ships = game.players.map((p) => ({ id: p.id, name: p.name, score: p.gameScore, pots: p.remainingShips,
          shield: p.shieldPower, a: p.label || '',
          // waiting to respawn (an invisible timer at the center): no position
          pos: p.ship && p.ship.type === ST.Teapot ? [Math.round(p.ship.x), Math.round(p.ship.y), p.ship.rotIdx, 1] : null }));
        if (!w.host && sess && sess.others) {
          // a guest only knows the others from the snapshot
          w.ships = [w.ships[0], ...sess.others.map((o) => ({ id: o[0], name: o[1], score: o[2], pots: o[3],
            shield: o[4], a: o[12], pos: o[7] ? [o[9], o[10], 0, 1] : null }))];
        }
        if (hooks.mp && hooks.mp.chatEvents && hooks.mp.chatEvents.length) w.chat = hooks.mp.chatEvents.splice(0);
        agent.recBuf.push(w);
      }, 10);
    },
    drainRecording() { const b = agent.recBuf || []; agent.recBuf = []; return b; },

    // Hold controls for a short plan, one entry per tick, in real time
    runPlan(plan) {
      clearInterval(agent.planTimer);
      let i = 0;
      return new Promise((resolve) => {
        const stepOne = () => {
          if (i >= plan.length || game.state !== GS.Play) { clearInterval(agent.planTimer); resolve(i); return; }
          agent.setControls(plan[i++]);
        };
        stepOne();
        agent.planTimer = setInterval(stepOne, 50);
      });
    },
  };
  window.ctAgent = agent;
  return agent;
}
