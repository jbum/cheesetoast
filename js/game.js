// The game proper: a port of CTGame (CTGame.cpp, CTSprites.cpp, CTAttract.cpp,
// CTTopScores.cpp, CTTextSprites.cpp, CTRadar.cpp).
//
// World coordinates are y-up with the origin at the center of a 3840x1920
// torus.  Logic runs at 20 ticks a second like the original; rendering runs
// at the display rate and interpolates sprite motion between ticks.

import {
  TICK, GS, AT, ST, TXT, SND, SM, Y, kMaxRotIdxAngles, kFixedVisHeight, WHORLS, kWhorlReach, BF_ShipCollideFlag,
  MaxShieldPower, kMaxSprites, kMaxScoreTiles,
  kNormalYummyChance, kNormalToasterChance, kMaxBadGuyChance, kMinBadGuyChance,
  kBadGuyLevelDecrement, kMinAsteroidsPerLevel, kExtraAsteroidsPerLevel, kMaxAsteroids,
  kNewLevelIncrement, kLevelBonusScore, kFreeShipPoints, kYummyLifeSpan, kCreamerLifeSpan,
  kSmallSparkLifeSpan, kLargeSparkLifeSpan,
} from './constants.js';
import { Sprite, SDEF, setGame, standardSpriteUpdate, kGobbleTicks, applyWhorlPullToObject } from './sprites.js';
import { fetchScores, submitScore } from './scores.js';
import { Starfield } from './stars.js';
import { Sparks } from './sparks.js';
import { makeCanvas, tintedCell } from './assets.js';
import { rnd, randomI, loadPref, savePref } from './util.js';

const kMaxScoreRecs = 10;
const kMaxNameLen = 32;
const SCORES_KEY = 'cheesetoast.topscores';   // + '.coop' etc. for the multiplayer boards
// Each game mode has its own Hall of Cheese.  A game counts toward the
// multiplayer mode's board if a partner was there at any point, else 'single'.
// teapot colors by join order (multiplayer): untinted, green, blue, gold.  Bots
// are tinted instead by what they mean to you: red in duel/melee (dangerous),
// purple in co-op (a helper)
const TEAPOT_TINTS = [null, [0.5, 1, 0.45], [0.5, 0.7, 1], [1, 0.85, 0.35]];
const BOT_TINT_RIVAL = [1, 0.4, 0.35], BOT_TINT_COOP = [0.8, 0.5, 1];
const BOT_PREFIX = '\u{1F916} ';   // fill-in bots' names (bots/filler.mjs)
const BOARD_TITLES = { single: '', coop: 'Co-op', duel: 'Duel', melee: 'Melee' };
const scoresKey = (mode) => (mode === 'single' ? SCORES_KEY : SCORES_KEY + '.' + mode);
const NAME_KEY = 'cheesetoast.name';

const DEMO_SPRITES = [ST.Wheel, ST.Aster, ST.Teacup, ST.Saucer, ST.CoffeePot,
  ST.Croissant, ST.Cube, ST.Cranny, ST.DemoTeapot];
const TEA_SPRITE = DEMO_SPRITES.length - 1;
const SPRITE_DESC = [
  ['Caffeine Molecule', '  100 pts'],
  ['Asterisks', '  100 pts'],
  ['Cup', '  100 pts'],
  ['Saucer', '  500 pts'],
  ['Percolator', '  600 pts'],
  ['Exploding Croissant', '  600 pts'],
  ['Swelling Itching Sugar Cube', '  750 pts'],
  ['Nook & Cranny', '  750 pts'],
  ['The Holy Teapot', ''],
];
const ATTRACT_TICKS = [160, 300, 100, 100];   // per attract mode (AT order); browser port: instructions 8 s (CT_III 5 s)
const kBoardTicks = 70;   // each Hall of Cheese when several boards take turns
// browser port: the beastiary starts lower and is tighter (CT_III: 50 / 70) to
// clear the mode bar at the top of the screen
const kDescTop = 82;
const kLineHeight = 65;
const kScoreTweenLength = 2.0;

const kIntroTitleSecs = 1.2;   // start screen title fly-in
const kSpawnMargin = 120;      // asteroids/enemies spawn at least this far outside the view
const kMaxTeeth = 5;           // most chattering teeth alive at once
const kPlayerDifficulty = 0.5;  // multiplayer: each extra player adds half a solo game's worth
const kDuelHitPoints = 2000;   // multiplayer duel: points for destroying the other teapot

// Multiplayer (browser port): everything that belongs to one player lives in
// a Player record.  The Game fields listed in PLAYER_FIELDS read and write the
// *current* player (game.cur), so the single-player code in sprites.js keeps
// working unchanged; gameTick points `cur` at a sprite's owner (teapot, shield,
// bullets) or, for everything else, at the nearest live teapot before it moves.
export const PLAYER_FIELDS = ['ship', 'shield', 'gameScore', 'remainingShips', 'shieldPower', 'shipMode',
  'fireDelay', 'keyFlags', 'lastScore', 'scoreMultiply', 'whorlPull', 'gameStartTime',
  'offsetX', 'offsetY', 'prevOffX', 'prevOffY', 'message', 'stickDir'];
const OWNED_TYPES = new Set([ST.TeapotNew, ST.Teapot, ST.Shield, ST.Bullet, ST.CreamBullet]);

export class Player {
  constructor(id, local = false, name = '') {
    this.id = id;
    this.local = local;
    this.name = name;
    this.ship = null; this.shield = null;
    this.gameScore = 0; this.remainingShips = 3; this.lastScore = -1; this.scoreMultiply = 1;
    this.shieldPower = 0; this.shipMode = 0; this.fireDelay = 0; this.keyFlags = 0;
    this.stickDir = -1;  // touch steering: the heading (0-15) to turn to, or -1 (shipMove)
    this.whorlPull = 0; this.gameStartTime = 0; this.message = '';
    this.offsetX = 0; this.offsetY = 0; this.prevOffX = 0; this.prevOffY = 0;
    this.spawnX = 0;     // where this player's teapots appear (x; y is 0)
    this.out = false;    // used up all their pots
    this.away = false;   // paused, hidden or in the settings in a shared universe: teapot frozen (freezePlayer)
    this.slot = 0;       // color slot by join order: 0 untinted, then red, green, blue (TEAPOT_TINTS)
    this.bot = false;    // driven by a bot (agent.js)
  }
}

