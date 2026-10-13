// Jev plays Cheese Toast.  Each decision sends Jev a compact description of
// the last few game states and asks four questions at once (they run in
// parallel and can't see each other's answers):
//
//   steer   (Choice)  which way to turn the spout over the next few ticks
//   thrust  (Noul)    push forward?
//   fire    (Noul)    shoot?
//   shield  (Noul)    raise the shield?
//
// The answers become the controls for the next `every` ticks.  The game is
// paused while Jev thinks, so network time doesn't cost reaction time.
import { typesafeKey } from '../lib.mjs';

const URL = 'https://api.typesafe.ai/v1/systemone';
const STEP = 22.5;   // degrees per tick of turning

const DESCRIBE = {
  asteroid: 'drifting debris; shoot it for points, but it destroys the teapot on contact',
  enemy: 'enemy breakfast item; worth more points, chases or shoots at the teapot, destroys it on contact',
  enemy_shot: 'enemy bullet; destroys the teapot on contact unless the shield is up; cannot be shot',
  teeth: 'chattering teeth; cannot be destroyed by bullets and destroy the teapot on contact; avoid',
  powerup: 'power-up; touching it is good (extra firepower, shields or points)',
  rival: "another player's teapot (duel or melee): worth 2000 points per hit, and it can shoot you",
  rival_shot: "another player's bullet; destroys the teapot on contact unless the shield is up; cannot be shot",
};
// the goal, by game mode (state.mode)
const GOALS = {
  single: 'score points by shooting asteroids and enemies; avoid being hit; you have a few spare teapots',
  coop: 'co-op: you share the universe with partners (their teapots are not shown and cannot be hurt); score points by shooting asteroids and enemies; avoid being hit. Partners clear the targets near them too, so when nothing is in bullet range, go find targets: turn toward the nearest one, even a radar blip, and thrust.',
  duel: 'duel: one rival player shares the universe and can shoot you. Survive first: shoot or avoid whatever is about to collide. Shoot the rival (2000 points per hit) when it is in bullet range and nothing is about to hit you; otherwise shoot asteroids and enemies as usual',
  melee: 'melee: every other player is a rival who can shoot you. Survive first: shoot or avoid whatever is about to collide. Shoot a rival (2000 points per hit) when it is in bullet range and nothing is about to hit you; otherwise shoot asteroids and enemies as usual',
};
const OLD_DESCRIBE = {
  rival: "the other player's teapot in a duel; hitting it with a bullet destroys it and scores 2000 points; its bullets can destroy you too",
};

function side(bearing) {
  if (Math.abs(bearing) <= 8) return 'dead ahead of the spout';
  const a = Math.abs(bearing);
  return `${a} degrees to the ${bearing > 0 ? 'right' : 'left'} of the spout` + (a > 135 ? ' (behind)' : '');
}

// What Jev sees: the current situation in plain terms plus a short history
// modeAware (default): the game mode and its goal, rivals' bullets, and rivals
// kept in the list even when debris is closer.  false: the prompt before 2026-10-05.
export function describe(st, history, n = 3, { modeAware = true, goals = null, meanings: meaningOverrides = null } = {}) {
  const me = st.me;
  let list = modeAware ? st.entities : st.entities.filter((e) => e.kind !== 'rival_shot');
  let near = list.slice(0, 8);
  if (modeAware) {
    // up to two rivals always make the list (they replace the farthest debris)
    const rivals = list.filter((e) => e.kind === 'rival').slice(0, 2).filter((e) => !near.includes(e));
    const keep = new Set(['rival', 'rival_shot', 'enemy_shot']);
    for (const r of rivals) {
      let i = near.length - 1;
      while (i >= 0 && keep.has(near[i].kind)) i--;
      if (i >= 0) near[i] = r; else near.push(r);
    }
    near.sort((a, b) => a.gap - b.gap);
  }
  const meanings = modeAware ? { ...DESCRIBE, ...(meaningOverrides || {}) } : { ...DESCRIBE, ...OLD_DESCRIBE };
  const GOALSX = { ...GOALS, ...(goals || {}) };
  const things = near.map((e) => ({
    id: e.id,
    what: e.on_radar_only ? `off-screen ${e.kind} (seen only on the radar)`
      : `${e.type} (${e.kind}${e.points ? `, ${e.points} points` : ''}${e.hits_left > 1 ? `, needs ${e.hits_left} more hits` : ''})`,
    meaning: meanings[e.kind],
    distance: e.gap,
    direction: side(e.bearing),
    turn_steps_to_aim: e.turn_steps,
    approaching_speed: e.closing,
    ticks_until_collision: e.ticks_to_impact,
    in_bullet_range: e.in_fire_range,
  }));
  const recent = (n > 0 ? history.slice(-n) : []).map((h, i, arr) => ({
    seconds_ago: +(((arr.length - i) * (h.action.ticks || 4)) / 20).toFixed(2),
    action: h.action.label,
    score_then: h.st.score,
  }));
  return {
    rules: {
      units: 'distances in game units (the screen is about 800 wide); speeds in units per tick; 20 ticks per second',
      steering: `each turn step rotates the teapot ${STEP} degrees and takes one tick; a positive turn_steps_to_aim means turn right`,
      bullets: 'bullets fly straight out of the spout about 280 units; one shot every 8 ticks at most',
      shield: 'the shield blocks all damage while held but drains power; power recharges slowly',
      ...(modeAware ? { mode: st.mode || 'single' } : {}),
      goal: modeAware ? (GOALSX[st.mode] || GOALSX.single) : GOALS.single,
    },
    teapot: {
      alive: me.alive,
      speed: me.speed,
      shield_power_percent: me.shield_power,
      currently_invulnerable: me.invulnerable,
      can_fire_now: me.can_fire,
      score: st.score,
      spare_teapots: st.pots_left,
    },
    nearby_things_closest_first: things,
    recent_decisions: recent,
  };
}

