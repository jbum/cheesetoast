// Battle puzzles: board positions with one clearly right behavior and a
// distraction or two, like chess puzzles.  bots/puzzles/run.mjs sets each
// board up in the real game (ctAgent.setup), asks the policy once, and grades
// the answer.  Mined puzzles (from game recordings) are in mined.json.
//
// Coordinates are relative to your teapot (at the origin, y up); headings and
// bearings are degrees clockwise from straight up; one turn step is 22.5 deg.
// expect: steer = acceptable choices (hard_left, left, straight, right,
// hard_right); fire / shield / thrust = true or false (omitted = either).

const rad = (d) => (d * Math.PI) / 180;
// something at a bearing and distance from you
const at = (bearing, dist) => ({ x: Math.round(dist * Math.sin(rad(bearing))), y: Math.round(dist * Math.cos(rad(bearing))) });
// ...moving straight at you at speed s
const toward = (bearing, dist, s) => ({ ...at(bearing, dist), vx: -s * Math.sin(rad(bearing)), vy: -s * Math.cos(rad(bearing)) });
// ...moving across your line of sight (not closing)
const across = (bearing, dist, s) => ({ ...at(bearing, dist), vx: s * Math.cos(rad(bearing)), vy: -s * Math.sin(rad(bearing)) });

const thing = (type, o) => ({ type, ...o });

