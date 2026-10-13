// Prompt variants for the battle puzzles (bots/puzzles/run.mjs --variants a,b).
// Each is makeJev options; `prompt` overrides pieces of DEFAULT_PROMPT (jev.mjs).
export const VARIANTS = {
  current: {},                       // what the bots use now (= v3 + c1 since 2026-10-05)
  old: { modeAware: false },         // the prompt before 2026-10-05 (jev-old)
  // thrust/steer/co-op goal before the co-op puzzles
  precoop: { prompt: { thrust: "Should the teapot thrust forward (in the direction the spout points) now? Thrust to close in on distant targets or to escape danger that is behind or beside it; do not thrust toward something that is about to collide, and avoid building up too much speed (above about 6).", steer: "You control the teapot in an Asteroids-style arcade game. For the next fifth of a second, which way should the spout turn? Usually turn toward the best target to shoot (use its turn_steps_to_aim), or turn away from something about to collide if you plan to thrust away.", goals: { coop: "co-op: you share the universe with partners (their teapots are not shown and cannot be hurt); score points by shooting asteroids and enemies; avoid being hit" } } },
  // fire/shield wording before the puzzles (shield cutoff 0.6 then, too: --shield-at 0.6)
  prepuzzle: { prompt: { fire: "Should the teapot fire now? Yes when something shootable is in bullet range and within about two turn steps of the spout. Bullets are free, so lean toward yes when anything shootable is close.", shield: "Should the teapot raise its shield right now? Yes only when something harmful will collide within about 15 ticks and cannot be shot or avoided in time. Save shield power otherwise." } },

  // v1: shield names what can't be shot, hits needed and invulnerability; fire counts rivals
  v1: { prompt: {
    shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Raise it when something harmful will reach the teapot within about 10 ticks (its ticks_until_collision) and will not be destroyed first: enemy shots, rival shots and teeth can never be shot down; an object that needs more hits than you can fire before it arrives (one shot every 8 ticks) will not break in time; and anything not within one turn step of the spout cannot be hit in time. Do not raise it when teapot.currently_invulnerable is true, or when nothing will collide soon.',
    fire: 'Should the teapot fire now? Yes when something shootable (an asteroid, an enemy, or, in a duel or melee, a rival teapot) is in bullet range and within about two turn steps of the spout. Bullets are free, so lean toward yes when anything shootable is close. Shots, teeth and power-ups are not targets.',
  } },

  // v2: v1 + "no collision time = not approaching", fire while shielded, examples
  v2: { prompt: {
    shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Look only at things with a ticks_until_collision of 10 or less (null means it is not approaching: never shield for it). Raise the shield when such a thing will not be destroyed before it arrives: enemy shots, rival shots and teeth can never be shot down; something that needs 3 or more more hits will not break in time (one shot every 8 ticks); and anything behind or beside the teapot (more than one turn step from the spout) cannot be hit in time. Do not raise it when teapot.currently_invulnerable is true.',
    fire: 'Should the teapot fire now? Yes when something shootable (an asteroid, an enemy, or, in a duel or melee, a rival teapot) is in bullet range and within about two turn steps of the spout. Bullets are free and the teapot can fire while its shield is up, so lean toward yes when anything shootable is close. Shots, teeth and power-ups are not targets.',
  } },

  // v3: v2 + no firing when only a non-target is lined up
  v3: { prompt: {
    shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Look only at things with a ticks_until_collision of 10 or less (null means it is not approaching: never shield for it). Raise the shield when such a thing will not be destroyed before it arrives: enemy shots, rival shots and teeth can never be shot down; something that needs 3 or more more hits will not break in time (one shot every 8 ticks); and anything behind or beside the teapot (more than one turn step from the spout) cannot be hit in time. Do not raise it when teapot.currently_invulnerable is true.',
    fire: 'Should the teapot fire now? Yes when something shootable (an asteroid, an enemy, or, in a duel or melee, a rival teapot) is in bullet range and within about two turn steps of the spout. Bullets are free and the teapot can fire while its shield is up, so lean toward yes when anything shootable is close. Shots, teeth and power-ups are not targets: answer no when the only thing lined up is one of those.',
  } },

  // v4: v3, with the turning limit stated in terms of turn_steps_to_aim
  v4: { prompt: {
    shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Look only at things with a ticks_until_collision of 10 or less (null means it is not approaching: never shield for it). Raise the shield when such a thing will not be destroyed before it arrives: enemy shots, rival shots and teeth can never be shot down; something that needs 3 or more more hits will not break in time (one shot every 8 ticks); and anything whose turn_steps_to_aim is 2 or more either way (beside or behind the teapot) cannot be lined up and shot in time. Do not raise it when teapot.currently_invulnerable is true.',
    fire: 'Should the teapot fire now? Yes when something shootable (an asteroid, an enemy, or, in a duel or melee, a rival teapot) is in bullet range and within about two turn steps of the spout. Bullets are free and the teapot can fire while its shield is up, so lean toward yes when anything shootable is close. Shots, teeth and power-ups are not targets: answer no when the only thing lined up is one of those.',
  } },

  // c1 (co-op tuning): thrust toward targets when nothing is in range, hard turns
  // for targets 3+ steps away, and a co-op goal that says to go find targets
  c1: { prompt: {
    thrust: 'Should the teapot thrust forward (in the direction the spout points) now? Thrust when nothing shootable is in bullet range and a target (on screen or a radar blip) is within about one turn step of the spout, so the teapot travels to it; also thrust to escape danger that is behind or beside it. Do not thrust toward something that will collide within about 15 ticks, when a target is already in bullet range, or when the speed is above about 6.',
    steer: 'You control the teapot in an Asteroids-style arcade game. For the next fifth of a second, which way should the spout turn? Usually turn toward the best target to shoot (use its turn_steps_to_aim: choose hard_left or hard_right when it is 3 or more steps either way), or turn away from something about to collide if you plan to thrust away.',
    goals: { coop: 'co-op: you share the universe with partners (their teapots are not shown and cannot be hurt); score points by shooting asteroids and enemies; avoid being hit. Partners clear the targets near them too, so when nothing is in bullet range, go find targets: turn toward the nearest one, even a radar blip, and thrust.' },
  } },

  // c2: c1 with a firm speed limit for thrust (bots got to 10-12 in play with c1)
  c2: { prompt: {
    thrust: 'Should the teapot thrust forward (in the direction the spout points) now? There is no friction: the teapot keeps all its speed, so speed builds up quickly. Thrust only when teapot.speed is below 4, nothing shootable is in bullet range, and a target (on screen or a radar blip) is within about one turn step of the spout, so the teapot travels to it; or to escape danger that is behind or beside it. Never thrust when teapot.speed is 4 or more, or toward something that will collide within about 15 ticks.',
  } },

  // s15 / s20: react earlier (decisions act on a state a few ticks old, and at
  // speed 8-10 a 10-tick warning came too late in co-op games)
  s15: { prompt: { shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Look only at things with a ticks_until_collision of 15 or less (null means it is not approaching: never shield for it). Raise the shield when such a thing will not be destroyed before it arrives: enemy shots, rival shots and teeth can never be shot down; something that needs 3 or more more hits will not break in time (one shot every 8 ticks); and anything behind or beside the teapot (more than one turn step from the spout) cannot be hit in time. Do not raise it when teapot.currently_invulnerable is true.' } },
  s20: { prompt: { shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Look only at things with a ticks_until_collision of 20 or less (null means it is not approaching: never shield for it). Raise the shield when such a thing will not be destroyed before it arrives: enemy shots, rival shots and teeth can never be shot down; something that needs 3 or more more hits will not break in time (one shot every 8 ticks); and anything behind or beside the teapot (more than one turn step from the spout) cannot be hit in time. Do not raise it when teapot.currently_invulnerable is true.' } },
};
