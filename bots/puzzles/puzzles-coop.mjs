// Co-op battle puzzles (run.mjs --suite coop).  In co-op, partners can't be
// hurt (bullets pass through teapots; only duel/melee count teapot hits), and
// the bot interface hides partners and their bullets.  So: survive like in
// any mode, ignore partners, and since four teapots start together and share
// the nearby debris, go looking for targets when nothing is in range.
// Same board format as puzzles.mjs.

const rad = (d) => (d * Math.PI) / 180;
const at = (bearing, dist) => ({ x: Math.round(dist * Math.sin(rad(bearing))), y: Math.round(dist * Math.cos(rad(bearing))) });
const toward = (bearing, dist, s) => ({ ...at(bearing, dist), vx: -s * Math.sin(rad(bearing)), vy: -s * Math.cos(rad(bearing)) });
const across = (bearing, dist, s) => ({ ...at(bearing, dist), vx: s * Math.cos(rad(bearing)), vy: -s * Math.sin(rad(bearing)) });
const thing = (type, o) => ({ type, ...o });
// a partner: in co-op the board's "rivals" are partners (hidden from the bot)
const partner = (o) => o;

export const PUZZLES = [
  // ---- survival, as in every mode
  {
    id: 'co-rock-ahead', mode: 'coop',
    why: 'A wheel is coming straight at the spout: shoot it.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(0, 110, 4))],
    expect: { steer: ['straight'], fire: true },
  },
  {
    id: 'co-teeth-incoming', mode: 'coop',
    why: 'Unshootable teeth hit from the right in ~4 ticks: shield.',
    me: { heading: 0 },
    things: [thing('Teeth', toward(60, 70, 6)), thing('Wheel', { ...at(0, 220) })],
    expect: { shield: true },
  },
  {
    id: 'co-photon-incoming', mode: 'coop',
    why: 'An enemy shot hits from the left in ~3 ticks: shield.',
    me: { heading: 0 },
    things: [thing('Photon', toward(-90, 50, 6)), thing('Wheel', { ...at(0, 220) })],
    expect: { shield: true },
  },
  {
    id: 'co-photon-passing', mode: 'coop',
    why: 'An enemy shot passes by; an asteroid is lined up: fire, no shield.',
    me: { heading: 0 },
    things: [thing('Photon', across(-60, 90, 6)), thing('Wheel', { ...at(0, 200) })],
    expect: { shield: false, fire: true },
  },
  {
    id: 'co-invulnerable', mode: 'coop',
    why: 'Just spawned and invulnerable: no shield even with a shot incoming.',
    me: { heading: 0, invulnerable: true },
    things: [thing('Photon', toward(-90, 50, 6))],
    expect: { shield: false },
  },
  {
    id: 'co-big-rock', mode: 'coop',
    why: 'A big rock needing 12 hits arrives in ~8 ticks: shield.',
    me: { heading: 0 },
    things: [thing('BigJim', { ...toward(0, 90, 5), hits: 12 })],
    expect: { shield: true },
  },
  {
    id: 'co-rock-from-behind', mode: 'coop',
    why: 'A wheel closes from behind in ~5 ticks: shield.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(180, 70, 6))],
    expect: { shield: true },
  },
  {
    id: 'co-teeth-decoy', mode: 'coop',
    why: 'Teeth sit dead ahead (can\'t be shot); a wheel four steps right: turn to it, don\'t fire.',
    me: { heading: 0 },
    things: [thing('Teeth', { ...at(0, 160) }), thing('Wheel', { ...at(90, 200) })],
    expect: { steer: ['right', 'hard_right'], fire: false },
  },

  // ---- partners are not targets or threats (melee puzzles, co-op answers)
  {
    id: 'co-partner-right-asteroid-left', mode: 'coop',
    why: 'A partner two steps right, an asteroid one step left: the asteroid is the target (in melee it would be the rival).',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(-22.5, 220) })],
    rivals: [partner({ ...at(45, 200) })],
    expect: { steer: ['left', 'hard_left'], fire: true },
  },
  {
    id: 'co-partner-lined-up-only', mode: 'coop',
    why: 'Only a partner is lined up; nothing to shoot nearby: no firing, no shield.',
    me: { heading: 0 },
    rivals: [partner({ ...at(0, 200) })],
    expect: { fire: false, shield: false },
  },
  {
    id: 'co-partner-shot-from-behind', mode: 'coop',
    why: "A partner's bullet flies at you from behind: harmless in co-op, so no shield; keep shooting the asteroid ahead.",
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(0, 180) })],
    rivals: [partner({ ...at(180, 330) })],
    rivalShots: [toward(180, 60, 10)],
    expect: { shield: false, fire: true },
  },
  {
    id: 'co-partner-in-front-of-rock', mode: 'coop',
    why: 'A partner sits between you and a lined-up rock: bullets pass through partners, so fire.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(0, 220) })],
    rivals: [partner({ ...at(0, 100) })],
    expect: { fire: true, steer: ['straight'] },
  },

  // ---- go find targets (co-op scoring)
  {
    id: 'co-target-far-ahead', mode: 'coop',
    why: 'Nothing in range; an asteroid is lined up 400 away: thrust toward it, nothing to fire at yet.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(0, 420) })],
    expect: { thrust: true, steer: ['straight'] },
  },
  {
    id: 'co-target-on-radar-ahead', mode: 'coop',
    why: 'The screen is empty; a blip on the radar dead ahead: thrust that way.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(0, 650) })],
    expect: { thrust: true, fire: false, shield: false },
  },
  {
    id: 'co-target-far-behind', mode: 'coop',
    why: 'The only target is far behind: turn hard toward it, and do not thrust away from it.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(170, 420) })],
    expect: { steer: ['hard_left', 'hard_right'], thrust: false },
  },
  {
    id: 'co-already-fast', mode: 'coop',
    why: 'Already moving fast (8) toward a target ahead: no more thrust.',
    me: { heading: 0, vx: 0, vy: 8 },
    things: [thing('Wheel', { ...at(0, 420) })],
    expect: { thrust: false },
  },
  {
    id: 'co-cruising-toward-target', mode: 'coop',
    why: 'Already cruising at 5 toward a far target: keep coasting (no friction), no more thrust.',
    me: { heading: 0, vx: 0, vy: 5 },
    things: [thing('Wheel', { ...at(0, 600) })],
    expect: { thrust: false },
  },
  {
    id: 'co-sliding-sideways-fast', mode: 'coop',
    why: 'Sliding sideways at 9 with a target ahead: thrusting adds even more speed; no thrust.',
    me: { heading: 0, vx: 9, vy: 0 },
    things: [thing('Wheel', { ...at(0, 450) })],
    expect: { thrust: false },
  },
  {
    id: 'co-slow-target-ahead', mode: 'coop',
    why: 'Drifting slowly (1.5) with a target lined up far ahead and nothing in range: thrust.',
    me: { heading: 0, vx: 0, vy: 1.5 },
    things: [thing('Wheel', { ...at(0, 450) })],
    expect: { thrust: true },
  },
  {
    id: 'co-dont-thrust-into-rock', mode: 'coop',
    why: 'A rock is lined up and closing fast (~8 ticks): shoot, do not thrust into it.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(0, 90, 5))],
    expect: { thrust: false, fire: true },
  },
  {
    id: 'co-target-in-range-no-thrust-needed', mode: 'coop',
    why: 'An asteroid is lined up in range: fire; no need to thrust.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(0, 180) })],
    expect: { fire: true, thrust: false },
  },
];