// The wording Jev gets.  makeJev({ prompt: {...} }) overrides any of these
// (bots/puzzles/ tries variants this way); goals and meanings are by mode/kind.
// fire and shield were tuned on the battle puzzles (2026-10-05, variant v3 in
// bots/puzzles/prompts.mjs; earlier wording: 'prepuzzle'), then thrust, steer
// and the co-op goal on the co-op puzzles (variants c1, c2 for thrust; earlier: 'precoop').
// The shield window went from 10 to 20 ticks with the co-op shield-in-advance
// puzzles (s20): decisions act on a state a few ticks old, so 10 was too late.
export const DEFAULT_PROMPT = {
  steer: 'You control the teapot in an Asteroids-style arcade game. For the next fifth of a second, which way should the spout turn? Usually turn toward the best target to shoot (use its turn_steps_to_aim: choose hard_left or hard_right when it is 3 or more steps either way), or turn away from something about to collide if you plan to thrust away.',
  rivalHint: " In a duel or melee (`rules.mode`), turn toward a rival (another player's teapot) only when it is in bullet range and nothing harmful is about to collide; otherwise treat it like any other target.",
  fire: 'Should the teapot fire now? Yes when something shootable (an asteroid, an enemy, or, in a duel or melee, a rival teapot) is in bullet range and within about two turn steps of the spout. Bullets are free and the teapot can fire while its shield is up, so lean toward yes when anything shootable is close. Shots, teeth and power-ups are not targets: answer no when the only thing lined up is one of those.',
  thrust: 'Should the teapot thrust forward (in the direction the spout points) now? There is no friction: the teapot keeps all its speed, so speed builds up quickly. Thrust only when teapot.speed is below 4, nothing shootable is in bullet range, and a target (on screen or a radar blip) is within about one turn step of the spout, so the teapot travels to it; or to escape danger that is behind or beside it. Never thrust when teapot.speed is 4 or more, or toward something that will collide within about 15 ticks.',
  shield: 'Should the teapot raise its shield right now? The shield blocks all damage while held, but power is limited. Look only at things with a ticks_until_collision of 20 or less (null means it is not approaching: never shield for it). Raise the shield when such a thing will not be destroyed before it arrives: enemy shots, rival shots and teeth can never be shot down; something that needs 3 or more more hits will not break in time (one shot every 8 ticks); and anything behind or beside the teapot (more than one turn step from the spout) cannot be hit in time. Do not raise it when teapot.currently_invulnerable is true.',
};

