// Sprites and their behaviors, ported from CTSprites.cpp.
// Coordinates are y-up world units, as in the original.

import {
  ST, TXT, SND, SF, KF, SM, Y, kMaxRotIdxAngles,
  BF_ShipCollideFlag, BF_GoodBulletFlag, BF_BadBulletFlag,
  kAsterColor, kBadColor, kYummyColor, kTeaColor, kInvisible,
  kAsterPoints, kSaucerPoints, kCroissantPoints, kSconePoints, kCoffeePotPoints,
  kCubePoints, kMuffinPoints, kBeaterPoints, kMixerPoints, kColanderPoints,
  kCroissantLifeSpan, kCubeLifeSpan, kToasterLifeSpan, kQuakeLifeSpan, kPhotonLifeSpan,
  kBulletLifeSpan, kSmallSparkLifeSpan, kMedSparkLifeSpan, kLargeSparkLifeSpan,
  MaxShieldPower, MaxShipSpeed, BulletSpeed, Debounce, UziDebounce, ShieldIncrease,
  WHORLS, kWhorlPull, kWhorlReach,
} from './constants.js';
import { rnd, randomI } from './util.js';

let G = null;   // the game, set by setGame()
export function setGame(game) { G = game; }

const kHeroFlags = BF_BadBulletFlag;                          // hero is sensitive to bad bullets
const kMonsterFlags = BF_ShipCollideFlag | BF_GoodBulletFlag; // bad guys sensitive to both

export const SF_GUISprite = 0x01;
export const SF_PixelCollisionTest = 0x02;

function def(type, nbrFrames, width, textureID, textureIndex, bulletFlag, radarColor,
  initFlags, points, moveFunc, collideFunc, initFunc, dieFunc) {
  return { type, nbrFrames, width, textureID, textureIndex, bulletFlag, radarColor,
    initFlags, points, moveFunc, collideFunc, initFunc, dieFunc };
}

export class Sprite {
  constructor() {
    this.active = false;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.prevX = 0; this.prevY = 0;
    this.rad = 0;
    this.collideRF = 1;
    this.rotation = 0;
    this.rgba = [1, 1, 1, 1];
    this.f1 = 0; this.f2 = 0;
    this.def = null;
    this.type = 0;
    this.state = 0; this.state2 = 0; this.stateTimer = 0;
    this.frameNbr = 0; this.aniSpeed = 1; this.aniDir = 1;
    this.flags = 0;
    this.targetFlags = 0; this.maxHits = 0; this.hitsTaken = 0;
    this.tickCtr = 0; this.lifeSpan = 0; this.rotIdx = 0;
    this.visible = true;
    this.nbrFrames = 0; this.textureID = 0; this.textureIndex = 0;
    this.cell = 0; this.cols = 1; this.sx = 0; this.sy = 0; this.syOfs = 0;
  }

  init(type, x, y, vx = 0, vy = 0, frameNbr = 0, isDemo = false) {
    this.frameNbr = frameNbr;
    this.rotation = 0;
    this.rgba = [1, 1, 1, 1];
    this.aniSpeed = 1;
    this.aniDir = 1;
    this.tickCtr = 0;
    this.lifeSpan = 0;
    this.state = this.stateTimer = this.state2 = 0;
    this.rotIdx = 0;
    this.flags = 0;
    this.targetFlags = 0;
    this.maxHits = 0;
    this.visible = true;
    this.hitsTaken = 0;
    this.collideRF = 1;
    this.f1 = this.f2 = 0;
    this.rad = 0;
    this.syOfs = 0;
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.vx = vx;
    this.vy = vy;
    this.setType(type, isDemo);
  }

  setType(type, isDemo = false) {
    this.type = type;
    this.def = SDEF[type];
    this.nbrFrames = this.def.nbrFrames;
    this.textureID = this.def.textureID;
    this.textureIndex = this.def.textureIndex;
    this.flags = this.def.initFlags;
    this.collideRF = 1;
    this.rgba = [1, 1, 1, 1];
    if (this.nbrFrames > 0) {
      const tex = G.textures[this.textureID];
      this.cell = tex.tileSize;
      this.rad = this.def.width / 2;
      this.cols = Math.floor(tex.image.width / this.cell);
    }
    if (this.def.initFunc && !isDemo)
      this.def.initFunc(this);
    if (this.nbrFrames)
      this.setFrameNbr(this.frameNbr % this.nbrFrames);
  }

  setFrameNbr(nbr) {
    this.frameNbr = nbr;
    const t = this.textureIndex + nbr;
    this.sx = (t % this.cols) * this.cell;
    this.sy = Math.floor(t / this.cols) * this.cell;
    this.syOfs = 0;
  }

  // Fractional frame number (single-column sprites), used by the rolling score digits
  setFrameNbrOfst(nbr, frac) {
    this.setFrameNbr(nbr);
    this.syOfs = frac * this.cell;
  }

  update() {
    if (this.def.moveFunc)
      this.def.moveFunc(this);
  }
}

// ---------------------------------------------------------------- helpers

function linearMove(sp) {
  sp.x += sp.vx;
  sp.y += sp.vy;
  G.bindToUniverseTorus(sp);
}

function animateLoop(sp) {
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    if (sp.nbrFrames)
      sp.setFrameNbr((sp.frameNbr + 1) % sp.nbrFrames);
  }
}

export function standardSpriteUpdate(sp) {
  linearMove(sp);
  animateLoop(sp);
}

function nullFunc() {}

function soundFrom(snd, sp) {
  const u = { x: 0, y: 0 };
  const dist = G.distanceToLocalPlayer(sp, u);
  G.snd.playFrom(snd, dist, u.x, G);
}

function setVec(sp, x, y) { sp.vx = x; sp.vy = y; }

function hitsForLevel(base) {
  return Math.min(255, base + Math.floor(G.gameLevel / 2));
}

// Returns 16 octant points, clockwise 0-15 starting at 12:00
function getAngleIdx(vx, vy) {
  let idx;
  if (Math.abs(vx) > Math.abs(vy))
    idx = Math.abs(vx) > Math.abs(vy) * 2 ? 3 : 2;
  else
    idx = Math.abs(vx) * 2 > Math.abs(vy) ? 1 : 0;
  if (vy < 0) idx = 7 - idx;
  if (vx < 0) idx = 15 - idx;
  return idx;
}

