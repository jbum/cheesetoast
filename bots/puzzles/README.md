# Battle puzzles

Chess-puzzle-style tests for the bots' decisions: a board position with one
clearly right behavior and a distraction or two. No game runs. Each board is
set up in the real game with `ctAgent.setup()`, the bot interface reports the
state a bot would see, and the policy is asked once per repeat (one Jev call).

- `puzzles.mjs`: 22 hand-made boards. They cover threats with a rival as bait,
  rival priority when it's safe, shield discipline (use it for unshootable or
  too-tough things, not for passing shots or while invulnerable), and decoys
  like teeth.
- `mine.mjs`: mines boards from multiplayer recordings in `bots/logs/`.
  - **Deaths:** half a second before each death. The answer is fire if the threat
    is lined up, in range and breaks in one hit, otherwise shield. Threats one
    turn step off are skipped as ambiguous.
  - **Rival hits:** the shooter's board just before the hit. The answer is fire.
  - **Calm moments:** nothing harmful within 25 ticks. The answer is no shield.

  Writes `mined.json`.
- `prompts.mjs`: prompt variants. Each variant is a set of `makeJev` options;
  `prompt` overrides pieces of `DEFAULT_PROMPT` in `bots/policies/jev.mjs`.
- `run.mjs`: grades variants and saves the raw answers in `results/`.

```
node bots/puzzles/run.mjs --show [--mined]                  # the boards as the bot sees them (free)
node bots/puzzles/run.mjs --variants current,v3 --repeat 2 --mined
node bots/puzzles/mine.mjs --max 70                         # refresh mined.json from recent recordings
```

Grading uses the bots' cutoffs: fire if Jev's answer is above 0.5, and shield
if it's above `--shield-at`, default 0.5. Each run of about 90 puzzles × 2
variants × 2 repeats costs around 2 cents.

## Results, 2026-10-05

| Variant | Hand-made, 22 | Mined deaths, 39 | Mined calm, 28 | Overall |
|---|---|---|---|---|
| prompt before the puzzles, shield cutoff 0.6 | 75% | 26% | | |
| same prompt, cutoff 0.5 | 77% | 33% | 96% | 65% |
| **v3, now the default** | 100% | 91% | 96% | 95% |
| v4 | 100% | 81% | 100% | 92% |

v3's changes:
- **Shield:** look only at things that collide within 10 ticks (no collision
  time means it's not approaching). Shots and teeth can't be shot down, and
  something needing 3 or more hits won't break in time. Anything behind or
  beside the teapot can't be hit in time. Not while invulnerable.
- **Fire:** rivals count as targets, and the teapot can fire with its shield up.
  Don't fire when only teeth, a shot or a power-up is lined up.
- **Shield cutoff 0.5:** Jev's answers for real threats often landed between
  0.5 and 0.6, while its answers for calm moments stayed below 0.5.

## Co-op suite, 2026-10-05

`--suite coop` runs `puzzles-coop.mjs` and `mined-coop.json` (mine with
`mine.mjs --logs '-mp-coop-' --out mined-coop.json`). It has 18 hand-made
puzzles. Some are survival boards in co-op mode. Some are melee boards with
co-op answers: the rival becomes a partner, so it's not a target and its
bullets are harmless. The rest test going after targets: with nothing in
range, thrust toward a target on screen or on radar, but not into a collision
or past a speed of 6.

| Variant | Co-op suite with mined | Melee suite with mined |
|---|---|---|
| before | 94% (thrust toward targets about 0.37) | 93% |
| **c1, now the default** | 99% | 96% |

c1 changed three things. Thrust when nothing is in range and a target is
within one turn step, and not toward a collision, with a target already in
range, or above speed 6. Turn hard when the target is 3 or more steps away.
The co-op goal says partners clear nearby targets too, so go find targets.

## Shield in advance, 2026-10-05

In co-op videos, bots ran into things without shielding first. The board from
0.6 to 0.8 s before each death, mined with `mine.mjs --kinds death --lead 12|16
--window 20 --prefix adv12-|adv16- --append`, made 93 new co-op puzzles.

| Shield window | 0.6 s before | 0.8 s before | Calm moments | Melee suite |
|---|---|---|---|---|
| 10 ticks (before) | 64% | 42% | 100% | 93% |
| 15 ticks | 84% | 81% | 100% | 96% |
| **20 ticks, now the default** | 88% | 91% | 100% | 96% |

In play, the bigger problem was speed of decision. Four bots sharing a browser
made only about 3 decisions per second instead of 5, because their pages drew
the game at 60 fps. Bots now skip drawing (`ctAgent.setDraw(false)`). In a
90-second 4-Jev co-op game, deaths fell from 5.1 to 1.3 per minute, and points
rose from 1,800 to 2,883 per minute.