export const PUZZLES = [
  // ---- survive first: a threat with a rival as bait
  {
    id: 'rock-ahead-rival-far', mode: 'melee',
    why: 'A wheel is coming straight at the spout; a rival on the radar to the left is bait.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(0, 110, 4))],
    rivals: [{ ...at(-100, 700) }],
    expect: { steer: ['straight'], fire: true },
  },
  {
    id: 'rival-right-rock-ahead', mode: 'melee',
    why: 'A rival is in range two steps right, but a wheel will hit in ~10 ticks dead ahead: shoot the wheel first.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(0, 90, 5))],
    rivals: [{ ...at(45, 200) }],
    expect: { steer: ['straight'], fire: true },
  },
  {
    id: 'teeth-incoming-rival-ahead', mode: 'melee',
    why: 'Unshootable teeth hit from the right in ~4 ticks; a rival dead ahead in range is the distraction.',
    me: { heading: 0 },
    things: [thing('Teeth', toward(60, 70, 6))],
    rivals: [{ ...at(0, 200) }],
    expect: { shield: true },
  },
  {
    id: 'rival-shot-from-behind', mode: 'melee',
    why: "A rival's bullet hits from behind in ~3 ticks; the asteroid ahead is a target but the bullet needs the shield.",
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(0, 180) })],
    rivals: [{ ...at(180, 330), heading: 0 }],
    rivalShots: [toward(180, 60, 10)],
    expect: { shield: true, fire: true },
  },
  {
    id: 'rival-shot-plus-rival-in-sight', mode: 'duel',
    why: "The rival is one step left in range and its bullet arrives in ~3 ticks: shield and keep shooting.",
    me: { heading: 0 },
    rivals: [{ ...at(-22.5, 220), heading: 158 }],
    rivalShots: [toward(-22.5, 60, 9)],
    expect: { shield: true, fire: true },
  },
  {
    id: 'rival-behind-rock-ahead', mode: 'melee',
    why: 'A rival sits behind in range, but a closing wheel is lined up ahead: shoot what you are aimed at.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(0, 140, 3))],
    rivals: [{ ...at(180, 200) }],
    expect: { steer: ['straight'], fire: true },
  },

  // ---- rival priority when it's safe
  {
    id: 'rival-dead-ahead-safe', mode: 'melee',
    why: 'A rival is dead ahead in range and nothing threatens: fire, keep aiming.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(90, 300), vx: 1, vy: 0 })],
    rivals: [{ ...at(0, 200) }],
    expect: { steer: ['straight'], fire: true, shield: false },
  },
  {
    id: 'rival-right-asteroid-left-safe', mode: 'melee',
    why: 'Safe moment: a rival two steps right (2000 pts) vs. an asteroid one step left (100 pts): go for the rival.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(-22.5, 220) })],
    rivals: [{ ...at(45, 200) }],
    expect: { steer: ['right', 'hard_right'], shield: false },
  },
  {
    id: 'two-rivals-one-lined-up', mode: 'melee',
    why: 'One rival lined up in range, another far to the right: shoot the one in front.',
    me: { heading: 0 },
    rivals: [{ ...at(0, 220) }, { ...at(120, 600) }],
    expect: { steer: ['straight'], fire: true },
  },

  // ---- shield discipline (don't waste it, do use it)
  {
    id: 'photon-incoming-left', mode: 'single',
    why: "An enemy shot (can't be shot down) hits from the left in ~3 ticks; the asteroid ahead is a distraction.",
    me: { heading: 0 },
    things: [thing('Photon', toward(-90, 50, 6)), thing('Wheel', { ...at(0, 220) })],
    expect: { shield: true },
  },
  {
    id: 'photon-incoming-but-invulnerable', mode: 'single',
    why: 'Same shot, but the teapot just spawned and is invulnerable: no need to shield.',
    me: { heading: 0, invulnerable: true },
    things: [thing('Photon', toward(-90, 50, 6)), thing('Wheel', { ...at(0, 220) })],
    expect: { shield: false },
  },
  {
    id: 'photon-passing-by', mode: 'single',
    why: 'An enemy shot passes by without closing; an asteroid is lined up ahead: fire, no shield.',
    me: { heading: 0 },
    things: [thing('Photon', across(-60, 90, 6)), thing('Wheel', { ...at(0, 200) })],
    expect: { shield: false, fire: true },
  },
  {
    id: 'rival-shots-far-away', mode: 'melee',
    why: "Rival bullets are flying far off and not toward you; an asteroid two steps left: turn and don't shield.",
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(-45, 200) })],
    rivals: [{ ...at(150, 700) }],
    rivalShots: [across(120, 380, 8), across(140, 420, 8)],
    expect: { steer: ['left', 'hard_left'], shield: false },
  },
  {
    id: 'big-rock-too-tough', mode: 'single',
    why: 'A big rock needing 12 hits arrives in ~8 ticks dead ahead: it cannot be shot in time, so shield.',
    me: { heading: 0 },
    things: [thing('BigJim', { ...toward(0, 90, 5), hits: 12 })],
    expect: { shield: true },
  },
  {
    id: 'low-shield-photon-ahead', mode: 'single',
    why: 'Low shield power, but an enemy shot hits head-on in ~2 ticks: this is what the shield is for.',
    me: { heading: 0, shield: 20 },
    things: [thing('Photon', toward(0, 45, 6))],
    expect: { shield: true },
  },

  {
    id: 'rock-lined-up-far', mode: 'single',
    why: 'A wheel is lined up dead ahead but ~40 ticks away: shoot it, no need to shield.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(0, 220, 4))],
    expect: { fire: true, shield: false },
  },
  {
    id: 'enemy-closing-from-far', mode: 'single',
    why: 'A croissant closes from far off (~45 ticks) one step right: aim, no shield yet.',
    me: { heading: 0 },
    things: [thing('Croissant', toward(22.5, 330, 6))],
    expect: { steer: ['right', 'hard_right'], shield: false },
  },

  // ---- decoys and targets
  {
    id: 'teeth-ahead-decoy', mode: 'single',
    why: 'Teeth (unshootable) sit dead ahead, not moving; a wheel is four steps right: turn to it, firing at the teeth is wasted.',
    me: { heading: 0 },
    things: [thing('Teeth', { ...at(0, 160) }), thing('Wheel', { ...at(90, 200) })],
    expect: { steer: ['right', 'hard_right'], fire: false },
  },
  {
    id: 'coop-asteroid-left', mode: 'coop',
    why: 'Co-op, an asteroid two steps left, nothing threatening: turn toward it, no shield.',
    me: { heading: 0 },
    things: [thing('Wheel', { ...at(-45, 200) })],
    expect: { steer: ['left', 'hard_left'], shield: false },
  },
  {
    id: 'nothing-near-rival-on-radar', mode: 'melee',
    why: 'Nothing nearby, a rival far away on the radar: no firing, no shield.',
    me: { heading: 0 },
    rivals: [{ ...at(30, 800) }],
    expect: { fire: false, shield: false },
  },
  {
    id: 'enemy-ahead-rival-left', mode: 'melee',
    why: 'A croissant closes from dead ahead (~20 ticks) while a rival waits three steps left: shoot the croissant first.',
    me: { heading: 0 },
    things: [thing('Croissant', toward(0, 160, 6))],
    rivals: [{ ...at(-67.5, 220) }],
    expect: { steer: ['straight'], fire: true },
  },
  {
    id: 'asteroid-behind-closing', mode: 'single',
    why: 'A wheel closes from directly behind in ~5 ticks and cannot be aimed at in time: shield (or flee), do not turn into it.',
    me: { heading: 0 },
    things: [thing('Wheel', toward(180, 70, 6))],
    expect: { shield: true },
  },
];