// 8 octant points starting at 7:00
function getBeaterAngleIdx(vx, vy) {
  return (Math.floor(getAngleIdx(vx, vy) / 2) + 4) % 8;
}

// Bounding-box pre-check used by the collision loops
// Browser port: the box test wraps around the universe's edges, as the exact
// test (isColliding, distanceToPoint) does.  CT_III compared raw coordinates,
// so nothing collided across the seam; that hardly showed in a solo game, but
// three of the four duel and melee starting points sit on a seam, and a
// rival who hadn't moved couldn't be shot (found 2026-10-08).
function inRange(sp, spj) {
  const r = sp.rad + spj.rad;
  let dx = spj.x - sp.x, dy = spj.y - sp.y;
  if (dx > G.univRadX) dx -= G.univWidth; else if (dx < -G.univRadX) dx += G.univWidth;
  if (dy > G.univRadY) dy -= G.univHeight; else if (dy < -G.univRadY) dy += G.univHeight;
  return dx < r && dx > -r && dy < r && dy > -r;
}

// ---------------------------------------------------------------- teapot (the hero)

function initTeapot(sp) {
  sp.collideRF = 0.66;
}

function teapotCollide(sp, collider) {
  if (sp.state & SF.Shield) {
    G.snd.play(SND.DudBullet);
  } else {
    if (collider.type === ST.Teeth) {
      G.eatSprite(sp, collider);
    } else {
      G.newExplosion(sp, ST.RingExplosion, 1.03, 0.93);
      G.newExplosion(sp, ST.Explosion);
      G.explodeSprite(sp, kLargeSparkLifeSpan);
    }
    if (G.shield) {
      G.killSprite(G.shield);
      G.shield = null;
    }
    G.newShip();
  }
}

// Firing origins (converted from bitmap coordinates), 16 headings from 12:00
// Spout tip per rotation frame, measured in the 64-px Teapots cells (y down).
// The cell is drawn 48 units wide, so a pixel is 0.75 units.  CT_III scaled
// these by 0.375 (a leftover from an older sprite size), which put the bullet
// origin halfway between the center and the spout: fine when the spout points
// along the firing direction, visibly off at the 5 and 7 o'clock frames.
// Multiplayer starting points by join order (see newShipTick)
const DUEL_STARTS = [[0, 0], [1920, 0], [960, 960], [-960, 960]];   // far apart
const COOP_STARTS = [[0, 0], [160, 0], [0, -160], [160, -160]];     // a small square

const fcx = (x) => (x - 32) * 0.75;
const fcy = (y) => -(y - 32) * 0.75;
export const FIRING_POS = [
  [33, 14], [41, 15], [49, 16], [56, 18], [61, 20], [64, 24], [60, 27], [47, 30],
  [33, 34], [18, 30], [7, 26], [2, 23], [1, 20], [10, 18], [16, 16], [25, 15],
].map(([x, y]) => [fcx(x), fcy(y)]);

// Browser port: the cloud whorls pull the teapot toward their centers.  The
// pull starts at 0 on a whorl's visible edge and grows with the square of how
// far in you are, so a near pass bends your path and a close one flings you.
export function whorlDepth(x, y) {
  // 0 outside every whorl, rising to 1 at a center; also returns that whorl
  let best = 0, which = null;
  for (const w of WHORLS) {
    const d = { x: w.x - x, y: w.y - y };
    G.bindToUniverseTorus(d);
    const n = Math.hypot(d.x / (w.rx * kWhorlReach), d.y / (w.ry * kWhorlReach));   // 1 where the pull starts
    if (n < 1 && 1 - n > best) { best = 1 - n; which = { w, d }; }
  }
  return { depth: best, which };
}

function applyWhorlPull(sp) {
  const { depth, which } = whorlDepth(sp.x, sp.y);
  G.whorlPull = depth * depth;
  pullToward(sp, depth, which);
}

// Asteroids, enemies and power-ups feel the whorls too (called by the game
// after each one moves).  Drifters keep the extra velocity and curve; enemies
// that steer set their own velocity every tick, so for them it's a nudge
// they can fight.
export function applyWhorlPullToObject(sp) {
  const { depth, which } = whorlDepth(sp.x, sp.y);
  pullToward(sp, depth, which);
}

function pullToward(sp, depth, which) {
  if (!which) return;
  const len = Math.hypot(which.d.x, which.d.y);
  if (len < 1) return;   // dead center: no direction to pull in
  const a = kWhorlPull * depth * depth;
  sp.vx = Math.max(-MaxShipSpeed, Math.min(MaxShipSpeed, sp.vx + which.d.x / len * a));
  sp.vy = Math.max(-MaxShipSpeed, Math.min(MaxShipSpeed, sp.vy + which.d.y / len * a));
}

// The teapot's steering for one tick, as state bits (SF.Left/Right/Thrust/
// Brake), from the keys and the touch circle's heading (target, or -1).
// Browser port: touch steering (input.js's circle) names a heading; turn
// toward it the short way, one step a tick like a held arrow key (so no
// faster than the keyboard), unless an arrow is down.
export function steerBits(rotIdx, keys, target) {
  let st = 0;
  if (keys & KF.Thrust) st |= SF.Thrust;
  if (keys & KF.Left) st |= SF.Left;
  if (keys & KF.Right) st |= SF.Right;
  if (target >= 0 && !(keys & (KF.Left | KF.Right))) {
    const diff = ((target * 2 - rotIdx) % kMaxRotIdxAngles + kMaxRotIdxAngles) % kMaxRotIdxAngles;
    if (diff) st |= diff <= kMaxRotIdxAngles / 2 ? SF.Right : SF.Left;
  }
  if (keys & KF.Brake) st |= SF.Brake;
  return st;
}