export class Game {
  constructor({ canvas, textures, font, snd, input, debug }) {
    this.local = this.cur = new Player(1, true);
    this.players = [this.local];
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.textures = textures;
    this.font = font;
    this.input = input;
    // Sounds started on behalf of another player (their firing, thrust...)
    // play from where their teapot is, not at full volume.
    this.realSnd = snd;
    this.snd = new Proxy(snd, {
      get: (t, k) => {
        if (k === 'play') return (id, volume, pan) => {
          this.onSound && this.onSound(id, this.cur);
          if (this.cur === this.local || !this.cur.ship || !this.local.ship) return t.play(id, volume, pan);
          const u = { x: 0, y: 0 };
          const d = this.distanceToPoint(this.cur.ship.x, this.cur.ship.y, this.local.offsetX, this.local.offsetY, u, null);
          return t.playFrom(id, d, -u.x, this);
        };
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.debug = debug;
    this.ui = null;   // set by main.js: { stateChanged(state), engraveBegin(name), ... }
    setGame(this);

    SDEF.forEach((d, i) => { if (d.type !== i) throw new Error('sprite table out of order at ' + i); });

    // universe
    this.univWidth = 640 * 6;
    this.univHeight = 640 * 3;
    this.univRadX = this.univWidth / 2;
    this.univRadY = this.univHeight / 2;
    this.univMaxDist = Math.ceil(Math.hypot(this.univRadX, this.univRadY));
    this.normalVisPlayRad = Math.hypot(800 / 2, 600 / 2);   // center to corner of an 800x600 view

    // clockwise vector table starting at 12:00
    this.vecTable = [];
    for (let i = 0; i < kMaxRotIdxAngles; i++) {
      const ang = i * 2 * 3.14159 / kMaxRotIdxAngles;
      this.vecTable.push({ x: Math.sin(ang), y: Math.cos(ang) });
    }

    // camera
    this.offsetX = 0; this.offsetY = 0;
    this.prevOffX = 0; this.prevOffY = 0;
    this.visH = kFixedVisHeight;      // gVisPlayHeight: world units visible vertically (4:3 terms)
    this.visPlayWidth = 800;
    this.cameraRoll = 0;
    this.fgAlpha = 1;
    this.anim = null;

    // state
    this.state = GS.Intro;
    this.pausedFrom = GS.Play;
    this.time = 0;          // m_fTime: seconds, stops while paused
    this.acc = 0;           // tick accumulator
    this.gameClock = 0;
    this.attractMode = AT.Beastiary;
    this.attractStart = 0;
    this.wiggleStart = 0;
    this.sprites = [];
    this.spriteCnt = 0;
    this.ship = null;
    this.shield = null;
    this.gameLevel = 0;
    this.shipMode = 0;
    this.shieldPower = 0;
    this.fireDelay = 0;
    this.asteroidCnt = 0;
    this.yummyCnt = 0;
    this.minAsteroids = 0;
    this.badGuyChance = kMaxBadGuyChance;
    this.yummyChance = kNormalYummyChance;
    this.toasterChance = kNormalToasterChance;
    this.remainingShips = 0;
    this.scoreMultiply = 1;
    this.gameScore = 0;
    this.lastScore = -1;
    this.keyFlags = 0;
    this.message = '';
    this.textSprites = [];
    this.scoreAnim = null;
    this.wantsStats = false;
    this.touchMode = false;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsTime = 0;

    this.stars = new Starfield();
    this.sparks = new Sparks();

    // each score digit is tinted into its own canvas, redrawn only when the
    // digit changes or rolls (one shared scratch canvas, redrawn for every
    // digit every frame, stalled the renderer: ~15 ms a frame)
    this.scoreTiles = [];
    for (let i = 0; i < kMaxScoreTiles; i++) {
      const sp = new Sprite();
      sp.tint = makeCanvas(60, 60);
      sp.tintKey = '';
      this.scoreTiles.push(sp);
    }

    this.boardModes = ['single'];   // mp.js adds the multiplayer boards
    this.boardMode = 'single';      // the board in view (topScores)
    this.scoreMode = 'single';      // the board the current game counts toward
    this.netMode = null;            // a multiplayer session's mode (net.js)
    this.noBots = false;            // multiplayer: this universe's players said no bots (mp.js)
    this.boards = { single: this.loadTopScores('single') };
    this.lastHighScoreIdx = -1;
    this.sharedScores = false;   // true once the shared Hall of Cheese has answered
    this.engraveMsg = '';        // shown under the name while engraving
    this.engraveBusy = false;
    this.refreshScores();
    this.nameBuf = loadPref(NAME_KEY, '');

    const clouds = this.textures[TXT.Clouds].image;
    this.cloudPattern = this.ctx.createPattern(clouds, 'repeat');
    this.view = null;
    this.resize();
    if (debug) window.ct = this;
  }

  // ------------------------------------------------------------ frame loop

  frame(dtReal) {
    this.cur = this.local;
    // a partner during this game: it counts toward that mode's Hall of Cheese
    if (this.state === GS.Play && this.netMode && (this.remote || this.players.length > 1)) this.scoreMode = this.netMode;
    // a bot stepping the game by hand (agent.js) doesn't need it drawn, and
    // drawing uses random numbers too, which would make seeded runs differ
    if (this.manualTicks && this.state === GS.Play) return;
    const dt = Math.min(dtReal, 0.25);
    this.fpsFrames++;
    this.fpsTime += dtReal;
    if (this.fpsTime >= 1) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    this.dt = dt;
    if (this.state !== GS.Pause)
      this.time += dt;
    this.font.time = this.time;
    this.keyFlags = this.input.flags;
    this.local.stickDir = this.stickTarget();

    switch (this.state) {
      case GS.Intro:
        this.stars.update(dt, this.starView());
        this.renderIntro();
        return;
      case GS.Attract:
        this.updateCamera();
        this.runTicks(dt, () => this.attractTick());
        this.renderAttract();
        return;
      case GS.Play:
        if (this.remote) {
          this.remote.frame(dt);   // multiplayer guest: draw the host's snapshots (net.js)
        } else {
          // (multiplayer host: onTickStart applies the guests' inputs for this tick, onTickDone sends the snapshot)
          this.runTicks(dt, () => { this.onTickStart && this.onTickStart(); this.gameTick(); this.onTickDone && this.onTickDone(); });
        }
        this.updateCamera();
        if (!this.noDraw) this.renderGame();   // bots' headless pages skip drawing (agent.js setDraw)
        return;
      case GS.GameOver:
        this.runTicks(dt, () => this.gameTick());
        this.updateCamera();
        this.renderGame();
        if (this.gameClock > 5 * 20) {
          // done spinning out: zoom back in and on to the next thing
          this.cameraRoll -= 360 * Math.trunc(this.cameraRoll / 360);
          this.startCameraAnimation(0, kFixedVisHeight, 1.0, 3.0);
          this.setBoard(this.scoreMode);
          this.showBoardNext = this.scoreMode;
          if (this.isNewHighScore()) {
            this.startEngraveMode();
          } else {
            this.snd.play(SND.ChineseGong);
            this.beginAttract(AT.TopScores);
          }
        }
        return;
      case GS.Pause:
        this.renderGame();
        return;
      case GS.Engrave:
        this.updateCamera();
        this.renderEngrave();
        return;
    }
  }

  // The steering circle's angle (input.js) as one of the teapot's 16
  // headings, in the universe (allowing for a rolled camera).  It stays on the
  // current heading until the thumb is clearly nearer another, so a thumb on
  // a boundary doesn't flicker between two.
  stickTarget() {
    const a = this.input.stickAngle;
    if (a === null || a === undefined) { this.stickPrev = -1; this.input.showStickAim && this.input.showStickAim(null); return -1; }
    const w = ((a + this.cameraRoll) % 360 + 360) % 360;
    let idx = Math.round(w / 22.5) % 16;
    const prev = this.stickPrev;
    if (prev >= 0) {
      const off = Math.abs(((w - prev * 22.5) % 360 + 540) % 360 - 180);
      if (off < 11.25 + 4) idx = prev;
    }
    this.stickPrev = idx;
    this.input.showStickAim && this.input.showStickAim(((idx * 22.5 - this.cameraRoll) % 360 + 360) % 360);
    return idx;
  }

  runTicks(dt, tick) {
    if (this.manualTicks) { this.acc = 0; return; }   // a bot is stepping the game (agent.js)
    this.acc += dt;
    let n = 0;
    while (this.acc >= TICK && n < 5) {
      this.acc -= TICK;
      tick();
      n++;
    }
    if (this.acc >= TICK) this.acc = 0;   // way behind (e.g. a stall): don't spiral
  }

  setState(state) {
    this.state = state;
    this.acc = 0;
    this.ui && this.ui.stateChanged(state);
  }

  // ------------------------------------------------------------ startup & attract

  startup() {
    // (silent: the fanfare opens a game, beginGame, which a key or tap starts;
    // CT_III played it here, before any of today's audio rules)
    this.cameraRoll = this.reduceMotion ? 0 : 180;   // (settings: reduce motion skips the spins)
    this.visH = this.visHForWidth(this.univWidth);
    this.fgAlpha = 0;
    this.startCameraAnimation(0, kFixedVisHeight, 1.0, 3.0);
    this.beginAttract(AT.Instructions);   // browser port: controls first (CT_III began on the beastiary)
    this.gameClock = -60;                 // ...and held 3 s longer while the intro fades in
    this.titleHandoff = this.introTitleRect ?
      { start: this.time, duration: 3.0, rect: this.introTitleRect } : null;
  }

  beginAttract(attractMode) {
    this.message = '';
    this.clearSprites();
    this.offsetX = this.offsetY = 0;
    this.ship = null;
    DEMO_SPRITES.forEach((type, i) => {
      const sp = this.newDemoSprite(type, -60, -((kDescTop + i * kLineHeight) - 300));
      if (i === 5) sp.rad = 16;   // fixed size croissant
    });
    this.sprites[TEA_SPRITE].x = this.sprites[TEA_SPRITE].prevX = 0;
    this.sprites[TEA_SPRITE].y = this.sprites[TEA_SPRITE].prevY = -50;
    this.attractMode = attractMode;
    if (attractMode === AT.TopScores) this.enterTopScores();
    this.gameClock = 0;
    this.attractStart = this.time;
    this.wiggleStart = this.time;
    this.setState(GS.Attract);
  }

  // The Hall of Cheese shows every board in turn (one per game mode, when
  // multiplayer is on), starting with the board of the game just played
  enterTopScores() {
    if (this.showBoardNext) { this.setBoard(this.showBoardNext); this.showBoardNext = null; }
    else this.setBoard(this.boardModes[0]);
    this.boardsShown = 1;
    if (this.sharedScores) this.refreshScores();
  }

  attractTick() {
    ++this.gameClock;
    const boards = this.attractMode === AT.TopScores && this.boardModes.length > 1;
    if (this.gameClock > (boards ? kBoardTicks : ATTRACT_TICKS[this.attractMode])) {
      this.gameClock = 0;
      if (boards && this.boardsShown < this.boardModes.length) {
        this.boardsShown++;
        this.setBoard(this.boardModes[(this.boardModes.indexOf(this.boardMode) + 1) % this.boardModes.length]);
        if (this.sharedScores) this.refreshScores();
        return this.attractSpritesTick();
      }
      this.attractMode = (this.attractMode + 1) % AT.Count;
      if (this.attractMode === AT.TopScores) this.enterTopScores();
    }
    this.attractSpritesTick();
  }

  attractSpritesTick() {
    for (const sp of this.sprites) {
      sp.prevX = sp.x;
      sp.prevY = sp.y;
      if (sp.active) standardSpriteUpdate(sp);
    }
  }

  nextAttractMode() {
    this.attractMode = (this.attractMode + 1) % AT.Count;
    this.gameClock = 0;
    if (this.attractMode === AT.TopScores) this.enterTopScores();
  }

  // a tap right after a game ends shouldn't start another one by accident
  canStartFromAttract() {
    return this.time - this.attractStart > 1.0;
  }

  // ------------------------------------------------------------ gameplay

  beginGame() {
    this.snd.play(SND.LevelCompletion);   // the fanfare (from the attract debut in CT_III)
    this.gameStartTime = this.time;   // play time goes with the score (server sanity check)
    // a new game: you're in it again (a previous multiplayer game that you lost
    // left this set, and bots then saw no person here and left)
    this.local.out = false;
    this.local.away = this.local.wantAway = false;
    this.noBots = false;
    this.scoreMode = 'single';
    // ease into the phone zoom (elsewhere playVisH is the normal 600, so no-op);
    // also finishes the intro spin if a game starts before it has
    if (this.playVisH !== this.visH)
      this.startCameraAnimation(0, this.playVisH, 1.0, 1.0);
    this.clearSprites();
    this.textSprites = [];
    this.gameScore = 0;
    this.offsetX = this.offsetY = 0;
    this.prevOffX = this.prevOffY = 0;
    this.initStatusDisplay();
    this.message = 'Toasting...';
    this.asteroidCnt = 0;
    this.yummyCnt = 0;
    this.remainingShips = 3;
    this.gameLevel = 0;
    this.shieldPower = MaxShieldPower;
    this.fireDelay = 0;
    this.shipMode = 0;
    this.initLevel();
    this.shield = null;
    this.newShip();
    this.setState(GS.Play);
  }

  gameTick() {
    ++this.gameClock;

    // compact the sprite table when it gets sparse
    if (this.sprites.length > 20 && this.sprites.length > this.spriteCnt * 2)
      this.sprites = this.sprites.filter((sp) => sp.active);

    for (const sp of this.sprites) {
      sp.prevX = sp.x;
      sp.prevY = sp.y;
    }
    for (const p of this.players) {
      p.prevOffX = p.offsetX;
      p.prevOffY = p.offsetY;
    }
    const multi = this.players.length > 1;

    // new sprites spawned during the loop get updated in the same tick, as before
    for (let i = 0; i < this.sprites.length; i++) {
      const sp = this.sprites[i];
      if (!sp.active) continue;
      if (multi) this.cur = this.ownerOf(sp);
      sp.update();
      // whorl gravity for everything the teapot can bump into (the teapot
      // itself is pulled in shipMove)
      if (sp.active && sp !== this.ship && (sp.def.bulletFlag & BF_ShipCollideFlag))
        applyWhorlPullToObject(sp);
    }
    this.cur = this.local;
    this.sparks.update((x) => this.bindXToPlayer(x), (y) => this.bindYToPlayer(y));
    this.updateTextSprites();
    this.trackScore();
    this.genNewEvents();
    this.cur = this.local;
  }

  // Whose turn it is while this sprite moves: its owner, or for everything
  // else the nearest player with a teapot in play (so enemies chase the
  // closest teapot and sounds come from the right place).
  ownerOf(sp) {
    if (sp.owner && !sp.owner.out) return sp.owner;
    let best = this.local, bestD = Infinity;
    for (const p of this.players) {
      // (a teapot waiting to respawn is an invisible timer at the center: skip it)
      // (chasers leave frozen teapots alone: they can't touch them anyway)
      if (p.out || p.away || !p.ship || !p.ship.active || p.ship.type !== ST.Teapot) continue;
      const d = { x: p.ship.x - sp.x, y: p.ship.y - sp.y };
      this.bindToUniverseTorus(d);
      const dd = d.x * d.x + d.y * d.y;
      if (dd < bestD) { bestD = dd; best = p; }
    }
    return best;
  }

  // Bring another player into this universe (multiplayer host)
  addPlayer(id, name = '') {
    const p = new Player(id, false, name);
    p.spawnX = 160 * this.players.length;
    // the lowest color slot nobody here is using, so colors don't shift when someone leaves
    const used = new Set(this.players.map((q) => q.slot));
    while (used.has(p.slot)) p.slot++;
    this.players.push(p);
    const keep = this.cur;
    this.cur = p;
    p.remainingShips = 3;
    p.shieldPower = MaxShieldPower;
    p.gameStartTime = this.time;
    this.newShip();
    this.cur = keep;
    return p;
  }

  // A player who paused in a shared universe (or whose page is hidden, or who
  // is in the settings) can't steer: freeze its teapot in place until it's
  // back.  shipMove ignores its keys, holds it still, and lets the universe's
  // asteroids, enemies and their shots pass through it; in duel and melee,
  // rivals' bullets still hit (user's rule, 2026-10-08).  net.js sets 'away'
  // from the inputs; mp.js for the host itself.
  freezePlayer(p) {
    p.away = true;
    if (p.ship && p.ship.active) { p.ship.vx = p.ship.vy = 0; }
  }

  unfreezePlayer(p) {
    p.away = false;
  }

  removePlayer(p) {
    const keep = this.cur;
    this.cur = p;
    if (p.ship && p.ship.active) this.killSprite(p.ship);
    if (p.shield && p.shield.active) this.killSprite(p.shield);
    for (const sp of this.sprites) if (sp.owner === p) sp.active = false;
    this.cur = keep === p ? this.local : keep;
    this.players = this.players.filter((q) => q !== p);
  }

  pause() {
    if (this.state !== GS.Play) return;
    this.pausedFrom = this.state;
    this.snd.stopAll();
    this.setState(GS.Pause);
  }

  resume() {
    if (this.state !== GS.Pause) return;
    this.setState(this.pausedFrom);
    // the screen may have changed shape while paused (e.g. rotated upright and back)
    if (this.state === GS.Play && !this.anim) this.visH = this.playVisH;
  }

  quitGame() {
    if (this.state === GS.Pause) this.setState(GS.Play);
    if (this.state !== GS.Play) return;
    if (this.ship && this.ship.active) this.explodeSprite(this.ship, kLargeSparkLifeSpan);
    this.endGame();
  }

  endGame() {
    if (this.players.length > 1 && this.onPlayerOut) {   // multiplayer: just this player is out
      this.cur.out = true;
      this.onPlayerOut(this.cur);
      return;
    }
    if (this.state === GS.Play || this.state === GS.Pause) {
      this.message = 'Game Over';
      this.gameClock = 0;
      this.setState(GS.GameOver);
      this.startCameraAnimation(this.reduceMotion ? 0 : 4.5 * 360, this.visHForWidth(this.univWidth), 0.0, 5.0);
    }
  }

  initLevel() {
    this.minAsteroids = Math.min(kMaxAsteroids,
      this.gameLevel * kExtraAsteroidsPerLevel + kMinAsteroidsPerLevel);
    this.scoreMultiply = 1;
    this.badGuyChance = Math.max(kMinBadGuyChance,
      kMaxBadGuyChance - kBadGuyLevelDecrement * this.gameLevel);
    this.yummyChance = kNormalYummyChance;
    this.toasterChance = kNormalToasterChance;
  }

  endLevel() {
    ++this.gameLevel;
    this.onLevel && this.onLevel(this.gameLevel);   // multiplayer: the matchmaker hears about it (mp.js)
    this.addScore(kLevelBonusScore * this.gameLevel);
    this.snd.play(SND.LevelCompletion);
    const ref = this.ship || { x: this.offsetX, y: this.offsetY };
    this.addTextSprite(ref.x, ref.y + 64, 'Level ' + this.gameLevel, 1);
  }

  trackScore() {
    if (this.players.length > 1) {
      // free pots per player; the level follows the best score in the universe
      const keep = this.cur;
      const level = (sc) => Math.trunc(sc / kNewLevelIncrement);
      const best = Math.max(...this.players.map((p) => p.gameScore));
      if (this.lastBestScore !== undefined && level(best) !== level(this.lastBestScore)) {
        this.endLevel();
        this.initLevel();
      }
      this.lastBestScore = best;
      for (const p of this.players) {
        this.cur = p;
        if (p.lastScore !== p.gameScore) {
          if ((p.gameScore >= 10000 && p.lastScore < 10000) ||
              Math.trunc(p.gameScore / kFreeShipPoints) !== Math.trunc(p.lastScore / kFreeShipPoints)) {
            ++p.remainingShips;
            this.snd.play(SND.ExtraShip);
          }
          p.lastScore = p.gameScore;
        }
      }
      this.cur = keep;
      return;
    }
    if (this.lastScore === this.gameScore) return;
    // C integer division truncates toward zero (lastScore starts at -1)
    const level = (s) => Math.trunc(s / kNewLevelIncrement);
    if (level(this.gameScore) !== level(this.lastScore)) {
      this.endLevel();
      this.initLevel();
    }
    if ((this.gameScore >= 10000 && this.lastScore < 10000) ||
        Math.trunc(this.gameScore / kFreeShipPoints) !== Math.trunc(this.lastScore / kFreeShipPoints)) {
      ++this.remainingShips;
      this.snd.play(SND.ExtraShip);
    }
    this.lastScore = this.gameScore;
  }

  // Multiplayer difficulty: 1 alone (unchanged), 1.5 with two players still in,
  // 2 with three, 2.5 with four.  Applied where the level's numbers are used,
  // so the level's own values (initLevel) stay those of a solo game.
  difficultyScale() {
    const n = this.players.filter((p) => !p.out && !p.away).length;
    return 1 + kPlayerDifficulty * Math.max(0, n - 1);
  }

  genNewEvents() {
    const k = this.difficultyScale();
    if (this.asteroidCnt < Math.round(this.minAsteroids * k)) {
      if (randomI(50) === 0) {
        this.newAsteroid(ST.BigJim);
      } else {
        // teeth and colanders join in as the levels go up
        const types = [ST.SconeRock, ST.Wheel, ST.Aster, ST.Teacup, ST.Teeth, ST.Colander, ST.Colander];
        let type = types[randomI(4 + Math.min(this.gameLevel, 3))];
        // browser port: a quarter of the asterisks are AI asterisks instead
        if (type === ST.Aster && randomI(4) === 0) type = ST.AIAster;
        // browser port: teeth can't be shot, so cap them (CT_III's Todo.txt:
        // "Make sure we don't end up with a universe full of teeth")
        if (type === ST.Teeth && this.countActive(ST.Teeth) >= Math.round(kMaxTeeth * k))
          type = types[randomI(4)];
        this.newAsteroid(type);
      }
    }
    // random bad guys
    if (randomI(Math.round(this.badGuyChance / k)) === 0) {
      let n = randomI(30) === 0 ? randomI(7) : 1;   // lucky 7!
      while (n--) {
        switch (randomI(2 + Math.min(this.gameLevel, 4))) {
          case 0: this.newEnemy(ST.Croissant + randomI(2)); break;   // croissants and scones
          // (browser port: swapped, 2026-10-08: the saucer from the start, the
          // percolator, which re-aims and fires more often, from level 1; CT_III
          // had them the other way round)
          case 1: this.newEnemy(ST.Saucer); break;
          case 2: this.newEnemy(ST.CoffeePot); break;
          case 3: this.newEnemy(ST.Cube); break;
          case 4: this.newEnemy(ST.Toaster); break;
          case 5: this.newEnemy(ST.Mixer); break;
        }
      }
    }
    if (randomI(Math.round(this.yummyChance / k)) === 0)
      this.newYummy();
  }

  // ------------------------------------------------------------ sprites

  clearSprites() {
    this.sprites = [];
    this.spriteCnt = 0;
    this.sparks.clear();
    this.asteroidCnt = 0;
    this.ship = null;
    this.shield = null;
  }

  newSprite(type, x, y, vx = 0, vy = 0, frameNbr = 0, isDemo = false) {
    if (this.sprites.length + 1 >= kMaxSprites) return null;
    const sp = new Sprite();
    this.sprites.push(sp);
    sp.init(type, x, y, vx, vy, frameNbr, isDemo);
    sp.active = true;
    if (OWNED_TYPES.has(type)) sp.owner = this.cur;
    ++this.spriteCnt;
    return sp;
  }

  newDemoSprite(type, x, y) {
    return this.newSprite(type, x, y, 0, 0, 0, true);
  }

  killSprite(sp) {
    if (!sp.active) return;
    if (sp.def.dieFunc) sp.def.dieFunc(sp);
    sp.active = false;
    --this.spriteCnt;
    const list = this.sprites;
    while (list.length > 0 && !list[list.length - 1].active) list.pop();
  }

  countActive(type) {
    let n = 0;
    for (const sp of this.sprites) if (sp.active && sp.type === type) n++;
    return n;
  }

  randomUniversePoint() {
    return [rnd() * this.univWidth - this.univRadX, rnd() * this.univHeight - this.univRadY];
  }

  // Browser port (from CT_III's Todo.txt: "Don't allow asteroids/enemies to be
  // spawned within visible area around space-ship"): a random point that isn't
  // on screen, nor within a margin of it, so nothing pops into existence in
  // front of you.  Power-ups still use randomUniversePoint.
  randomSpawnPoint() {
    const v = this.view || this.computeView(1);
    const halfW = Math.max(v.cw / (2 * v.ppu), 400) + kSpawnMargin;
    const halfH = Math.max(v.ch / (2 * v.ppu), 300) + kSpawnMargin;
    let p;
    for (let i = 0; i < 30; i++) {
      p = this.randomUniversePoint();
      const d = { x: p[0] - this.offsetX, y: p[1] - this.offsetY };
      this.bindToUniverseTorus(d);
      if (Math.abs(d.x) > halfW || Math.abs(d.y) > halfH) break;
    }
    return p;
  }

  // any heading except the straight ones (0, 4, 8, 12...)
  randomSlantedRotIdx() {
    const r = randomI(kMaxRotIdxAngles - 4);
    return r + 1 + Math.floor(r / 7);
  }

  newShip() {
    if (this.remainingShips === 0) {
      this.endGame();
      return;
    }
    const sp = this.newSprite(ST.TeapotNew, 0, 0);
    if (!sp) return;
    this.ship = sp;
    sp.rotIdx = 0;
    sp.aniSpeed = 0;
    sp.tickCtr = 0;
    --this.remainingShips;
    this.shipMode = 0;
    if (!this.shield) {
      this.shield = this.newSprite(ST.Shield, 0, 0);
      if (this.shield) this.shield.visible = false;
    }
  }

  newAsteroid(type) {
    const [x, y] = this.randomSpawnPoint();
    const sp = this.newSprite(type, x, y);
    if (!sp) return;
    sp.setFrameNbr(randomI(sp.nbrFrames));
    sp.rotIdx = this.randomSlantedRotIdx();
    const speed = randomI(3) + 2 + randomI(this.gameLevel);
    sp.vx = this.vecTable[sp.rotIdx].x * speed;
    sp.vy = this.vecTable[sp.rotIdx].y * speed;
    switch (type) {
      case ST.SconeRock: sp.aniSpeed = 2; break;
      case ST.BigJim:
      case ST.Colander: sp.aniSpeed = 1; break;
      case ST.Teeth: sp.aniSpeed = 2 + randomI(2); break;
      default: sp.aniSpeed = 1 + randomI(3); break;
    }
    sp.tickCtr = randomI(sp.aniSpeed);
    ++this.asteroidCnt;
  }

  newSubAsteroid(par, type, vecOffset) {
    const sp = this.newSprite(type, par.x, par.y, par.vx, par.vy, 0);
    if (!sp) return;
    switch (type) {
      case ST.LittleJim:
        sp.frameNbr = 0;
        sp.rotation = randomI(360);
        break;
      case ST.SmallCup:
        sp.frameNbr = randomI(sp.nbrFrames);
        break;
      default:
        sp.frameNbr = par.frameNbr;
        if (sp.frameNbr >= sp.nbrFrames) sp.frameNbr = randomI(sp.nbrFrames);
        break;
    }
    sp.lifeSpan = par.lifeSpan;
    sp.rotIdx = (par.rotIdx + vecOffset + kMaxRotIdxAngles) % kMaxRotIdxAngles;
    const speed = randomI(3) + 2 + randomI(this.gameLevel);
    sp.vx = this.vecTable[sp.rotIdx].x * speed;
    sp.vy = this.vecTable[sp.rotIdx].y * speed;
    sp.aniSpeed = type === ST.SconePebble ? 2 : 1 + randomI(2);
    sp.tickCtr = 0;
    sp.setFrameNbr(sp.frameNbr);
    ++this.asteroidCnt;
  }

  newEnemy(type) {
    const [x, y] = this.randomSpawnPoint();
    this.newSprite(type, x, y);
  }

  newBeater(x, y, angle) {
    const sp = this.newSprite(ST.Beater, x, y);
    if (!sp) return;
    sp.frameNbr = angle * 3 + angle;
    sp.maxHits = 1;
    sp.vx = angle === 0 ? 0 : -8;
    sp.vy = -8;
  }

  launchNookAndCranny(par) {
    const launch = (dx, dy, state) => {
      const sp = this.newSprite(ST.EMuffin, par.x + dx, par.y + dy);
      if (!sp) return null;
      this.bindToUniverseTorus(sp);
      sp.rotIdx = 0;
      sp.vx = this.vecTable[0].x * 8;
      sp.vy = this.vecTable[0].y * 8;
      sp.aniSpeed = 2;
      sp.state = state;
      return sp;
    };
    launch(2, 6, 0);
    const sp = launch(11, 9, 1);
    if (sp) this.soundFrom(SND.ToasterPop, sp);
  }

  newYummy() {
    const yummyType = randomI(Y.Count);
    if (yummyType === Y.Creamer) {
      this.newCreamer();
      return;
    }
    const [x, y] = this.randomUniversePoint();
    const sp = this.newSprite(ST.Yummies, x, y, 0, 0, yummyType);
    if (!sp) return;
    sp.state = sp.frameNbr;
    sp.lifeSpan = kYummyLifeSpan;
    sp.tickCtr = 0;
    ++this.yummyCnt;
  }

  newCreamer() {
    const [x, y] = this.randomUniversePoint();
    const sp = this.newSprite(ST.Creamer, x, y);
    if (!sp) return;
    sp.state = Y.Creamer;
    sp.setFrameNbr(randomI(SDEF[sp.type].nbrFrames));
    sp.lifeSpan = kCreamerLifeSpan;
    sp.aniSpeed = 1;
    sp.tickCtr = 0;
    ++this.yummyCnt;
  }

  consumeYummy(sp) {
    const mult = (first, more, label) => {
      this.scoreMultiply += this.scoreMultiply === 1 ? first : more;
      this.addTextSprite(sp.x, sp.y, label, 1);
    };
    switch (sp.state) {
      case Y.Mult2: mult(1, 2, 'x 2'); break;
      case Y.Mult3: mult(2, 3, 'x 3'); break;
      case Y.Mult5: mult(4, 5, 'x 5'); break;
      case Y.Triple: this.shipMode |= SM.Triple; break;
      case Y.Uzi: this.shipMode |= SM.Uzi; break;
      case Y.Shield:
        this.shieldPower = MaxShieldPower;
        this.addTextSprite(sp.x, sp.y, '+ Shields', 1);
        break;
      case Y.Creamer: this.shipMode |= SM.CreamBullet; break;
    }
    this.killSprite(sp);
    this.snd.play(SND.YummyConsume);
    --this.yummyCnt;
  }

  launchBullet(type, x, y, vx, vy, lifeSpan, bFlags) {
    if (type === ST.Bullet && (this.shipMode & SM.CreamBullet))
      type = ST.CreamBullet;
    const sp = this.newSprite(type, x, y, vx, vy);
    if (!sp) return;
    sp.targetFlags = bFlags;
    sp.state = 0;
    sp.tickCtr = 0;
    sp.lifeSpan = lifeSpan;
  }

  newQuake(par) {
    this.newSprite(ST.Quake, par.x, par.y);
  }

  newExplosion(par, type, grow = 1, decay = 1) {
    const sp = this.newSprite(type, par.x, par.y);
    if (!sp) return;
    sp.frameNbr = 0;
    sp.vx = par.vx;
    sp.vy = par.vy;
    sp.aniSpeed = type === ST.Explosion ? 2 : 1;
    sp.tickCtr = 0;
    sp.rotation = randomI(360);
    sp.f1 = grow;
    sp.f2 = decay;
  }

  explodeSprite(sp, lifeSpan, pixSize = 2) {
    if (sp.nbrFrames > 0) {
      this.genExplosionSparks(sp, lifeSpan, pixSize);
      this.onExplode && this.onExplode(sp);   // multiplayer host: guests make the sparks too
    }
    this.soundFrom(lifeSpan > kSmallSparkLifeSpan ? SND.ShipExplodes : SND.Explosion, sp);
    this.killSprite(sp);
  }

  genExplosionSparks(sp, lifeSpan) {
    if (sp.def.nbrFrames <= 0) return;
    this.sparks.explode(sp, this.textures[sp.textureID].image, lifeSpan, this.vecTable);
  }

  // The victim shrinks into the teeth's mouth
  eatSprite(victim, teeth) {
    const sp = this.newSprite(ST.Morsel, victim.x, victim.y);
    if (!sp) return;
    sp.vx = (teeth.x + teeth.vx * kGobbleTicks - victim.x) / kGobbleTicks;
    sp.vy = (teeth.y + 6 + teeth.vy * kGobbleTicks - victim.y) / kGobbleTicks;
    sp.rad = victim.rad;
    sp.f1 = sp.rad;
    sp.f2 = sp.rad * 0.1;
    sp.rotation = victim.rotation;
    sp.frameNbr = victim.frameNbr;
    sp.aniSpeed = victim.aniSpeed;
    sp.nbrFrames = victim.nbrFrames;
    sp.textureID = victim.textureID;
    sp.textureIndex = victim.textureIndex;
    sp.cell = victim.cell;
    sp.cols = victim.cols;
    sp.sx = victim.sx;
    sp.sy = victim.sy;
    sp.tickCtr = 0;
    sp.lifeSpan = kGobbleTicks;
    this.killSprite(victim);
  }

  processShipCollide(sp, spj) {
    let hit = false;
    if (!(sp.state & 0x10) && spj.type !== ST.Yummies && spj.type !== ST.Creamer) {
      sp.def.collideFunc(sp, spj);   // the teapot takes the hit
      hit = true;
    }
    if (spj.def.collideFunc)
      spj.def.collideFunc(spj, sp);
    return hit;
  }

  processBulletCollide(bullet, target) {
    if (target.type === ST.Teapot && target.owner && target.owner !== bullet.owner) {
      // duel hit (multiplayer): the teapot's owner takes it; the shooter scores
      const shooter = this.cur, victim = target.owner;
      const shielded = !!(target.state & 0x10);
      this.cur = victim;
      target.def.collideFunc(target, bullet);
      this.cur = shooter;
      if (!shielded) {
        this.addTextSprite(target.x, target.y, '+ ' + kDuelHitPoints, 1);
        this.addScore(kDuelHitPoints / this.scoreMultiply);
      }
      this.killSprite(bullet);
      return;
    }
    if (target.def.collideFunc)
      target.def.collideFunc(target, bullet);
    if (bullet.type === ST.CreamBullet)
      this.explodeSprite(bullet, kSmallSparkLifeSpan);
    else
      this.killSprite(bullet);
  }

  // ------------------------------------------------------------ geometry

  bindToUniverseTorus(p) {
    if (p.x < -this.univRadX) p.x += this.univWidth;
    else if (p.x > this.univRadX) p.x -= this.univWidth;
    if (p.y < -this.univRadY) p.y += this.univHeight;
    else if (p.y > this.univRadY) p.y -= this.univHeight;
  }

  bindShipToUniverseTorus(sp) {
    const mine = this.cur === this.local;
    const stars = mine ? this.stars : { wrap() {} };
    if (sp.x < -this.univRadX) {
      sp.x += this.univWidth; sp.prevX += this.univWidth; this.prevOffX += this.univWidth;
      stars.wrap(this.univWidth, 0);
    } else if (sp.x > this.univRadX) {
      sp.x -= this.univWidth; sp.prevX -= this.univWidth; this.prevOffX -= this.univWidth;
      stars.wrap(-this.univWidth, 0);
    }
    if (sp.y < -this.univRadY) {
      sp.y += this.univHeight; sp.prevY += this.univHeight; this.prevOffY += this.univHeight;
      stars.wrap(0, this.univHeight);
    } else if (sp.y > this.univRadY) {
      sp.y -= this.univHeight; sp.prevY -= this.univHeight; this.prevOffY -= this.univHeight;
      stars.wrap(0, -this.univHeight);
    }
    this.offsetX = sp.x;
    this.offsetY = sp.y;
  }

  // wrap a coordinate so it lies within half a universe of the viewpoint
  bindXToPlayer(x) {
    const dx = x - this.offsetX;
    if (dx < -this.univRadX) return x + this.univWidth;
    if (dx > this.univRadX) return x - this.univWidth;
    return x;
  }

  bindYToPlayer(y) {
    const dy = y - this.offsetY;
    if (dy < -this.univRadY) return y + this.univHeight;
    if (dy > this.univRadY) return y - this.univHeight;
    return y;
  }

  distanceToPoint(tx, ty, sx, sy, unitVec, deltaVec) {
    const d = { x: tx - sx, y: ty - sy };
    this.bindToUniverseTorus(d);
    const mag = d.x * d.x + d.y * d.y;
    const dist = mag === 0 ? 0.001 : Math.sqrt(mag);
    if (unitVec) {
      unitVec.x = d.x / dist;
      unitVec.y = d.y / dist;
    }
    if (deltaVec) {
      deltaVec.x = d.x;
      deltaVec.y = d.y;
    }
    return dist;
  }

  distanceToLocalPlayer(sp, unitVec) {
    return this.distanceToPoint(this.offsetX, this.offsetY, sp.x, sp.y, unitVec, null);
  }

  isColliding(sp1, sp2) {
    const dist = this.distanceToPoint(sp1.x, sp1.y, sp2.x, sp2.y, null, null);
    return dist < sp1.rad * sp1.collideRF + sp2.rad * sp2.collideRF;
  }

  soundFrom(snd, sp) {
    const u = { x: 0, y: 0 };
    const dist = this.distanceToLocalPlayer(sp, u);
    this.snd.playFrom(snd, dist, u.x, this);
  }

  // ------------------------------------------------------------ score

  addScoreFor(sp) {
    this.addTextSprite(sp.x, sp.y, '+ ' + sp.def.points * this.scoreMultiply, 0);
    this.addScore(sp.def.points);
  }

  addScore(amt) {
    const old = this.gameScore;
    this.gameScore += amt * this.scoreMultiply;
    if (this.cur === this.local) this.beginScoreAnimation(old, this.gameScore);
  }

  initStatusDisplay() {
    this.lastScore = -1;
    this.scoreAnim = null;
    this.scoreTiles.forEach((sp, i) => {
      sp.init(ST.ScoreTile, 200 + i * 33, 0, 0, 0, 0);
      sp.rad = 16;
      sp.active = true;
    });
  }

  beginScoreAnimation(oldScore, newScore) {
    const a = this.scoreAnim;
    if (a) {
      a.length = this.time + kScoreTweenLength - a.begin;
      a.end = newScore;
    } else {
      this.scoreAnim = { from: oldScore, end: newScore, begin: this.time, length: kScoreTweenLength };
    }
  }

  // slot-machine style rolling digits
  updateStatusDisplay() {
    const a = this.scoreAnim;
    if (!a) return;
    const t = Math.min(1, (this.time - a.begin) / a.length);
    const tween = a.from + (a.end - a.from) * t;
    const lo = Math.floor(tween), hi = Math.ceil(tween), frac = tween - lo;
    let sF = lo, sC = hi;
    for (let n = kMaxScoreTiles - 1; n >= 0; n--) {
      const d1 = sF % 10, d2 = sC % 10;
      if (d1 === d2) this.scoreTiles[n].setFrameNbr(d1);
      else this.scoreTiles[n].setFrameNbrOfst(d1, frac);
      sF = Math.floor(sF / 10);
      sC = Math.floor(sC / 10);
    }
    if (hi === lo && hi === a.end) {
      this.snd.play(SND.Bell);
      this.scoreAnim = null;
    }
  }

  addTextSprite(x, y, str, flags) {
    this.onText && this.onText(x, y, str, flags);   // multiplayer host: guests show it too
    if (this.textSprites.length >= 32) return;
    const big = flags & 1;
    this.textSprites.push({
      x, y, str, birth: this.time,
      lifespan: big ? 2.0 : 1.0,
      c1: big ? [0.8, 0, 0.8] : [0.66, 0.66, 0],
      c2: big ? [0.8, 0.8, 0.8] : [0.66, 0.66, 0.66],
      minSize: 0.2, maxSize: big ? 0.6 : 0.4,
    });
  }

  updateTextSprites() {
    this.textSprites = this.textSprites.filter((ss) => this.time - ss.birth <= ss.lifespan);
    for (const ss of this.textSprites) {
      ss.x = this.bindXToPlayer(ss.x);
      ss.y = this.bindYToPlayer(ss.y);
    }
  }

  // ------------------------------------------------------------ top scores

  loadTopScores(mode = 'single') {
    const saved = loadPref(scoresKey(mode), null);
    if (Array.isArray(saved) && saved.length === kMaxScoreRecs) return saved;
    if (mode !== 'single') return this.padScores([]);   // multiplayer boards start empty
    const recs = [];
    for (let i = 0; i < kMaxScoreRecs; i++)
      recs.push(i < 8 ? { score: 5000 - 200 * i, level: 0, name: 'jbum' } : { score: 0, level: 0, name: '' });
    recs[0].score = 777770;
    return recs;
  }

  // Pull the shared Hall of Cheese (keeps the local list if it can't be reached)
  get topScores() { return this.boards[this.boardMode] || (this.boards[this.boardMode] = this.loadTopScores(this.boardMode)); }
  set topScores(recs) { this.boards[this.boardMode] = recs; }

  setBoard(mode) {
    if (!BOARD_TITLES.hasOwnProperty(mode) || mode === this.boardMode) return;
    this.boardMode = mode;
    this.lastHighScoreIdx = -1;
  }

  async refreshScores() {
    const mode = this.boardMode;
    const scores = await fetchScores(mode);
    if (!scores || this.state === GS.Engrave || mode !== this.boardMode) return;
    this.sharedScores = true;
    this.topScores = this.padScores(scores);
    this.lastHighScoreIdx = this.lastHighScoreId == null ? -1 :
      this.topScores.findIndex((r) => r.id === this.lastHighScoreId);
  }

  padScores(scores) {
    const recs = scores.slice(0, kMaxScoreRecs).map((r) => ({ score: r.score, level: r.level, name: r.name, id: r.id }));
    while (recs.length < kMaxScoreRecs) recs.push({ score: 0, level: 0, name: '' });
    return recs;
  }

  isNewHighScore() {
    return this.gameScore > this.topScores[kMaxScoreRecs - 1].score;
  }

  startEngraveMode() {
    this.snd.play(SND.HighScore1);
    this.engraveMsg = '';
    this.engraveBusy = false;
    let i;
    for (i = kMaxScoreRecs - 1; i >= 0; --i)
      if (this.topScores[i].score > this.gameScore) break;
    ++i;
    this.topScores.splice(i, 0, { score: this.gameScore, level: this.gameLevel, name: this.nameBuf });
    this.topScores.length = kMaxScoreRecs;
    this.lastHighScoreIdx = i;
    this.setState(GS.Engrave);
  }

  setEngraveName(name) {
    this.nameBuf = name.replace(/[^\x20-\x7e]/g, '').slice(0, kMaxNameLen);
  }

  async finishEngrave() {
    if (this.state !== GS.Engrave || this.engraveBusy) return;
    if (!this.nameBuf.trim()) {
      this.engraveMsg = 'Please engrave a name.';
      this.ui && this.ui.engraveRetry && this.ui.engraveRetry();
      return;
    }
    this.topScores[this.lastHighScoreIdx].name = this.nameBuf;
    savePref(NAME_KEY, this.nameBuf);
    this.engraveBusy = true;
    this.engraveMsg = 'Engraving...';
    const result = await submitScore({
      name: this.nameBuf,
      score: this.gameScore,
      level: this.gameLevel,
      seconds: Math.round(this.time - (this.gameStartTime || this.time)),
      mode: this.boardMode,
    });
    this.engraveBusy = false;
    if (this.state !== GS.Engrave) return;
    if (result && !result.ok) {
      // e.g. the name didn't pass the PG-13 check: pick another
      this.engraveMsg = result.message;
      if (result.error === 'name') {
        this.ui && this.ui.engraveRetry && this.ui.engraveRetry();
        return;
      }
    }
    if (result && result.ok && result.rank != null) {
      // the shared board, with this score highlighted
      this.sharedScores = true;
      this.topScores = this.padScores(result.scores);
      this.lastHighScoreId = result.id;
      this.lastHighScoreIdx = result.rank <= kMaxScoreRecs ? result.rank - 1 : -1;
    }
    // offline, pending review, or refused: show the local list with the entry
    savePref(scoresKey(this.boardMode), this.topScores.map(({ score, level, name }) => ({ score, level, name })));
    this.engraveMsg = '';
    this.beginAttract(AT.TopScores);
  }

  // ------------------------------------------------------------ camera

  startCameraAnimation(finalRoll, finalHeight, finalAlpha, duration) {
    const recs = [
      { key: 'cameraRoll', from: this.cameraRoll, to: finalRoll },
      { key: 'visH', from: Math.log10(this.visH), to: Math.log10(finalHeight), log: true },
      { key: 'fgAlpha', from: this.fgAlpha, to: finalAlpha },
    ];
    if (this.offsetX !== 0 || this.offsetY !== 0) {
      recs.push({ key: 'offsetX', from: this.offsetX, to: 0 });
      recs.push({ key: 'offsetY', from: this.offsetY, to: 0 });
    }
    this.anim = { start: this.time, duration, recs };
  }

  updateCamera() {
    const a = this.anim;
    if (!a) return;
    let t = (this.time - a.start) / a.duration;
    if (t >= 1) {
      t = 1;
      this.anim = null;
    }
    t *= t * (3 - 2 * t);   // ease
    for (const r of a.recs) {
      const v = r.from + (r.to - r.from) * t;
      this[r.key] = r.log ? Math.pow(10, v) : v;
    }
  }

  zoom(factor) {
    const h = this.visH * factor;
    if (h > 100 && h < this.univWidth) this.visH = h;
  }

  // ------------------------------------------------------------ view geometry

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Size from the canvas's own box on screen, not window.innerWidth/Height:
    // on iPad those can differ from the box (after the on-screen keyboard, or
    // while Safari's bars change), and the picture then stretches on one axis.
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width || window.innerWidth;
    this.cssH = r.height || window.innerHeight;
    const w = Math.round(this.cssW * dpr);
    const h = Math.round(this.cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cw = w;
    this.ch = h;
    // device pixels per world unit at the normal zoom: an 800x600 view fits the screen
    this.baseScale = Math.min(w / 800, h / 600);
    // Browser port: on short screens (phones in landscape) the 800x600 fit is
    // limited by height and shows ~1300 units across with tiny sprites, so play
    // zooms in until about 750 units fit across, at most 1.75x (on an iPhone 15
    // the teapot goes from 5 to 9 mm).  Attract screens keep the normal zoom
    // (their text is laid out for it).
    const zoom = this.cssH < 500 ? Math.min(Math.max(w / (750 * this.baseScale), 1), 1.75) : 1;
    this.playVisH = kFixedVisHeight / zoom;
    if (this.state === GS.Play && !this.anim) this.visH = this.playVisH;
  }

  // visH that makes the visible width equal w
  visHForWidth(w) {
    return w * this.baseScale * kFixedVisHeight / this.cw;
  }

  starView() {
    return {
      cw: this.cw, ch: this.ch,
      // 45-degree perspective: at the far plane 604.8 units fill a 600-unit view
      s0: this.baseScale * kFixedVisHeight / 604.8,
      offX: this.offsetX, offY: this.offsetY,
    };
  }

  // Everything the renderer needs for this frame
  computeView(lerp) {
    const ppu = this.baseScale * kFixedVisHeight / this.visH;
    this.visPlayWidth = this.cw / ppu;
    let offX = this.offsetX, offY = this.offsetY;
    if (this.state === GS.Play && lerp < 1) {
      const dx = offX - this.prevOffX, dy = offY - this.prevOffY;
      if (Math.abs(dx) < this.univRadX && Math.abs(dy) < this.univRadY) {
        offX = this.prevOffX + dx * lerp;
        offY = this.prevOffY + dy * lerp;
      }
    }
    const th = -this.cameraRoll * Math.PI / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    const g = this.baseScale;
    return {
      cw: this.cw, ch: this.ch, ppu, offX, offY, lerp,
      // world matrix, applied to (x - offX, -(y - offY))
      m: { a: cos * ppu, b: sin * ppu, c: -sin * ppu, d: cos * ppu, e: this.cw / 2, f: this.ch / 2 },
      guiScale: g,
      guiRadX: this.cw / 2 / g,
      guiRadY: this.ch / 2 / g,
      s0: g * kFixedVisHeight / 604.8,
    };
  }

  // ------------------------------------------------------------ rendering

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.cw, this.ch);
  }

  // world-space transform with y flipped, for text and clouds
  setWorldTransform(v) {
    const { a, b, c, d, e, f } = v.m;
    this.ctx.setTransform(a, b, c, d, e, f);
    this.ctx.translate(-v.offX, v.offY);
  }

  setGuiTransform(v) {
    this.ctx.setTransform(v.guiScale, 0, 0, v.guiScale, this.cw / 2, this.ch / 2);
  }

  drawBackground(v) {
    this.stars.render(this.ctx, { cw: v.cw, ch: v.ch, s0: v.s0, offX: v.offX, offY: v.offY });
    this.drawClouds(v);
  }

  drawClouds(v) {
    const ctx = this.ctx;
    const { a, b, c, d, e, f } = v.m;
    ctx.setTransform(a, b, c, d, e, f);
    // one copy of the clouds image covers the whole universe
    const sx = this.univWidth / this.textures[TXT.Clouds].image.width;
    const sy = this.univHeight / this.textures[TXT.Clouds].image.height;
    if (this.cloudPattern.setTransform) {
      this.cloudPattern.setTransform(new DOMMatrix([sx, 0, 0, sy,
        -this.univRadX - v.offX, -this.univRadY + v.offY]));
    }
    const hd = Math.hypot(v.cw, v.ch) / v.ppu / 2 + 2;
    ctx.globalAlpha = 32 / 255;
    ctx.fillStyle = this.cloudPattern;
    ctx.fillRect(-hd, -hd, hd * 2, hd * 2);
    ctx.globalAlpha = 1;
  }

  // Multiplayer teapots are tinted by their player's color slot (join order)
  teapotTint(sp) {
    if (sp.type !== ST.Teapot) return null;
    if ((this.remote || this.players.length > 1) && this.isBotTeapot(sp)) return this.duel ? BOT_TINT_RIVAL : BOT_TINT_COOP;
    let slot = 0;
    if (this.remote) slot = this.remote.slotOf(sp.ownerId);
    else if (this.players.length > 1 && sp.owner) slot = sp.owner.slot;
    return slot ? TEAPOT_TINTS[slot % TEAPOT_TINTS.length] : null;
  }

  // bots' teapots wear a blinking LED on the lid
  isBotTeapot(sp) {
    if (sp.type !== ST.Teapot) return false;
    if (this.remote) return this.remote.isBot(sp.ownerId);
    return !!(sp.owner && sp.owner.bot);
  }

  drawSprite(v, sp) {
    if (!sp.visible || sp.nbrFrames === 0) return;
    let x = sp.x, y = sp.y;
    const lerp = v.lerp;
    if (lerp < 1) {
      const dx = x - sp.prevX, dy = y - sp.prevY;
      if (Math.abs(dx) < this.univRadX && Math.abs(dy) < this.univRadY) {
        x = sp.prevX + dx * lerp;
        y = sp.prevY + dy * lerp;
      }
    }
    let rx = x - v.offX, ry = y - v.offY;
    if (rx < -this.univRadX) rx += this.univWidth;
    else if (rx > this.univRadX) rx -= this.univWidth;
    if (ry < -this.univRadY) ry += this.univHeight;
    else if (ry > this.univRadY) ry -= this.univHeight;

    const { a, b, c, d, e, f } = v.m;
    const px = a * rx - c * ry + e, py = b * rx - d * ry + f;
    const r = sp.rad;
    // cull anything well off screen
    const reach = r * v.ppu * 1.5;
    if (px < -reach || py < -reach || px > v.cw + reach || py > v.ch + reach) return;

    const th = -sp.rotation * Math.PI / 180;
    const cs = Math.cos(th), sn = Math.sin(th);
    const ctx = this.ctx;
    ctx.setTransform(a * cs + c * sn, b * cs + d * sn, c * cs - a * sn, d * cs - b * sn, px, py);
    ctx.globalAlpha = Math.max(0, Math.min(1, sp.rgba[3] * this.fgAlpha));
    const img = this.textures[sp.textureID].image;
    let rgba = sp.rgba;
    const tint = this.teapotTint(sp);
    if (tint) rgba = [rgba[0] * tint[0], rgba[1] * tint[1], rgba[2] * tint[2], rgba[3]];
    if (rgba[0] !== 1 || rgba[1] !== 1 || rgba[2] !== 1) {
      const tinted = tintedCell(img, sp.sx, sp.sy, sp.cell, sp.cell, [rgba[0], rgba[1], rgba[2]]);
      ctx.drawImage(tinted, -r, -r, r * 2, r * 2);
    } else {
      ctx.drawImage(img, sp.sx, sp.sy, sp.cell, sp.cell, -r, -r, r * 2, r * 2);
    }
    if (this.isBotTeapot(sp)) {
      const on = (this.time * 1.5) % 1 < 0.6;
      const lr = r * 0.09;
      ctx.globalAlpha = Math.max(0, Math.min(1, sp.rgba[3] * this.fgAlpha));
      if (on) {
        ctx.fillStyle = 'rgba(255, 200, 40, 0.3)';
        ctx.beginPath(); ctx.arc(0, -r * 0.62, lr * 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? '#ffe070' : '#5a4010';   // amber: no player's tint
      ctx.beginPath(); ctx.arc(0, -r * 0.62, lr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawSprites(v, filter) {
    for (const sp of this.sprites) {
      if (sp.active && (!filter || filter(sp))) this.drawSprite(v, sp);
    }
  }

  drawTextSprites(v) {
    const font = this.font;
    font.setFont('comic');
    this.setWorldTransform(v);
    for (const ss of this.textSprites) {
      const t = (this.time - ss.birth) / ss.lifespan;
      const alpha = Math.max(0, (1 - t) * this.fgAlpha);
      font.setScale(ss.minSize + t * (ss.maxSize - ss.minSize));
      font.setColor(...ss.c1, alpha);
      font.setColor2(...ss.c2, alpha);
      font.puts(this.ctx, ss.x, ss.y, ss.str);
    }
    font.setScale(0);
  }

  renderIntro() {
    this.clear();
    const v = this.computeView(1);
    this.stars.render(this.ctx, { cw: v.cw, ch: v.ch, s0: v.s0, offX: 0, offY: 0 });
    if (this.introTitleRect) {
      const L = this.introTitleLayout(v, this.introTitleRect);
      this.setGuiTransform(v);
      this.drawTitleLayout(L);
    }
  }

  // The start screen's title: the attract title on one line, centered in
  // rect (canvas pixels, from the start panel's placeholder heading).
  // Returns a layout for drawTitleLayout, in GUI units.
  introTitleLayout(v, rect) {
    const font = this.font;
    const t = this.time;
    const g = v.guiScale;
    const words = ['CHEESE', 'TOAST'];
    font.setFont('goudy');
    font.setSize(36);
    // Goudy's space is very wide, so the words are drawn separately with a
    // narrower gap
    const gap = font.font.spaceAX * 0.5;
    const ws = words.map((w) => font.strWidth(w));
    const raw = ws[0] + gap + ws[1];          // in font units
    // fill the heading's box and then some, within 80% of the screen width
    const width = Math.max(Math.min(rect.w * 1.3 / g, v.guiRadX * 2 * 0.8), raw * font.scale);
    // fly in from a distance once loading is done: small and transparent,
    // growing with an ease-in so it speeds up as it arrives
    if (this.introTitleStart == null) this.introTitleStart = t;
    const p = Math.min((t - this.introTitleStart) / kIntroTitleSecs, 1);
    const grow = 0.03 + 0.97 * p * p * p;
    const alpha = Math.min(p * 2, 1);
    const k = width / (raw * font.scale) * grow;   // relative to the attract title
    const s = font.scale * k;
    const cap = font.font.glyphs['C'.charCodeAt(0)];
    const cx = (rect.x + rect.w / 2 - this.cw / 2) / g;
    const cy = -(rect.y + rect.h / 2 - this.ch / 2) / g;
    const y = cy - cap.oy * s + cap.h * s / 2;
    const x0 = cx - raw * s / 2;
    const x1 = x0 + (ws[0] + gap) * s;
    // The wiggle (the same damped spring as the attract title) gets its burst
    // of energy when the title brakes to a stop, then settles.
    const arrived = t - this.introTitleStart - kIntroTitleSecs;
    const damp = Math.max(arrived, 1);
    // (1 - e^-12a) starts the circle at its center, so arrival doesn't jump
    const kick = arrived < 0 ? 0 : (1 - Math.exp(-12 * arrived)) * 1.5 / damp * k;
    const y1 = Math.sin(arrived * 4) * kick;
    const y2 = -Math.cos(arrived * 4) * kick;
    return {
      s, alpha, words: [
        // warp noise is sampled at the attract title's resting spots (n*), so
        // the letters wobble the same way however fast the title moves
        { text: words[0], sx: x0 + 4 * k + y2, sy: y - 4 * k + y1, fx: x0 + y2 * 3, fy: y + y1 * 3,
          snx: -360, sny: 240, fnx: -364, fny: 244 },
        { text: words[1], sx: x1 + 4 * k + y1, sy: y - 4 * k + y2, fx: x1 + y1 * 3, fy: y + y2 * 3,
          snx: -342, sny: 200, fnx: -348, fny: 204 },
      ],
    };
  }

  // The attract title (CTAttract.cpp), in world units
  attractTitleLayout() {
    const t = this.time;
    this.font.setFont('goudy');
    this.font.setSize(36);
    const damp = Math.max(t - this.wiggleStart, 1);
    const y1 = Math.sin(t * 4) * 3 / damp;
    const y2 = -Math.cos(t * 4) * 3 / damp;
    return {
      s: this.font.scale, alpha: this.fgAlpha, words: [
        { text: 'CHEESE', sx: -360 + y2, sy: 212 + y1, fx: -364 + y2 * 3, fy: 216 + y1 * 3 },
        { text: 'TOAST', sx: -342 + y1, sy: 172 + y2, fx: -348 + y1 * 3, fy: 176 + y2 * 3 },
      ].map((w) => ({ ...w, snx: w.sx, sny: w.sy, fnx: w.fx, fny: w.fy })),   // CT_III's, 28 units lower (mode bar)
    };
  }

  drawTitleLayout(L) {
    const ctx = this.ctx;
    const font = this.font;
    font.setFont('goudy');
    font.setScale(L.s);
    font.setWarp(true);
    font.setColor(0.18, 0.18, 0.18, L.alpha);
    for (const w of L.words) {
      font.setWarpOrigin(w.snx, w.sny);
      font.puts(ctx, w.sx, w.sy, w.text);
    }
    this.setTitleColors(this.time, L.alpha);
    for (const w of L.words) {
      font.setWarpOrigin(w.fnx, w.fny);
      font.puts(ctx, w.fx, w.fy, w.text);
    }
    font.setWarpOrigin(null);
    font.setWarp(false);
    font.setFont('comic');
  }

  // the title's cycling tint: [bottom rgb, top rgb]
  titleColors(t) {
    return [
      [1, (128 + 127 * Math.sin(t)) / 255, (128 + 127 * Math.cos(t)) / 255],
      [(128 + 64 + 63 * Math.sin(t)) / 255, 128 / 255, (128 + 127 * Math.sin(t)) / 255],
    ];
  }

  setTitleColors(t, a) {
    const [c1, c2] = this.titleColors(t);
    this.font.setColor(...c1, a);
    this.font.setColor2(...c2, a);
  }

  renderGame() {
    const lerp = (this.state === GS.Play || this.state === GS.GameOver) ? this.acc / TICK : 1;
    const v = this.computeView(lerp);
    this.view = v;
    if (this.state !== GS.Pause)
      this.stars.update(this.dt, this.starView());
    this.clear();
    this.drawBackground(v);
    this.drawTextSprites(v);
    this.sparks.render(this.ctx, v.m, v, lerp);
    this.drawSprites(v);
    if (this.state === GS.Play) this.drawShieldGauge(v);
    if (this.wantsStats) this.drawWhorlOutlines(v);
    this.renderStatusDisplay(v);
    this.renderRadar(v);
    this.drawExtras && this.drawExtras(v);   // multiplayer chat balloons and name tags (chat.js)
  }

  // Stats overlay: where the whorls' pull starts (for tuning the gravity)
  drawWhorlOutlines(v) {
    const ctx = this.ctx;
    this.setWorldTransform(v);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2 / v.ppu;
    ctx.setLineDash([8 / v.ppu, 8 / v.ppu]);
    for (const w of WHORLS) {
      // draw the copy nearest the camera (the universe wraps)
      const d = { x: w.x - v.offX, y: w.y - v.offY };
      this.bindToUniverseTorus(d);
      ctx.beginPath();
      ctx.ellipse(v.offX + d.x, -(v.offY + d.y), w.rx * kWhorlReach, w.ry * kWhorlReach, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Browser port (CT_III's Todo.txt: "Add shield-power display"): a bar under
  // level / pots.  Green when full, yellow by 70, red below 40, which is where
  // the shield bubble starts to sputter red.
  // Shield gauge (browser port): while the shield is up, a short line right under your own teapot,
  // green -> yellow by 70 -> red below 40 (where shieldMove sputters).  Only
  // your own; other players' teapots have their name there instead.
  drawShieldGauge(v) {
    const sp = this.local.ship;
    if (!sp || !sp.active || !sp.visible || sp.type !== ST.Teapot) return;
    // only while the shield is up, fading out over half a second after it drops
    const sh = this.local.shield;
    if (sh && sh.active && sh.visible) this.shieldShownAt = this.time;   // the shield sprite always exists; it shows while up
    const since = this.time - (this.shieldShownAt ?? -99);
    if (since > 0.5) return;
    const fade = since <= 0 ? 1 : 1 - since / 0.5;
    const f = Math.max(0, Math.min(1, this.local.shieldPower / MaxShieldPower));
    const mix = (p, q, t) => p.map((c, i) => c + (q[i] - c) * t);
    const green = [0.25, 1, 0.35], yellow = [1, 0.9, 0.2], orange = [1, 0.55, 0.1], red = [1, 0.15, 0.1];
    const rgb = f >= 0.7 ? mix(yellow, green, (f - 0.7) / 0.3)
      : f >= 0.4 ? mix(orange, yellow, (f - 0.4) / 0.3) : red;
    // the teapot's interpolated screen position (as drawSprite)
    let x = sp.x, y = sp.y;
    if (v.lerp < 1) {
      const dx = x - sp.prevX, dy = y - sp.prevY;
      if (Math.abs(dx) < this.univRadX && Math.abs(dy) < this.univRadY) { x = sp.prevX + dx * v.lerp; y = sp.prevY + dy * v.lerp; }
    }
    const d = { x: x - v.offX, y: y - v.offY };
    this.bindToUniverseTorus(d);
    const { a, b, c, d: dd, e, f: ff } = v.m;
    const px = a * d.x - c * d.y + e, py = b * d.x - dd * d.y + ff;
    const k = this.cw / this.cssW;                 // device pixels per CSS pixel
    const w = Math.max(sp.rad * v.ppu * 1.4, 24 * k), h = Math.max(2 * k, 2);
    const top = py + sp.rad * v.ppu * 0.8 + 2 * k;   // the sprite cell has a margin below the teapot
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = this.fgAlpha * 0.3 * fade;
    ctx.fillStyle = 'rgb(120, 140, 150)';
    ctx.fillRect(px - w / 2, top, w, h);
    ctx.globalAlpha = this.fgAlpha * 0.85 * fade;
    ctx.fillStyle = `rgb(${rgb.map((cc) => Math.round(cc * 255)).join(',')})`;
    ctx.fillRect(px - w / 2, top, w * f, h);
    ctx.restore();
  }


  renderStatusDisplay(v) {
    this.updateStatusDisplay();
    const ctx = this.ctx;
    const font = this.font;
    const guiRadY = v.guiRadY;

    // score digits: cyan at the top, magenta at the bottom, half transparent
    const img = this.textures[TXT.ScoreNumbers].image;
    this.setGuiTransform(v);
    ctx.globalAlpha = 0.5;
    for (const sp of this.scoreTiles) {
      const key = sp.sx + ',' + (sp.sy + sp.syOfs);
      if (sp.tintKey !== key) {
        sp.tintKey = key;
        const s = sp.tint.ctx;
        s.globalCompositeOperation = 'copy';
        s.drawImage(img, sp.sx, sp.sy + sp.syOfs, sp.cell, sp.cell, 0, 0, 60, 60);
        s.globalCompositeOperation = 'source-atop';
        const grad = s.createLinearGradient(0, 0, 0, 60);
        grad.addColorStop(0, 'rgb(127,255,255)');
        grad.addColorStop(1, 'rgb(255,127,255)');
        s.fillStyle = grad;
        s.fillRect(0, 0, 60, 60);
      }
      ctx.drawImage(sp.tint, sp.x - sp.rad, -(guiRadY - 16) - sp.rad, sp.rad * 2, sp.rad * 2);
    }
    ctx.globalAlpha = 1;

    this.setGuiTransform(v);
    font.setFont('comic');
    font.setSize(18);
    font.setColor(0, 1, 1, this.fgAlpha);
    font.setColor2(0.784, 1, 1, this.fgAlpha);
    const top = guiRadY - 32;
    font.puts(ctx, 200, top, 'level ' + this.gameLevel);
    font.puts(ctx, 315, top, 'pots x ' + this.remainingShips);
    if (this.wantsStats) {
      font.setSize(12);
      const lines = [
        'fps: ' + this.fps.toFixed(1),
        'sprites: ' + this.spriteCnt + ' / ' + this.sprites.length,
        'sparks: ' + this.sparks.count,
        'pos: ' + this.offsetX.toFixed(0) + ', ' + this.offsetY.toFixed(0),
        'asteroids: ' + this.asteroidCnt + ' / ' + Math.round(this.minAsteroids * this.difficultyScale()),
        'whorl pull: ' + Math.round((this.whorlPull || 0) * 100) + ' / 100',
        'sound: ' + this.snd.status(),
      ];
      // multiplayer: round trip, snapshot gaps, loss, traffic (net.js statsLines)
      if (this.netInfo) lines.push(...this.netInfo());
      lines.forEach((s, i) => font.puts(ctx, 200, top - 21 * (i + 2), s));
      font.setSize(18);
    }
    if (this.message) font.puts(ctx, -1, 12, this.message);
  }

  radarCenter(v) {
    if (this.touchMode)   // the touch buttons own the bottom corners
      return [-v.guiRadX + 110, v.guiRadY - 110];
    // lower left (CT_III had it lower right, where the browser port's
    // full screen / sound / pause buttons now sit)
    return [-v.guiRadX * 2 / 3, -v.guiRadY * 2 / 3];
  }

  renderRadar(v) {
    const ctx = this.ctx;
    const kRadarRad = this.normalVisPlayRad * 2;
    const kRadarScale = 0.1;
    const [cx, cy] = this.radarCenter(v);
    const g = v.guiScale;
    const dot = Math.max(1.5, 2 * this.ch / 768);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const sp of this.sprites) {
      const color = sp.def.radarColor;
      if (!color || !sp.active) continue;
      const dist = this.distanceToLocalPlayer(sp, null);
      if (dist >= kRadarRad) continue;
      const rx = this.bindXToPlayer(sp.x) - this.offsetX;
      const ry = this.bindYToPlayer(sp.y) - this.offsetY;
      const sx = this.cw / 2 + (cx + rx * kRadarScale) * g;
      const sy = this.ch / 2 - (cy + ry * kRadarScale) * g;
      const k = this.fgAlpha;
      ctx.fillStyle = `rgb(${((color >> 16) & 255) * k | 0},${((color >> 8) & 255) * k | 0},${(color & 255) * k | 0})`;
      ctx.fillRect(sx - dot / 2, sy - dot / 2, dot, dot);
    }
    // the lens
    this.setGuiTransform(v);
    const lensR = kRadarRad * kRadarScale;
    ctx.globalAlpha = 32 / 255 * this.fgAlpha;
    ctx.drawImage(this.textures[TXT.Radar].image, cx - lensR, -cy - lensR, lensR * 2, lensR * 2);
    // browser port: a faint gray rim so the radar's edge reads against the sky
    ctx.globalAlpha = 0.1 * this.fgAlpha;
    ctx.strokeStyle = 'rgb(170, 170, 180)';
    // half a CSS pixel (one device pixel on 2x screens), never under one device pixel
    ctx.lineWidth = Math.max(0.5 * this.cw / this.cssW, 1) / g;
    ctx.beginPath();
    ctx.arc(cx, -cy, lensR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  renderAttract() {
    const v = this.computeView(1);
    this.view = v;
    this.stars.update(this.dt, this.starView());
    this.clear();
    this.drawBackground(v);

    if (this.attractMode === AT.Beastiary)
      this.sprites.slice(0, TEA_SPRITE).forEach((sp) => sp.active && this.drawSprite(v, sp));
    else if (this.attractMode === AT.Motto)
      this.drawSprite(v, this.sprites[TEA_SPRITE]);

    const ctx = this.ctx;
    const font = this.font;
    const a = this.fgAlpha;
    this.setWorldTransform(v);
    font.setFont('comic');
    switch (this.attractMode) {
      case AT.TopScores:
        this.renderTopScores();
        break;
      case AT.Instructions: {
        font.setColor(0, 0.8, 0.8, a);
        font.setColor2(0.8, 0.8, 0.8, a);
        font.setSize(18);
        const lines = this.touchMode ? [
          'Tap to Play',
          'Point in the circle to turn that way',
          'Double-tap its middle to brake',
          'Right buttons fire, thrust and shield',
          'Tap the speaker to toggle sound',
        ] : [
          'Hit P to Play',
          'Arrows turn, Down brakes',
          'Space fires, Z or X thrusts',
          'A or S shields, M for sound, F full screen',
        ];
        lines.forEach((s, i) => font.puts(ctx, -1, 20 * 6 - i * 60, s));
        break;
      }
      case AT.Beastiary:
        SPRITE_DESC.slice(0, TEA_SPRITE).forEach(([name, pts], i) => {
          const y = -((kDescTop + i * kLineHeight) - 300);
          font.setColor(0.8, 0, 0.8, a);
          font.setColor2(0.8, 0.8, 0.8, a);
          font.setSize(18);
          font.puts(ctx, 0, y, name);
          font.setSize(12);
          font.puts(ctx, 0, y - 20, pts);
        });
        break;
      case AT.Motto:
        // CT_III went from (0, 0, 0.66) at the bottom of each letter to 0.66
        // gray; that navy was hard to read on the night sky, so it's lifted
        font.setColor(0.4, 0.5, 1, a);
        font.setColor2(0.8, 0.8, 0.85, a);
        font.setSize(18);
        font.puts(ctx, -1, 80, 'Neither cheese nor toast');
        font.puts(ctx, -1, 40, 'will keep this little teapot');
        font.puts(ctx, -1, 0, 'from its appointed rounds.');
        font.setSize(10);
        font.setColor(0.66, 0, 0.66, a);
        font.setColor2(0.66, 0.66, 0.66, a);
        font.puts(ctx, -1, -220, 'Program, Graphics and Sound copyright 1995,2003 Jim Bumgardner, all rights reserved');
        font.puts(ctx, -1, -240, 'Browser port 2026');
        break;
    }
    this.drawTitle(v);
  }

  renderTopScores() {
    const ctx = this.ctx;
    const font = this.font;
    const a = this.fgAlpha;
    font.setColor(0.8, 0.8, 0, a);
    font.setColor2(0.8, 0.8, 0.8, a);
    font.setFont('goudy');
    font.setSize(36);
    font.setWarp(true);
    const sub = BOARD_TITLES[this.boardMode];
    font.puts(ctx, -1, sub ? 142 : 120, 'HALL OF CHEESE');
    font.setWarp(false);
    font.setFont('comic');
    if (sub) {
      font.setSize(16);
      font.setColor(0, 0.8, 0.8, a);
      font.setColor2(0.8, 0.8, 0.8, a);
      font.puts(ctx, -1, 102, sub);
      if (!this.topScores.some((r) => r.score)) font.puts(ctx, -1, 30, 'No scores yet');
    }
    font.setSize(14);
    this.topScores.forEach((rec, i) => {
      if (!rec.score) return;
      const y = 80 - i * 30;
      if (i === this.lastHighScoreIdx) {
        font.setColor(1, 1, 0.25, a);
        font.setColor2(1, 1, 1, a);
      } else {
        font.setColor(0.8, 0.8, 0, a);
        font.setColor2(0.8, 0.8, 0.8, a);
      }
      font.puts(ctx, -100, y, '#' + (i + 1));
      font.puts(ctx, -60, y, String(rec.score));
      if (rec.name.startsWith(BOT_PREFIX)) {
        // fill-in bots: the robot face (system font; the bitmap font has no emoji)
        ctx.save();
        ctx.globalAlpha = a;
        ctx.font = '15px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('\u{1F916}', 32, -y + 1);
        ctx.restore();
        font.puts(ctx, 54, y, rec.name.slice(BOT_PREFIX.length));
      } else {
        font.puts(ctx, 32, y, rec.name);
      }
    });
  }

  // Name entry layout (world units at the normal zoom).  On short screens
  // (phones in landscape) everything is larger and sits in the upper half,
  // above the on-screen keyboard.
  engraveLayout() {
    const phone = this.cssH < 500;
    return phone
      ? { k: 1.35, dy: 70, line1: 62, line2: 36, text: 16.5, boxY: 0, boxW: 420, boxH: 44 }
      : { k: 1, dy: 0, line1: 90, line2: 55, text: 14, boxY: 0, boxW: 420, boxH: 44 };
  }

  renderEngrave() {
    const v = this.computeView(1);
    this.view = v;
    this.stars.update(this.dt, this.starView());
    this.clear();
    this.drawBackground(v);
    const ctx = this.ctx;
    const font = this.font;
    const a = this.fgAlpha;
    const L = this.engraveLayout();
    this.setWorldTransform(v);
    ctx.translate(0, -L.dy);   // world y is up; the canvas y is down
    ctx.scale(L.k, L.k);

    font.setFont('comic');
    font.setSize(L.text);
    font.setColor(0.8, 0, 0.8, a);
    font.setColor2(0.8, 0.8, 0.8, a);
    font.puts(ctx, -1, L.line1, "Congratulations!  You're in the Hall of Cheese!!");
    if (this.engraveMsg) {   // e.g. the name didn't pass, or "Engraving..."
      font.setColor(1, 0.75, 0.3, a);
      font.setColor2(1, 1, 0.8, a);
      font.puts(ctx, -1, L.line2, this.engraveMsg);
    } else {
      font.setColor(0.45, 0.9, 1, a);
      font.setColor2(0.85, 1, 1, a);
      font.puts(ctx, -1, L.line2, this.touchMode
        ? 'Type your name in the box, then tap Engrave'
        : 'Type your name in the box, then press Enter');
    }

    // the name box: a glowing rounded rectangle, like the touch buttons
    const { boxW: w, boxH: h, boxY: by } = L;
    const focused = this.engraveFocused;
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-w / 2, -(by + h / 2), w, h, h / 2);
    else ctx.rect(-w / 2, -(by + h / 2), w, h);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(8, 18, 34, 0.75)';
    ctx.fill();
    ctx.shadowColor = 'rgba(127, 233, 238, 0.9)';
    ctx.shadowBlur = (focused ? 16 : 9) * this.baseScale;
    ctx.lineWidth = 2;
    ctx.strokeStyle = focused ? 'rgba(160, 250, 255, 1)' : 'rgba(127, 233, 238, 0.7)';
    ctx.stroke();
    ctx.restore();

    const cursorOn = focused && Math.floor(this.time * 2) % 2 === 0;
    const textY = by - 8;            // baseline: centers the lettering in the box
    if (this.nameBuf) {
      font.setSize(22);
      font.setColor(1, 0.55, 1, a);
      font.setColor2(1, 0.9, 1, a);
      font.puts(ctx, -1, textY, this.nameBuf + (cursorOn ? '_' : ' '));
    } else {
      font.setSize(16);
      font.setColor(0.55, 0.62, 0.7, a * 0.9);
      font.puts(ctx, -1, textY + 1, this.touchMode ? 'Tap here to type your name' : 'Type your name');
      if (cursorOn) {
        font.setSize(22);
        font.setColor(1, 0.55, 1, a);
        font.puts(ctx, -w / 2 + 24, textY, '_');
      }
    }
    if (this.touchMode) this.drawKeyboardIcon(ctx, w / 2 - 34, by, a);
    this.drawTitle(v);
  }

  // A little keyboard glyph (touch screens): says "tap to type" without words
  drawKeyboardIcon(ctx, cx, cy, alpha) {
    const kw = 34, kh = 22;
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.translate(cx, -cy);
    ctx.strokeStyle = 'rgba(160, 240, 250, 1)';
    ctx.fillStyle = 'rgba(160, 240, 250, 1)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-kw / 2, -kh / 2, kw, kh, 3);
    else ctx.rect(-kw / 2, -kh / 2, kw, kh);
    ctx.stroke();
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 6; col++)
        ctx.fillRect(-kw / 2 + 4 + col * 4.6, -kh / 2 + 4 + row * 4.6, 2.6, 2.6);
    ctx.fillRect(-kw / 2 + 8, kh / 2 - 6.5, kw - 16, 2.6);   // space bar
    ctx.restore();
  }

  drawTitle(v) {
    const h = this.titleHandoff;
    if (h) {
      // After the start tap: glide the start screen's title onto the attract
      // title's resting place (world units = GUI units once the intro camera
      // lands), on the camera's schedule and ease, then hand off.
      let p = (this.time - h.start) / h.duration;
      if (p < 1 && this.state === GS.Attract) {
        p = Math.max(p, 0);
        const e = p * p * (3 - 2 * p);
        const A = this.introTitleLayout(v, h.rect);
        const B = this.attractTitleLayout();
        const mix = (x, y) => x + (y - x) * e;
        const L = {
          s: mix(A.s, B.s),
          alpha: mix(A.alpha, 1),
          words: A.words.map((w, i) => {
            const z = B.words[i];
            const out = { text: w.text };
            for (const key of ['sx', 'sy', 'fx', 'fy', 'snx', 'sny', 'fnx', 'fny'])
              out[key] = mix(w[key], z[key]);
            return out;
          }),
        };
        this.setGuiTransform(v);
        this.drawTitleLayout(L);
        return;
      }
      this.titleHandoff = null;
    }
    this.setWorldTransform(v);
    this.drawTitleLayout(this.attractTitleLayout());
  }

  // Where the engraved name sits on screen, in CSS pixels (for the text field)
  engraveNameRect() {
    const v = this.view || this.computeView(1);
    const dpr = this.cw / this.cssW;
    const L = this.engraveLayout();
    const toScreen = (x, y) => {
      const { a, b, c, d, e, f } = v.m;
      const wx = x * L.k, wy = y * L.k + L.dy;   // engrave layout -> world
      const rx = wx - v.offX, ry = -(wy - v.offY);
      return [(a * rx + c * ry + e) / dpr, (b * rx + d * ry + f) / dpr];
    };
    const [x0, y0] = toScreen(-L.boxW / 2, L.boxY + L.boxH / 2);
    const [x1, y1] = toScreen(L.boxW / 2, L.boxY - L.boxH / 2);
    return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }
}

for (const f of PLAYER_FIELDS) {
  Object.defineProperty(Game.prototype, f, {
    get() { return this.cur[f]; },
    set(v) { this.cur[f] = v; },
    configurable: true,
  });
}