// Options (tested 2026-10-05 in 2-minute seeded solo games):
//   brake:   also ask whether to brake (the down arrow: stops the teapot dead)
//   thrust:  'fixed' (yes/no, 2 of the 4 ticks) or 'variable' (none/tap/half/full)
//   turning: 'coarse' (3,1,0,1,3 steps) or 'fine' (any of 0-4 steps either way)
//   modeAware: the game mode, its goal, rivals' bullets and rival priority (default true;
//   false = the prompt before 2026-10-05, policy name 'jev-old')
export function makeJev({ every = 4, history: histN = 0, brake = false, thrust: thrustMode = 'fixed', turning = 'coarse', modeAware = true, prompt = {}, shieldAt = 0.5 } = {}) {
  const P = { ...DEFAULT_PROMPT, ...prompt };
  const key = typesafeKey();
  if (!key) throw new Error('No TYPESAFE_API_KEY (set it, or JEV_ENV=path/to/.env)');
  const policy = {
    name: 'jev',
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    async decide(st, history) {
      const plan = [];
      if (!st.me || !st.me.alive) {
        for (let i = 0; i < every; i++) plan.push({});
        return { plan, label: 'waiting to respawn', ticks: every };
      }
      const state = describe(st, history, histN, { modeAware, goals: P.goals, meanings: P.meanings });
      const rivalHint = modeAware && (st.mode === 'duel' || st.mode === 'melee') ? P.rivalHint : '';
      const body = {
        model: 'jev-latest',
        state,
        questions: {
          steer: turning === 'fine' ? {
            type: 'choice',
            instructions: 'You control the teapot in an Asteroids-style arcade game. Over the next fifth of a second (4 ticks), how many steps should the spout turn? Usually turn toward the best target to shoot by its turn_steps_to_aim (one step is 22.5 degrees), or away from something about to collide if you plan to thrust away.' + rivalHint,
            criteria: {
              left_4: 'turn left 4 steps (90 degrees)', left_3: 'turn left 3 steps (67 degrees)',
              left_2: 'turn left 2 steps (45 degrees)', left_1: 'turn left 1 step (22 degrees)',
              straight: 'keep the current heading (already lined up, or nothing needs aiming)',
              right_1: 'turn right 1 step (22 degrees)', right_2: 'turn right 2 steps (45 degrees)',
              right_3: 'turn right 3 steps (67 degrees)', right_4: 'turn right 4 steps (90 degrees)',
            },
          } : {
            type: 'choice',
            instructions: P.steer + rivalHint,
            criteria: {
              hard_left: 'turn left 3 steps (67 degrees)',
              left: 'turn left 1 step (22 degrees)',
              straight: 'keep the current heading (the target is already lined up, or nothing needs aiming)',
              right: 'turn right 1 step (22 degrees)',
              hard_right: 'turn right 3 steps (67 degrees)',
            },
          },
          fire: {
            type: 'noul',
            instructions: P.fire,
          },
          thrust: thrustMode === 'variable' ? {
            type: 'choice',
            instructions: 'How much should the teapot thrust forward (in the direction the spout points) over the next 4 ticks? Each tick of thrust adds 1 to its speed in that direction. Thrust to close in on distant targets or to escape danger that is behind or beside it; do not thrust toward something that is about to collide, and avoid building up too much speed (above about 6).',
            criteria: { none: 'no thrust', tap: '1 tick of thrust (a nudge)', half: '2 ticks of thrust', full: '4 ticks of thrust (hard push)' },
          } : {
            type: 'noul',
            instructions: P.thrust,
          },
          ...(brake ? { brake: {
            type: 'noul',
            instructions: 'Should the teapot brake right now? Braking stops it dead in one tick (there is no friction otherwise). Yes when it is moving fast toward danger, drifting away from good targets, or being pulled into a whorl; no when it is still or moving where it wants to go.',
          } } : {}),
          shield: {
            type: 'noul',
            instructions: P.shield,
          },
        },
      };
      let ans = null;
      for (let attempt = 0; attempt < 3 && !ans; attempt++) {
        try {
          const res = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          policy.calls++;
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const out = await res.json();
          ans = out.answers;
          if (out.usage) { policy.inputTokens += out.usage.input_tokens || 0; policy.outputTokens += out.usage.output_tokens || 0; }
        } catch (e) {
          policy.errors++;
          if (attempt === 2) console.error('jev error:', e.message);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (!ans) {
        for (let i = 0; i < every; i++) plan.push({});
        return { plan, label: 'jev unavailable', ticks: every };
      }
      const steer = ans.steer.choice;
      const fire = ans.fire.noul > 0.5;
      const thrustTicks = thrustMode === 'variable'
        ? ({ none: 0, tap: 1, half: 2, full: 4 }[ans.thrust.choice] || 0)
        : (ans.thrust.noul > 0.5 ? 2 : 0);
      const thrust = thrustTicks > 0;
      const braking = brake && ans.brake && ans.brake.noul > 0.5;
      // shield cutoff 0.5 since the battle puzzles (bots/puzzles/): at 0.6 Jev's "yes"
      // answers for real threats often fell short (0.5-0.6), with no false shields at 0.5
      const shield = ans.shield.noul > shieldAt && st.me.shield_power > 0;
      let turns = turning === 'fine'
        ? ({ left_4: -4, left_3: -3, left_2: -2, left_1: -1, straight: 0, right_1: 1, right_2: 2, right_3: 3, right_4: 4 }[steer] || 0)
        : ({ hard_left: -3, left: -1, straight: 0, right: 1, hard_right: 3 }[steer] || 0);
      for (let i = 0; i < every; i++) {
        // brake on the first tick (stops dead), then thrust if asked
        const c = { fire, shield, brake: braking && i === 0, thrust: i >= (braking ? 1 : 0) && i < (braking ? 1 : 0) + thrustTicks };
        if (turns > 0) { c.right = true; turns--; } else if (turns < 0) { c.left = true; turns++; }
        plan.push(c);
      }
      const label = [braking && 'brake', steer !== 'straight' ? steer.replace('_', ' ') : 'steady', fire && 'fire',
        thrust && (thrustMode === 'variable' ? `thrust ${thrustTicks}` : 'thrust'), shield && 'shield']
        .filter(Boolean).join(', ');
      return { plan, label, ticks: every, raw: { steer, fire: +ans.fire.noul.toFixed(2), thrust: ans.thrust.choice || +ans.thrust.noul.toFixed(2), shield: +ans.shield.noul.toFixed(2) } };
    },
  };
  return policy;
}