// The teapot's motion for one tick from its state bits: turn, tilt, brake,
// thrust, the whorls' pull, move (wrapping is the caller's).  shipMove uses
// it, and so does a guest predicting its own teapot (net.js), so the two
// can't drift apart.  Works on any { x, y, vx, vy, rotIdx, state, state2 }.
export function shipMotion(sp, frozen) {
  const vt = G.vecTable;
  if (sp.state & SF.Left) {
    sp.rotIdx -= 2;
    if (sp.rotIdx < 0) sp.rotIdx = kMaxRotIdxAngles - 2;
  } else if (sp.state & SF.Right) {
    sp.rotIdx += 2;
    if (sp.rotIdx >= kMaxRotIdxAngles) sp.rotIdx = 0;
  }

  // Thrust tilts the teapot over a few frames
  if (sp.state & SF.Thrust) {
    if (sp.state2 < 3) sp.state2++;
  } else if (sp.state2 > 0) {
    sp.state2--;
  }
  sp.frameNbr = (sp.rotIdx >> 1) + sp.state2 * 16;

  if (sp.state & SF.Brake)
    setVec(sp, 0, 0);
  if (sp.state & SF.Thrust) {
    let nx = sp.vx + vt[sp.rotIdx].x;
    let ny = sp.vy + vt[sp.rotIdx].y;
    nx = Math.max(-MaxShipSpeed, Math.min(MaxShipSpeed, nx));
    ny = Math.max(-MaxShipSpeed, Math.min(MaxShipSpeed, ny));
    setVec(sp, nx, ny);
  }
  if (frozen) setVec(sp, 0, 0);
  else applyWhorlPull(sp);

  sp.x += sp.vx;
  sp.y += sp.vy;
}

function shipMove(sp) {
  const vt = G.vecTable;
  const oldState = sp.state;
  sp.state = 0;
  // multiplayer pause (game.js freezePlayer): no keys, held still, untouchable
  // except by rivals' bullets (those hit in bulletMove)
  const frozen = !!(G.cur && G.cur.away);
  const keys = frozen ? 0 : G.keyFlags;

  if (keys & KF.Thrust) {
    sp.state |= SF.Thrust;
    if (!(oldState & SF.Thrust))
      G.snd.play(SND.Thrust);
  }
  if (keys & KF.Fire) {
    if (G.fireDelay === 0) {
      sp.state |= SF.Fire;
      G.fireDelay = (G.shipMode & SM.Uzi) ? UziDebounce : Debounce;
    } else {
      --G.fireDelay;
    }
  } else if (G.fireDelay) {
    --G.fireDelay;
  }
  sp.state |= steerBits(sp.rotIdx, keys, frozen ? -1 : G.stickDir) & ~SF.Thrust;
  if (keys & KF.Shield) {
    if (G.shieldPower > 0) {
      if (!(oldState & SF.Shield))
        G.snd.play(SND.Shield);
      G.shieldPower--;
      sp.state |= SF.Shield;
    }
  } else if ((G.gameClock & 0xFF) === 0) {    // recharge shields every ~13 seconds
    G.shieldPower = Math.min(MaxShieldPower, G.shieldPower + ShieldIncrease);
  }
  if (G.shipMode & SM.AutoShield) {
    if (G.ship && G.ship.tickCtr > 40)
      G.shipMode &= ~SM.AutoShield;
    else
      sp.state |= SF.Shield;
  }

  // Check for collision with ship
  const list = G.sprites;
  for (let j = 0; j < (frozen ? 0 : list.length); ++j) {
    const spj = list[j];
    if (spj.active && inRange(sp, spj) && spj.visible &&
        (spj.def.bulletFlag & BF_ShipCollideFlag)) {
      if (G.isColliding(sp, spj)) {
        if (G.processShipCollide(sp, spj))
          return;
      }
    }
  }

  shipMotion(sp, frozen);

  if (G.shield) {
    if (sp.state & SF.Shield) {
      G.shield.visible = true;
    } else if (G.shield.visible) {
      G.shield.visible = false;
      G.snd.play(SND.POP);
    }
  }

  G.bindShipToUniverseTorus(sp);

  // Fire after moving so the bullet origin looks right
  if (sp.state & SF.Fire) {
    const fp = FIRING_POS[sp.frameNbr & 15];
    const bx = sp.x + fp[0], by = sp.y + fp[1];
    const fire = (idx) => G.launchBullet(ST.Bullet, bx, by,
      sp.vx + vt[idx].x * BulletSpeed, sp.vy + vt[idx].y * BulletSpeed,
      kBulletLifeSpan, BF_GoodBulletFlag);
    fire(sp.rotIdx);
    if (G.shipMode & SM.Triple) {
      fire((sp.rotIdx + kMaxRotIdxAngles - 1) % kMaxRotIdxAngles);
      fire((sp.rotIdx + 1) % kMaxRotIdxAngles);
    }
    G.snd.play(SND.Firing);
  }
  sp.setFrameNbr(sp.frameNbr);
  sp.tickCtr++;
  sp.state &= ~SF.Fire;
}

// The pause before a new teapot appears
function newShipTick(sp) {
  if (sp.tickCtr++ > 60) {
    // New teapots appear at the center of the universe, well clear of the
    // whorls; if a whorl ever covered it, step out until we're outside.
    // Multiplayer spawn points.  Co-op: the corners of a small square, so
    // partners stay together -- first teapot by join order, later ones at the
    // least occupied corner.  Duel / melee: the first teapot at one of four
    // points 1360+ units apart by join order (none in a whorl's pull, unless a
    // rival is already near it); later ones at the point of the wrapped
    // universe farthest from every other teapot, outside the whorls, so nobody
    // spawns on a rival or camps a spawn point.
    let x = 0, y = 0;
    if (G.players && G.players.length > 1) {
      const owner = sp.owner;
      const others = G.players
        .filter((p) => p !== owner && p.ship && p.ship.active && p.ship.type === ST.Teapot)
        .map((p) => p.ship);
      const nearest = (px, py) => {
        let n = Infinity;
        for (const o of others) {
          const d = { x: o.x - px, y: o.y - py };
          G.bindToUniverseTorus(d);
          n = Math.min(n, Math.hypot(d.x, d.y));
        }
        return n;
      };
      let placed = false;
      if (owner && !owner.spawnedOnce) {
        const starts = G.duel ? DUEL_STARTS : COOP_STARTS;
        const [sx, sy] = starts[Math.max(0, G.players.indexOf(owner)) % starts.length];
        if ((!G.duel || nearest(sx, sy) > 700) && whorlDepth(sx, sy).depth === 0) { x = sx; y = sy; placed = true; }
      }
      if (!placed && !G.duel) {
        // co-op: back to the square, at whichever corner is least occupied
        let best = -1;
        for (const [cx, cy] of COOP_STARTS) {
          const near = nearest(cx, cy);
          if (near > best) { best = near; x = cx; y = cy; }
        }
        placed = true;
      }
      if (!placed && others.length) {
        let best = -1;
        for (let gx = -G.univRadX; gx < G.univRadX; gx += G.univWidth / 12) {
          for (let gy = -G.univRadY + G.univHeight / 16; gy < G.univRadY; gy += G.univHeight / 8) {
            if (whorlDepth(gx, gy).depth > 0) continue;
            const near = nearest(gx, gy);
            if (near > best) { best = near; x = gx; y = gy; }
          }
        }
      }
    }
    if (sp.owner) sp.owner.spawnedOnce = true;   // later teapots use the farthest point
    // bots (agent.js) can start each teapot with a push in a random direction
    const kick = sp.owner && sp.owner.kick;
    if (kick) {
      const a = Math.random() * Math.PI * 2;
      sp.vx = Math.cos(a) * kick;
      sp.vy = Math.sin(a) * kick;
    }
    for (let i = 0; i < 40 && whorlDepth(x, y).depth > 0; i++) x += 50;
    sp.x = sp.prevX = x;
    sp.y = sp.prevY = y;
    G.offsetX = x;
    G.offsetY = y;
    sp.tickCtr = 0;
    G.message = '';
    sp.setType(ST.Teapot);
    G.snd.play(SND.ShipDebut);
    G.shipMode |= SM.AutoShield;
    G.shieldPower = MaxShieldPower;
  }
}

function shieldMove(sp) {
  sp.rgba[3] = G.shieldPower * 0.25 / MaxShieldPower;
  sp.rgba[0] = sp.rgba[1] = sp.rgba[2] = 1;
  if (G.shieldPower < 40 && randomI(G.shieldPower) === 0) {   // shield sputter
    sp.rgba[1] = sp.rgba[2] = 0;
    sp.rgba[3] = 0.75;
  }
  if (G.ship) {
    sp.x = G.ship.x;
    sp.y = G.ship.y;
  } else {
    sp.visible = false;
  }
}

function shieldCollide(sp, collider) {
  if (collider.type === ST.Photon)
    G.snd.play(SND.DudBullet);
}

// ---------------------------------------------------------------- bad guys

function initBeastie(sp) {
  sp.maxHits = hitsForLevel(2);
  sp.hitsTaken = 0;
  sp.frameNbr = randomI(sp.nbrFrames);
  sp.setFrameNbr(sp.frameNbr);
  sp.rotIdx = randomI(kMaxRotIdxAngles - 4);
  sp.rotIdx += 1 + Math.floor(sp.rotIdx / 7);
  setVec(sp, G.vecTable[sp.rotIdx].x, G.vecTable[sp.rotIdx].y);
  sp.aniSpeed = 3 - (G.gameLevel > 1 ? 1 : 0);
  sp.tickCtr = 0;
  soundFrom(SND.BadGuyDebut, sp);
}

function initCroissant(sp) {
  initBeastie(sp);
  sp.rad = 12 + rnd() * 12;   // croissants are random in size
  sp.maxHits = hitsForLevel(2);
  sp.lifeSpan = kCroissantLifeSpan;
}

// Croissants and scones home in on the teapot and blow up when their time runs out
function selfDestruct(sp, explosion) {
  const dist = G.distanceToLocalPlayer(sp, null);
  if (dist > 0 && dist < G.normalVisPlayRad) {
    G.newExplosion(sp, explosion, 1.05, 0.93);
    G.newQuake(sp);
    G.explodeSprite(sp, kLargeSparkLifeSpan);
  } else {
    G.killSprite(sp);
  }
}

function homingAnimate(sp) {
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    if (++sp.frameNbr >= sp.nbrFrames)
      sp.frameNbr = 0;
    if (sp.frameNbr & 1) {
      const u = { x: 0, y: 0 };
      const dist = G.distanceToLocalPlayer(sp, u);
      if (dist > 0)
        setVec(sp, u.x * 8, u.y * 8);
    }
    sp.setFrameNbr(sp.frameNbr);
  }
}

function croissantMove(sp) {
  linearMove(sp);
  if (--sp.lifeSpan === 0) {
    selfDestruct(sp, ST.RingExplosion);
    return;
  }
  homingAnimate(sp);
}

function initScone(sp) {
  initCroissant(sp);
  sp.f1 = rnd() * 2 * 3.1415;
}

function sconeMove(sp) {
  linearMove(sp);
  if (--sp.lifeSpan === 0) {
    selfDestruct(sp, ST.RingExplosion);
    return;
  }
  sp.rotation = Math.sin(G.time + sp.f1) * 30;
  homingAnimate(sp);
}

function initCube(sp) {
  initBeastie(sp);
  sp.maxHits = hitsForLevel(4);
  sp.lifeSpan = kCubeLifeSpan;
}

function cubeMove(sp) {
  linearMove(sp);
  if (--sp.lifeSpan === 0) {
    G.newExplosion(sp, ST.RingExplosion, 1.0, 0.93);
    G.newQuake(sp);
    G.explodeSprite(sp, kLargeSparkLifeSpan);
    return;
  }
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    if (++sp.frameNbr >= sp.nbrFrames)
      sp.frameNbr = 0;
    if (sp.frameNbr & 1) {
      const u = { x: 0, y: 0 };
      const dist = G.distanceToLocalPlayer(sp, u);
      if (dist > 0) {
        setVec(sp, u.x * 4, u.y * 4);
        if (dist < G.normalVisPlayRad && sp.frameNbr === 9) {
          G.launchBullet(ST.Photon, sp.x, sp.y, u.x * 16, u.y * 16,
            kPhotonLifeSpan, BF_BadBulletFlag);
          G.snd.playFrom(SND.EnemyFire2, dist, u.x, G);
        }
      }
    }
    sp.setFrameNbr(sp.frameNbr);
  }
}

// Saucers, percolators and colanders chase and shoot at the teapot
function shooterSpeed() {
  return (G.gameLevel && randomI(3 - (G.gameLevel > 1 ? 1 : 0)) === 0) ? 16 : 8;
}

function saucerMove(sp, fireOfsY = -12, snd = SND.EnemyFires) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    sp.frameNbr++;
    if (sp.frameNbr >= sp.nbrFrames) {
      sp.frameNbr = 0;
      const u = { x: 0, y: 0 };
      const dist = G.distanceToLocalPlayer(sp, u);
      if (dist > 0) {
        let travelSpeed = shooterSpeed();
        if (dist < G.normalVisPlayRad) {
          G.launchBullet(ST.Photon, sp.x, sp.y + fireOfsY,
            u.x * travelSpeed, u.y * travelSpeed, kPhotonLifeSpan, BF_BadBulletFlag);
          G.snd.playFrom(snd, dist, u.x, G);
          travelSpeed *= 0.25 + 0.25 * rnd();   // slow down - we're close
        }
        setVec(sp, u.x * travelSpeed, u.y * travelSpeed);
      }
    }
    sp.setFrameNbr(sp.frameNbr);
  }
}

function coffeePotMove(sp) {
  saucerMove(sp, 20, SND.EnemyFire2);
}

function initToaster(sp) {
  initBeastie(sp);
  sp.lifeSpan = kToasterLifeSpan;
  sp.rotIdx = 16;   // straight down
  setVec(sp, G.vecTable[sp.rotIdx].x * 16, G.vecTable[sp.rotIdx].y * 16);
  sp.aniSpeed = 3;
  sp.stateTimer = 0;
  sp.state = 0;
}

function toasterMove(sp) {
  linearMove(sp);
  switch (sp.state) {
    case 0:   // look for nearby teapot
      if (sp.frameNbr === 0) {
        const dist = G.distanceToLocalPlayer(sp, null);
        if (dist < G.visPlayWidth / 2) {
          sp.state = 1;
          sp.stateTimer = 0;
          setVec(sp, 0, 0);   // stop on a dime
          G.launchNookAndCranny(sp);
        }
      }
      break;
    case 1:   // unload muffins
      if (sp.stateTimer++ > 20) {
        sp.state = 2;
        sp.stateTimer = 0;
        setVec(sp, G.vecTable[sp.rotIdx].x * 16, G.vecTable[sp.rotIdx].y * 16);
      }
      break;
    case 2:
      if (sp.stateTimer++ > 100) {
        const dist = G.distanceToLocalPlayer(sp, null);
        if (dist > 0 && dist < G.normalVisPlayRad) {
          G.newExplosion(sp, ST.Explosion);
          G.newQuake(sp);
          G.explodeSprite(sp, kLargeSparkLifeSpan);
        } else {
          G.killSprite(sp);
        }
        return;
      }
      break;
  }
  animateLoop(sp);
}

function toasterCollide(sp, collider) {
  if (collider.type === ST.Bullet)
    soundFrom(SND.DudBullet, sp);
}

// Emerging muffin (turns into Nook or Cranny)
function eMuffinMove(sp) {
  standardSpriteUpdate(sp);
  if (sp.state === 0 && sp.frameNbr === 4) {
    sp.setType(ST.Nook);
    sp.setFrameNbr(2);
    sp.aniSpeed = 2;
    sp.rotIdx = 8;
    setVec(sp, 0, 0);
    sp.state = 0;
    sp.stateTimer = 0;
  } else if (sp.state === 1 && sp.frameNbr === 0) {
    sp.setType(ST.Cranny);
    sp.setFrameNbr(11);
    sp.aniSpeed = 2;
    sp.rotIdx = 24;
    setVec(sp, 0, 0);
    sp.state = 10;
    sp.stateTimer = 0;
  }
}

// Nook and Cranny pincer the teapot from above and below.  Cranny uses state+10.
function nookAndCrannyMove(sp) {
  const ship = G.ship;
  const shipX = ship ? ship.x : G.offsetX;
  const shipY = ship ? ship.y : G.offsetY;
  linearMove(sp);

  const flank = (dy, partnerType, waitState, partnerWait, attackState, partnerAttack) => {
    const u = { x: 0, y: 0 }, d = { x: 0, y: 0 };
    const dist = G.distanceToPoint(shipX, shipY + dy, sp.x, sp.y, u, d);
    sp.state = dist < 32 ? waitState : waitState - 1;
    if (Math.abs(d.x) < 80 && Math.abs(d.y) < 32)   // don't cross vertical distance
      u.y = 0;
    setVec(sp, u.x * 8, u.y * 8);
    if (sp.state === waitState) {
      if (sp.stateTimer++ > 20)   // trigger the other muffin
        sp.state = attackState;
      for (const spj of G.sprites) {
        if (spj.active && spj.type === partnerType && spj.state === partnerWait) {
          sp.state = attackState;
          spj.state = partnerAttack;
          break;
        }
      }
    }
  };

  switch (sp.state) {
    case 0:
    case 10:   // idle a few frames
      if (sp.stateTimer++ > 4)
        sp.state++;
      break;
    case 1:
      sp.stateTimer = 0;
      // falls through
    case 2:    // target spot above ship
      flank(100, ST.Cranny, 2, 12, 3, 13);
      break;
    case 3:
    case 13: {
      const u = { x: 0, y: 0 };
      const dist = G.distanceToLocalPlayer(sp, u);
      if (dist > 200)
        sp.state -= 2;
      setVec(sp, u.x * 8, u.y * 8);
      break;
    }
    case 11:
      sp.stateTimer = 0;
      // falls through
    case 12:   // target spot below ship
      flank(-100, ST.Nook, 12, 2, 13, 3);
      break;
  }

  const idx = getAngleIdx(sp.vx, sp.vy) * 2;
  const delta = sp.rotIdx - idx;
  if (delta < 0) {
    if (Math.abs(delta) <= kMaxRotIdxAngles / 2) sp.rotIdx++;
    else sp.rotIdx--;
  } else if (delta > 0) {
    if (delta <= kMaxRotIdxAngles / 2) sp.rotIdx--;
    else sp.rotIdx++;
  }
  const ofs = sp.type === ST.Nook ? 24 : 8;
  sp.rotation = 360 - (((sp.rotIdx + ofs) % kMaxRotIdxAngles + kMaxRotIdxAngles) % kMaxRotIdxAngles) * 320 / 32 + 10;

  animateLoop(sp);
}

function initMixer(sp) {
  initBeastie(sp);
  sp.aniSpeed = 10 - (G.gameLevel > 1 ? 1 : 0);
}

function mixerMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    const u = { x: 0, y: 0 };
    const dist = G.distanceToLocalPlayer(sp, u);
    if (dist > 0) {
      if (dist < G.normalVisPlayRad * 0.75) {
        setVec(sp, 0, 0);   // stop the mixer
        sp.state = 1;       // is close
      } else {
        setVec(sp, u.x * 4, u.y * 4);   // follow the ship
        sp.state = 0;
      }
    }
  }

  // The mixer's animation is a little state machine over its 85 frames
  switch (sp.frameNbr) {
    case 0:
      if (sp.vx === 0 && sp.vy === 0 && randomI(3) === 0) {
        sp.frameNbr = 82;   // prepare to launch
      } else if (randomI(2) === 0) {
        sp.frameNbr = 1;
      } else {
        sp.frameNbr = 16;
        if (sp.state === 1)
          soundFrom(SND.MixerTaunt, sp);
      }
      break;
    case 4: case 52: case 59:
      sp.frameNbr = [5, 53, 60][randomI(3)];
      break;
    case 11: case 47:
      sp.frameNbr = randomI(2) === 0 ? 12 : 48;
      break;
    case 14: sp.frameNbr = 0; break;
    case 30: sp.frameNbr = 46; break;
    case 66: sp.frameNbr = 52; break;
    case 45: sp.frameNbr = 31; break;
    case 81: sp.frameNbr = 67; break;
    case 84:   // eject the beaters
      sp.frameNbr = 71;
      G.newBeater(sp.x - 24, sp.y + 8, 0);
      G.newBeater(sp.x - 20, sp.y + 4, 1);
      break;
    default:
      sp.frameNbr++;
      break;
  }
  sp.setFrameNbr(sp.frameNbr);
}

function beaterMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    const u = { x: 0, y: 0 };
    const dist = G.distanceToLocalPlayer(sp, u);
    if (dist > 0)
      setVec(sp, u.x * 8, u.y * 8);
  }
  let angle = Math.floor(sp.frameNbr / 3);
  let subframe = sp.frameNbr % 3;
  const tangle = getBeaterAngleIdx(sp.vx, sp.vy);
  const delta = tangle - angle;
  if (delta > 0) angle += delta <= 4 ? 1 : -1;
  else if (delta < 0) angle += delta >= -4 ? -1 : 1;
  angle &= 7;
  subframe = (subframe + 1) % 3;
  sp.setFrameNbr(angle * 3 + subframe);
}

function stdBadGuyCollide(sp, collider) {
  if (collider.type === ST.Teeth) {
    G.eatSprite(sp, collider);
  } else if (collider.type === ST.Bullet) {
    if (++sp.hitsTaken >= sp.maxHits) {
      G.addScoreFor(sp);
      G.newExplosion(sp, ST.Explosion);
      G.explodeSprite(sp, kMedSparkLifeSpan);
    }
  } else {
    G.explodeSprite(sp, kMedSparkLifeSpan);
  }
}

// ---------------------------------------------------------------- asteroids & friends

function initBigJim(sp) {
  sp.rotation = 10;
  sp.f1 = rnd() * 2 * 3.1415;
}

function bigJimMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    sp.rotation = Math.sin(G.time + sp.f1) * 30;
    if (sp.nbrFrames)
      sp.setFrameNbr((sp.frameNbr + 1) % sp.nbrFrames);
  }
}

function initLittleJim(sp) {
  sp.rotation = randomI(360);
}

function littleJimMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    sp.rotation += 20;
    if (sp.rotation > 360) sp.rotation -= 360;
  }
}

function initSmallCup(sp) {
  sp.frameNbr = randomI(sp.nbrFrames);
}

function asterDie() {
  --G.asteroidCnt;
}

function stdAsterCollide(sp, collider) {
  if (collider.type === ST.Teeth) {
    G.eatSprite(sp, collider);
  } else {
    if (collider.type === ST.Bullet)
      G.addScoreFor(sp);
    G.explodeSprite(sp, kSmallSparkLifeSpan);
  }
}

// Big asteroids fracture into smaller pieces
function fracture(pieces, snd) {
  return (sp, collider) => {
    if (collider.type === ST.Teeth) {
      G.eatSprite(sp, collider);
      return;
    }
    G.genExplosionSparks(sp, kSmallSparkLifeSpan, 1.5);
    for (const [type, ofs] of pieces)
      G.newSubAsteroid(sp, type, ofs);
    if (collider.type === ST.Bullet)
      G.addScoreFor(sp);
    soundFrom(snd, sp);
    G.killSprite(sp);
  };
}

const wheelCollide = fracture([[ST.WheelR, -2], [ST.WheelG, 0], [ST.WheelB, 2]], SND.BreakRings);
const bigAsterCollide = fracture([[ST.Aster1, -2], [ST.Aster2, 2]], SND.BreakRings);
// The AI asterisk splits like the asterisk does: the halves keep its frame,
// so the two logos fly apart at the same point in their spin
const aiAsterCollide = fracture([[ST.AIOpenAI, -2], [ST.AIClaude, 2]], SND.BreakRings);
const teacupCollide = fracture([[ST.SmallCup, -2], [ST.SmallCup2, 0], [ST.SmallCup, 2]], SND.BreakRings);
const sconeRockCollide = fracture([[ST.SconePebble, -2], [ST.SconePebble, 2]], SND.BreakRings);
const bigJimCollide = fracture([[ST.LittleJim, -2], [ST.Eugene, 0], [ST.LittleJim2, 2]], SND.JimOuch);

function initColander(sp) {
  sp.maxHits = hitsForLevel(2);
  sp.rotation = 10;
  sp.f1 = rnd() * 2 * 3.1415;
}

function colanderMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    sp.rotation = Math.sin(G.time + sp.f1) * 30;
    sp.setFrameNbr((sp.frameNbr + 1) % sp.nbrFrames);
    if (sp.frameNbr === 0) {
      const u = { x: 0, y: 0 };
      const dist = G.distanceToLocalPlayer(sp, u);
      if (dist > 0 && dist < G.normalVisPlayRad) {
        const travelSpeed = shooterSpeed();
        G.launchBullet(ST.Photon, sp.x, sp.y - 12, u.x * travelSpeed, u.y * travelSpeed,
          kPhotonLifeSpan, BF_BadBulletFlag);
        G.snd.playFrom(SND.EnemyFires, dist, u.x, G);
      }
    }
  }
}

function colanderCollide(sp, collider) {
  if (collider.type === ST.Teeth) {
    G.eatSprite(sp, collider);
  } else if (collider.type === ST.Bullet) {
    if (++sp.hitsTaken >= sp.maxHits) {
      G.addScoreFor(sp);
      G.explodeSprite(sp, kSmallSparkLifeSpan);
    } else {
      soundFrom(SND.DudBullet, sp);
    }
  } else {
    G.explodeSprite(sp, kSmallSparkLifeSpan);
  }
}

// Wind-up teeth: indestructible, and they eat whatever they bump into
function initTeeth(sp) {
  sp.rotation = 10;
  sp.f1 = rnd() * 2 * 3.1415;
  sp.targetFlags = BF_BadBulletFlag | BF_GoodBulletFlag;
}

function teethMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    sp.rotation = Math.sin(G.time + sp.f1) * 30;
    sp.setFrameNbr((sp.frameNbr + 1) % sp.nbrFrames);
  }
  const list = G.sprites;
  for (let j = 0; j < list.length; ++j) {
    const spj = list[j];
    if (spj !== sp && spj.active && inRange(sp, spj) && spj.visible &&
        (spj.def.bulletFlag & sp.targetFlags)) {
      if (G.isColliding(sp, spj) && spj.def.collideFunc) {
        spj.def.collideFunc(spj, sp);
        break;
      }
    }
  }
}

function teethCollide(sp, collider) {
  if (collider.type === ST.Bullet)
    soundFrom(SND.DudBullet, sp);
}

export const kGobbleTicks = 10;

function morselMove(sp) {
  if (--sp.lifeSpan <= 0) {
    G.killSprite(sp);
    G.snd.play(SND.YummyConsume);
    return;
  }
  linearMove(sp);
  const r = sp.tickCtr / kGobbleTicks;
  sp.rad = sp.f1 + (sp.f2 - sp.f1) * r;
  sp.tickCtr++;
}

// ---------------------------------------------------------------- bullets

function initPhoton(sp) {
  sp.collideRF = 0.33;
  sp.rgba[1] = sp.rgba[2] = 0.85;   // reddish
}

function initBullet(sp) {
  sp.collideRF = 0.33;
  sp.rgba[2] = 0.85;                // yellowish
}

function bulletMove(sp) {
  linearMove(sp);
  sp.rotation = G.time * 360;
  if (--sp.lifeSpan === 0) {
    G.killSprite(sp);
    return;
  }
  sp.rgba[3] = Math.min(10, sp.lifeSpan) / 10;   // fade out

  const list = G.sprites;
  for (let j = 0; j < list.length; ++j) {
    const spj = list[j];
    // in a multiplayer duel, teapot bullets also hit the other players' teapots
    const duelHit = G.duel && sp.owner && spj.type === ST.Teapot && spj.owner && spj.owner !== sp.owner;
    if (spj.active && inRange(sp, spj) && spj.visible &&
        ((spj.def.bulletFlag & sp.targetFlags) || duelHit)) {
      if (G.isColliding(sp, spj)) {
        G.processBulletCollide(sp, spj);
        break;
      }
    }
  }
}

function creamBulletMove(sp) {
  if (sp.state === 0) {
    ++sp.frameNbr;
    if (sp.frameNbr >= 3) { sp.frameNbr = 2; sp.state = 1; }
  } else {
    --sp.frameNbr;
    if (sp.frameNbr < 0) { sp.frameNbr = 2; sp.state = 0; }
  }
  sp.setFrameNbr(sp.frameNbr);
  bulletMove(sp);
}

// ---------------------------------------------------------------- yummies (power-ups)

function yummyMove(sp) {
  if (--sp.lifeSpan === 0) {
    G.killSprite(sp);
    --G.yummyCnt;
  }
}

function creamerMove(sp) {
  animateLoop(sp);
  if (--sp.lifeSpan === 0) {
    G.killSprite(sp);
    --G.yummyCnt;
  }
}

function yummyCollide(sp, collider) {
  if (collider.type === ST.Teeth)
    G.eatSprite(sp, collider);
  else if (collider.type === ST.Bullet)
    G.explodeSprite(sp, kMedSparkLifeSpan);   // no points for exploded yummies
  else
    G.consumeYummy(sp);
}

// ---------------------------------------------------------------- effects

function initExplosion(sp) {
  sp.aniSpeed = 2;
  sp.lifeSpan = sp.nbrFrames * 2;
}

function initRingExplosion(sp) {
  sp.lifeSpan = 40;
}

function explosionMove(sp) {
  linearMove(sp);
  sp.tickCtr++;
  if (sp.tickCtr >= sp.aniSpeed) {
    sp.tickCtr = 0;
    if (--sp.lifeSpan <= 0)
      G.killSprite(sp);
    sp.rad *= sp.f1;
    sp.rgba[3] *= sp.f2;
    sp.setFrameNbr((sp.frameNbr + 1) % sp.nbrFrames);
  }
}

function initQuake(sp) {
  soundFrom(SND.ChineseGong, sp);
  sp.lifeSpan = kQuakeLifeSpan;
  sp.f1 = 1.0;    // amplitude
  sp.f2 = 0.99;   // decay
}

const QUAKE_X = [-2, 3, 0, -4, 0, -1, 2, 2];
const QUAKE_Y = [-4, 0, -1, 2, -2, 3, 2, 0];

function quakeMove(sp) {
  if (--sp.lifeSpan === 0) {
    G.killSprite(sp);
    return;
  }
  let i = sp.lifeSpan & 7;
  for (const spj of G.sprites) {
    spj.x += QUAKE_X[i] * sp.f1;
    spj.y += QUAKE_Y[i] * sp.f1;
    i = (i + 1) & 7;
  }
  sp.f1 *= sp.f2;
}

function initScoreTile(sp) {
  sp.rgba[0] = 0.25;
  sp.rgba[3] = 0.5;
}

// ---------------------------------------------------------------- the table

export const SDEF = [
  def(ST.TeapotNew, 0, 0, 0, 0, kHeroFlags, kInvisible, 0, 0, newShipTick),
  def(ST.Teapot, 16 * 4, 48, TXT.Teapots, 0, kHeroFlags, kTeaColor, SF_PixelCollisionTest, 0,
    shipMove, teapotCollide, initTeapot),
  def(ST.Shield, 1, 64, TXT.CTSprites64, 10, kHeroFlags, kInvisible, 0, 0, shieldMove, shieldCollide),

  def(ST.BigJim, 12, 48, TXT.Batboy, 0, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    bigJimMove, bigJimCollide, initBigJim, asterDie),
  def(ST.LittleJim, 1, 32, TXT.CTSprites64, 11, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    littleJimMove, stdAsterCollide, initLittleJim, asterDie),
  def(ST.LittleJim2, 1, 32, TXT.CTSprites64, 1, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    littleJimMove, stdAsterCollide, initLittleJim, asterDie),
  def(ST.Eugene, 1, 32, TXT.CTSprites64, 14, kMonsterFlags, kAsterColor, 0, 12,
    littleJimMove, stdAsterCollide, initLittleJim, asterDie),

  def(ST.Aster, 12, 32, TXT.CTSprites32, 48, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, bigAsterCollide, null, asterDie),
  def(ST.Aster1, 12, 32, TXT.CTSprites32, 60, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.Aster2, 12, 32, TXT.CTSprites32, 72, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.Wheel, 12, 32, TXT.CTSprites32, 0, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, wheelCollide, null, asterDie),
  def(ST.WheelR, 12, 32, TXT.CTSprites32, 12, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.WheelG, 12, 32, TXT.CTSprites32, 24, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.WheelB, 12, 32, TXT.CTSprites32, 36, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.Teacup, 12, 48, TXT.CTSprites48, 0, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, teacupCollide, null, asterDie),
  def(ST.SmallCup, 12, 32, TXT.CTSprites32, 120, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, initSmallCup, asterDie),
  def(ST.SmallCup2, 12, 32, TXT.CTSprites48, 0, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.SconeRock, 8, 48, TXT.CTSprites48, 179, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, sconeRockCollide, null, asterDie),
  def(ST.SconePebble, 8, 32, TXT.CTSprites48, 179, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),

  def(ST.Colander, 6, 48, TXT.CTSprites48, 173, kMonsterFlags, kBadColor, 0, kColanderPoints,
    colanderMove, colanderCollide, initColander, asterDie),
  def(ST.Teeth, 2, 48, TXT.CTSprites64, 12, kMonsterFlags, kAsterColor, 0, 0,
    teethMove, teethCollide, initTeeth, asterDie),

  def(ST.Saucer, 18, 32, TXT.CTSprites32, 84, kMonsterFlags, kBadColor, SF_PixelCollisionTest, kSaucerPoints,
    (sp) => saucerMove(sp), stdBadGuyCollide, initBeastie),
  def(ST.CoffeePot, 15, 48, TXT.CTSprites48, 41, kMonsterFlags, kBadColor, SF_PixelCollisionTest, kCoffeePotPoints,
    coffeePotMove, stdBadGuyCollide, initBeastie),
  def(ST.Cube, 18, 32, TXT.CTSprites32, 102, kMonsterFlags, kBadColor, SF_PixelCollisionTest, kCubePoints,
    cubeMove, stdBadGuyCollide, initCube),
  def(ST.Croissant, 14, 48, TXT.CTSprites48, 12, kMonsterFlags, kBadColor, SF_PixelCollisionTest, kCroissantPoints,
    croissantMove, stdBadGuyCollide, initCroissant),
  def(ST.Scone, 8, 48, TXT.CTSprites48, 179, kMonsterFlags, kBadColor, SF_PixelCollisionTest, kSconePoints,
    sconeMove, stdBadGuyCollide, initScone),
  def(ST.Toaster, 15, 48, TXT.CTSprites48, 26, kMonsterFlags, kBadColor, 0, 0,
    toasterMove, toasterCollide, initToaster),
  def(ST.EMuffin, 8, 32, TXT.CTSprites32, 162, kMonsterFlags, kBadColor, 0, kMuffinPoints,
    eMuffinMove, null, initBeastie),
  def(ST.Nook, 15, 32, TXT.CTSprites32, 132, kMonsterFlags, kBadColor, 0, kMuffinPoints,
    nookAndCrannyMove, stdBadGuyCollide),
  def(ST.Cranny, 15, 32, TXT.CTSprites32, 147, kMonsterFlags, kBadColor, 0, kMuffinPoints,
    nookAndCrannyMove, stdBadGuyCollide),
  def(ST.Mixer, 85, 48, TXT.CTSprites48, 79, kMonsterFlags, kBadColor, 0, kMixerPoints,
    mixerMove, stdBadGuyCollide, initMixer),
  def(ST.Beater, 24, 32, TXT.CTSprites32, 173, kMonsterFlags, kBadColor, 0, kBeaterPoints,
    beaterMove, stdBadGuyCollide, initBeastie),

  def(ST.Bullet, 1, 16, TXT.CTSprites64, 0, 0, kInvisible, 0, 0, bulletMove, null, initBullet),
  def(ST.Photon, 1, 16, TXT.CTSprites64, 0, 0, kInvisible, 0, 0, bulletMove, null, initPhoton),
  def(ST.CreamBullet, 3, 20, TXT.CTSprites32, 170, 0, kInvisible, 0, 0, creamBulletMove),

  def(ST.Yummies, Y.Count, 32, TXT.CTSprites32, 197, kMonsterFlags, kYummyColor, 0, 0, yummyMove, yummyCollide),
  def(ST.Creamer, 23, 48, TXT.CTSprites48, 56, kMonsterFlags, kYummyColor, 0, 0, creamerMove, yummyCollide),

  def(ST.Explosion, 9, 48, TXT.CTSprites48, 164, 0, kInvisible, 0, 0, explosionMove, null, initExplosion),
  def(ST.RingExplosion, 8, 48, TXT.CTSprites64, 2, 0, kInvisible, 0, 0, explosionMove, null, initRingExplosion),
  def(ST.Quake, 0, 0, 0, 0, 0, kInvisible, 0, 0, quakeMove, null, initQuake),
  def(ST.Morsel, 0, 0, 0, 0, 0, kInvisible, 0, 0, morselMove),

  def(ST.DemoTeapot, 16, 48, TXT.Teapots, 0, 0x04, kInvisible, 0, 0, standardSpriteUpdate),

  def(ST.ScoreTile, 11, 16, TXT.ScoreNumbers, 0, 0, kInvisible, SF_GUISprite, 0, nullFunc, null, initScoreTile),

  // Browser port addition: OpenAI and Claude logos joined, tumbling in opposite
  // directions.  24 frames make a full turn (a logo's back is its mirror image),
  // the same tumbling speed as the asterisk's 12 frames per half turn.
  def(ST.AIAster, 24, 40, TXT.AILogos, 0, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, aiAsterCollide, null, asterDie),
  def(ST.AIOpenAI, 24, 36, TXT.AILogos, 24, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
  def(ST.AIClaude, 24, 36, TXT.AILogos, 48, kMonsterFlags, kAsterColor, 0, kAsterPoints,
    standardSpriteUpdate, stdAsterCollide, null, asterDie),
];
