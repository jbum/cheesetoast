# Cheese Toast multiplayer: a plan

Status: plan only, nothing built. Target: a separate site, **ctm.krazydad.com**,
sharing the game code with ct.krazydad.com.

## The game it describes

- In attract mode, choose **Duel** or **Co-op** (remembered for next time),
  then press Play. If someone is playing **solo in the same mode**, you're
  dropped into their universe; otherwise you start solo and become the one
  someone else can join. Duel players are only ever matched with duel players,
  co-op with co-op: **two separate queues**.
- Two teapots share one universe: the same asteroids, enemies, whorls and
  power-ups. Each player keeps their own score, lives and shield.
- When one player runs out of pots, **the loser goes back to attract mode**
  (and may press Play again to join someone else). **The winner keeps playing**,
  is solo again, and goes to the **back of the queue** of joinable players.
- Later: players choose how many they're open to playing with (1 to 4), and
  newcomers can join games that already have several players.
- **On desktop, players can chat**, shown as speech balloons over their teapots.
  The chat appears only while two or more players share a universe.

### Duel and Co-op

Players pick one; the choice changes more than friendly fire:

- **Duel (the original idea):** teapots can shoot each other. The
  last-pot-standing rule is a natural fit: the loser leaves, the winner takes on
  the next challenger, king-of-the-hill style. Shooting the other teapot costs
  them a pot (and scores for you); asteroids and enemies are hazards for both.
- **Co-op:** bullets pass through (or harmlessly bump) your partner, you
  fight the breakfast together, and the rule becomes "whoever lasts longer stays
  on". Gentler, and more forgiving of lag.

The two modes share all the netcode; each has **its own queue** on the server.
What differs:

| | Duel | Co-op |
|---|---|---|
| Hits on the other teapot | lose a pot (shield blocks it) | none, or a harmless bump |
| Hit fairness under lag | **matters a lot**: needs lag compensation (below) | barely matters |
| Host advantage (host sees no lag) | noticeable, needs mitigating | acceptable |
| Respawn | away from the other player, with the usual auto-shield | anywhere safe |
| Scoring | points for hitting the other teapot | shared or separate, both fine |
| Enemies chase | the nearest teapot | the nearest teapot |

It is a hard problem, but a well-studied one, and this game has three things
going for it: the game logic already runs at a fixed 20 ticks a second apart
from rendering, the world is small (a 3840x1920 torus, ~100 sprites), and the
only thing a player controls is seven buttons.

## Recommended architecture

### Peer to peer for the game, a small server for everything else

```
  player A (browser) <======= WebRTC data channel =======> player B (browser)
         \                    (game traffic, P2P)                 /
          \                                                      /
           `---- HTTPS: queue, matching, connection setup ------'
                          server: ct-match service
                          (+ STUN/TURN for connections that can't go direct)
```

- **Game traffic goes directly between the browsers** over a WebRTC data
  channel. The server never sees it.
- **The server only matches players and introduces them** ("signaling": it
  passes each browser's connection offer to the other). After that it's out of
  the loop until someone leaves.
- **STUN/TURN.** Most pairs of home networks can connect directly once a STUN
  server tells each browser its public address (Google's public STUN servers
  work, or run our own). Some networks (many mobile carriers, strict corporate
  NATs, roughly 10-20% of pairs) can't, and need a **TURN relay** that forwards
  their traffic. Run `coturn` on the server for that; it only carries traffic for the
  pairs that need it, a few tens of KB/s each.

### Who decides what happens: one player is the "host"

There are two classic ways to keep two copies of a game in agreement:

1. **Lockstep / rollback** (fighting games, RTS): both browsers run the full
   simulation and exchange only button presses. Tiny traffic and no lag for
   your own moves, but **both simulations must stay bit-for-bit identical**
   forever. In JavaScript across browsers that's fragile: `Math.sin`, `cos`,
   `hypot` and `atan2` may differ in the last bit between Chrome's and
   Safari's engines, and one bit eventually snowballs into two different games.
2. **Authoritative host** (most action games): one browser runs the real game
   and sends the other compact snapshots of the world; the other sends its
   button presses to the host and draws what it's told, predicting its own
   teapot so its controls feel instant.

**Recommendation: authoritative host.** It doesn't need cross-browser
determinism, recovers from hiccups by itself (the next snapshot fixes
anything), and fits the join rules naturally: **the solo player is already
running the world, so they become the host** and the newcomer is the guest.

Traffic at 20 snapshots/second with ~100 sprites at ~12 bytes each is about
25 KB/s from host to guest before any compression, and under 1 KB/s back.
That's fine on any connection, including phones. (Sending only what changed,
or 10 snapshots/second plus interpolation, cuts it further.)

### Making it feel good at ~50-150 ms of lag

- **Your own teapot:** the guest applies its own inputs immediately
  ("client-side prediction") and keeps a short history; when a snapshot shows
  where the host thinks it is, the guest replays the inputs the host hasn't
  seen yet on top ("reconciliation"). Steering and thrust feel local.
- **Everything else:** the guest draws other sprites ~100 ms in the past,
  interpolating between the last two snapshots, so motion is smooth. The game
  already interpolates between ticks for rendering, so the drawing side is
  half done.
- **The guest's bullets** appear instantly on the guest's screen (predicted)
  but **hits are decided by the host.** Occasionally a shot that looked like a
  hit won't count. Against asteroids and enemies that's rare and forgivable.
- **In a duel, teapot-on-teapot hits need lag compensation.** The guest aims at
  where the host's teapot *appeared* ~100 ms ago. When a guest bullet is
  checked, the host rewinds the target teapot to where the guest saw it (the
  host keeps a second or so of teapot positions) and scores the hit if it lands
  there. This is the standard fix ("favor the shooter"); without it, duels feel
  unfair to the guest.
- **The host plays with zero lag.** Fine in co-op. In a duel it's a real
  edge; lag compensation removes most of it, and alternating who hosts (the
  winner of a duel hosts the next one, since they're the one staying) spreads
  the rest around.

### Two data channels

- **Unreliable, unordered** (`ordered: false, maxRetransmits: 0`): snapshots
  and inputs. A late snapshot is useless, so never wait for retransmits; each
  input packet carries the last few ticks of inputs so a lost packet costs
  nothing.
- **Reliable, ordered:** events that must arrive exactly once: "player joined",
  "you lost your last pot", scores, names, leaving, and chat messages.

## Matchmaking and the queue (server)

A new small service on the server, **ct-match**, alongside the existing score server
and in the same style (Python standard library, systemd, Apache proxy):

- **Two queues, `duel` and `coop`.** Each entry: player id, name, mode, time
  joined. A player is in at most one queue, the one for the mode they chose.
- `POST /mm/play {name, mode}` → the server either pairs you with the **oldest
  waiting solo in that mode's queue**, or says "start solo; you're in the
  `mode` queue".
- **Server → browser messages** use Server-Sent Events (a long-lived HTTPS
  response the standard library can serve; Apache needs proxy buffering off).
  **Browser → server** is plain `POST`. No WebSocket library needed.
- Pairing: the server tells the waiting solo (host) and the newcomer (guest)
  about each other and relays their WebRTC offer/answer/ICE messages. Once the
  data channel opens, both tell the server, which removes the host from the
  queue.
- `POST /mm/solo` (winner is solo again → back of **their mode's** queue),
  `POST /mm/leave`. The mode stays fixed for a whole session; to switch, go back
  to attract and choose again.
- `GET /mm/status`: how many are waiting in each queue, for an attract-screen
  hint like "2 duelists waiting".
- **Heartbeats:** a player in the queue pings every few seconds; silent players
  drop out of the queue, so nobody gets paired with a closed tab.
- If the connection can't be made within ~5 s (even via TURN), the guest just
  starts solo and joins the queue itself; the host stays in the queue.

The queues are small in-memory state; nothing needs a database. The existing
Hall of Cheese keeps working as-is (each player submits their own score).

## Chat (desktop)

- **Only while 2+ players share a universe.** Solo, there's no chat UI at all.
  It appears when someone joins and disappears when they leave.
- **Desktop only at first.** On phones and tablets, the on-screen keyboard would
  cover the game; a later option is a few one-tap phrases ("Nice shot!",
  "Help!", "GG", a teapot emoji) as small buttons.
- **Typing:** press **Enter** (or **T**) to open a one-line text field at the
  bottom of the screen; **Enter** sends, **Esc** cancels. While the field is open
  your keys type instead of steering, and **your teapot keeps flying** on its
  last heading; the world doesn't pause (it can't). A small "typing..." dot over
  your teapot warns the other player you're not at the controls.
- **Speech balloons:** a message appears as a rounded balloon with a tail
  pointing at the speaker's teapot, drawn in the game's comic font, following
  the teapot as it moves. It stays a few seconds (longer for longer messages),
  then fades. New messages from the same player replace the old balloon.
  - **Speaker off screen:** the balloon sits at the screen edge on the side
    where they are, with its tail pointing their way (like the radar).
  - **Your own messages** get a balloon over your teapot too, so you see what
    was said.
- **A faint log** of the last few lines (fades when idle) in a corner, so a
  message isn't lost if a balloon was missed mid-fight.
- **Sent over the reliable data channel**, peer to peer, with the sender's name
  and the tick it was sent on. Length limit ~80 characters; a simple rate limit
  (e.g. 1 message a second).
- **Keeping it PG-13.** Names already go through Jev. For chat, the sending
  browser can ask ct-match to check each message with Jev (same question as
  names) before sending it; at chat rates that's cheap, and a rejected message
  just shows "(not sent)" to its author. If Jev is slow or down, fall back to a
  short local word list rather than blocking chat. Also a **mute** button per
  player.

## Game rules to settle (open questions)

- **Order of building the modes:** both ship eventually (players choose,
  separate queues). Suggest Co-op first (forgiving while the netcode is young)
  and Duel once lag compensation is in; until then the attract screen can show
  Duel as "coming soon".
- **The mode picker:** two buttons (Duel / Co-op) next to Play, the choice
  saved in localStorage; a keyboard shortcut to toggle (D / C).
- **What do enemies chase?** The nearest teapot.
- **Who gets the points** for a kill: the shooter. For a power-up: whoever
  touches it. In a duel, hitting the other teapot scores too (how much?).
- **Difficulty:** more asteroids and enemies with two players
  (`minAsteroids`, bad-guy chance), and the level counter: shared, or the
  host's? *Done 2026-10-05:* the level is shared (it follows the best score), and
  `difficultyScale()` multiplies the asteroid floor, the bad-guy and power-up odds and
  the teeth cap by 1 + 0.5 per extra player still in (1.5x with two, 2.5x with four).
- **Spawning:** "not in view of any player" (the rule just added for one).
  New ships appear at the center of the universe; with two, offset them.
- **Pause:** can't pause a shared world. Pause/hidden tab for more than a few
  seconds = you've left; your teapot drops out and the other player plays on.
- **Both lose on the same tick:** both go to attract.
- **Different screens:** a phone sees less of the world than a desktop. Fine
  (each camera follows its own teapot), but worth a look for fairness.
- **Opting out:** a "play alone" choice so solo players aren't joined.

## Leaving and winning (host migration)

- **Guest loses:** the guest goes to attract; the host continues solo and
  re-enters the queue. Easy.
- **Host loses:** the guest must take over the world. The guest already has
  the latest snapshot, so it **promotes itself to host**: it starts running the
  simulation from that snapshot, keeps its score and pots, and joins the back
  of the queue as a solo. The old host goes to attract.
- **Disconnects** (closed tab, lost network) are treated as that player losing.

This means **the whole world must be serializable** (snapshot and restore),
which is also what joining needs: a guest arrives mid-game and needs the full
current world, not just changes.

## Changes the single-player code needs first

These are useful refactors on their own and can be done, tested and shipped on
ct.krazydad.com with no visible change:

1. **One ship → a list of ships.** `G.ship` is assumed everywhere: enemies call
   `distanceToLocalPlayer`, the camera follows `offsetX/offsetY`, the shield is
   a singleton, scores and lives live on the game object. Introduce a `Player`
   (ship, shield, score, pots, shield power, ship mode, input) and make
   enemies pick a target.
2. **Inputs per player.** Today the ship reads the global `keyFlags`. Each
   player's input becomes a 7-bit value per tick, which is exactly what goes
   over the network.
3. **Separate simulation from presentation.** Sounds, sparks, text sprites and
   camera animation are cosmetic; the snapshot shouldn't carry them, and the
   guest generates them from events ("explosion at x, y").
4. **Snapshot / restore.** Serialize every sprite's state (type, position,
   velocity, frame, timers, hit count and the per-type fields `f1`, `f2`,
   `state`, `state2`, `lifeSpan`, `rotIdx`) plus game counters, into a compact
   binary buffer. Test: snapshot, restore into a fresh game, and the next 1000
   ticks match.
5. **A seeded random number generator** instead of `Math.random` (~40 call
   sites). Not strictly needed for the host model, but it makes the snapshot
   tests and replays reproducible, and keeps the rollback option open.

## Build order

1. **Refactors 1-5 above** in the single-player game.
2. **Two players on one machine, no network:** two browser tabs talking over
   `BroadcastChannel`, with a fake-network layer that adds adjustable delay,
   jitter and packet loss. All of the netcode (prediction, interpolation,
   joining, host migration) gets built and tuned here, where it's easy to test
   and automate (two headless browsers in one test).
3. **ct-match** on the server: queue, Server-Sent Events, signaling. ctm.krazydad.com
   vhost and certificate, as for ct.
4. **WebRTC** in place of `BroadcastChannel`; STUN; then `coturn` for TURN.
5. **Rules and polish:** the open questions above, the other player's name over
   their teapot, both scores in the status display, the other teapot in its
   own color on the radar, a small lag indicator, "waiting for a partner"
   status in attract mode, the Duel / Co-op picker and per-mode queues
   (Co-op live, Duel "coming soon").
6. **Chat** (desktop): text field, balloons, log, Jev check, mute.
7. **Duel mode**: teapot-on-teapot hits with lag compensation; open the duel
   queue.
8. **Beta** on ctm.krazydad.com with real players on real networks.

Rough size: step 1 is a few days of focused work; step 2 is the big one (one
to two weeks); steps 3-5 are about a week together; chat is a few days; duel
mode with lag compensation another few days to a week. The hard parts are
prediction/reconciliation feel and host migration, not the networking itself.

## Later: games of up to 4

- The host model scales to 4 players as a **star**: the host sends snapshots to
  each guest (~25 KB/s each) and guests talk only to the host. No mesh needed.
- Matching becomes "join the oldest game **in your mode** that has room and
  whose players are all open to one more", with each player's preference (1-4)
  stored in the queue entry. (A four-teapot duel is a free-for-all.)
- Host migration picks the next host by a fixed rule (the longest-connected
  guest), and all guests reconnect to it, which needs another round of
  signaling through ct-match.
- The "loser leaves, winners stay" rule carries over unchanged.

## Risks

- **Feel on bad connections** (mobile, Wi-Fi with jitter). Mitigation: tune
  interpolation delay to measured lag; show a lag indicator; fall back to solo
  if the connection is hopeless.
- **Connection failures between some networks.** Mitigation: TURN on the server;
  join timeout → solo.
- **Host advantage and occasional "that should have hit".** In co-op, minor.
  In duels, lag compensation for teapot hits is required, not optional.
- **Chat abuse.** Jev check on each message, rate limit, per-player mute.
- **Safari / iOS quirks** with WebRTC data channels and background tabs.
  Mitigation: test early on the iPad and iPhone; treat backgrounding as leaving.
- **Cheating.** The host could cheat. For a casual arcade game, accept it; the
  Hall of Cheese already accepts self-reported scores.
- **Security of the new service:** rate limits on queue/signaling endpoints, no
  personal data beyond the display name (already checked by Jev).

## Backlog (from play testing, 2026-10-04)

Done 2026-10-05 (on ctm):

- ~~**Modes and boards:**~~ Co-op, Duel, Melee and Single each have a Hall of Cheese
  (`/api/scores?mode=`; older scores count as Single). A game counts toward the
  multiplayer mode's board if a partner was there at any point, else Single. Attract
  mode shows every board in turn (3.5 s each, the last game's board first).
- ~~**Player names:**~~ a name dialog (js/names.js) before the first game when no name
  is saved, and from the name button on the mode bar; the PG-13 check is the score
  server's `/api/name-check` (Jev), falling back to chat's word list. The host makes
  names unique within a universe ("Ann 2").
- ~~**Player tints:**~~ by color slot (the lowest free one when joining, so colors don't
  shift when someone leaves): untinted, green, blue, gold. Bots instead: red in duel/melee,
  purple in co-op.
- ~~**Bot teapot:**~~ a blinking amber LED on the lid (amber: no player's tint).
- ~~**Sounds:**~~ a bell when a player arrives, a clunk when one leaves or runs out of pots.
- ~~**Fill-in bots:**~~ bots/filler.mjs, running on a spare machine as launchd agent
  com.krazydad.ct-filler (install/update: tools/deploy-filler.sh; log ~/ct-filler/filler.log).
  It polls `/mm/status`, which now lists how long each person has waited alone; after
  30 s it sends one heuristic bot ("🤖 Grace", hurricane names) with `joinOnly`, so a bot
  never waits in the queue itself, only joins people. Bots leave 15 s after the last
  person does, and post their score to the mode's board like anyone else.

Still to do:

- **Cheaper Jev:** a local Jev-like model on a spare machine, and terser state/questions
  (in progress on branch `cheaper-jev`, with a ranking test in bots/bench/).
- ~~**Attract layout:** the Co-op / Duel bar overlapped the beastiary text~~ (moved to top center).
- ~~Experiment: bots starting still vs. kicked~~ Done 2026-10-04 (3 seeds x 2 min, Jev): kicked
  (5 units/tick, random direction) 1933 mean vs still 1733, +200 on every seed; still teapots
  mostly sat parked, kicked ones kept moving (Jev has no brake option). Bots now kick by default.
- ~~Experiment: Jev controls~~ Done 2026-10-05 (seeds 61-63 x 2 min, kicks on): baseline 1600 mean;
  +brake question 1467 (won 1/3; Jev braked only 6 times in ~1800 decisions); variable thrust
  867 (won 0/3; Jev almost stopped thrusting); fine turning 0-4 steps 1333 (won 1/3). None
  conclusive, so Jev keeps yes/no thrust (2 of 4 ticks), coarse turning, no brake. The options
  stay in bots/policies/jev.mjs (`--brake`, `--thrust variable`, `--turning fine`).
- ~~Mode-aware Jev~~ 2026-10-05: bots now get the mode, rivals' bullets (`rival_shot`) and rivals kept
  in their nearby list. A "hunt rivals, keep moving" goal made Jev chase and crash (one 4-Jev melee:
  half the time alive, no rival hits). Softened to "survive first; shoot a rival when it's in range and
  nothing is about to hit you": two same-universe melees, softened vs. the old prompt (`jev-old`):
  score 13,200 vs 6,200, rival hits 4 vs 1, deaths 8 vs 11, ~24 s alive per death for both.
- ~~Battle puzzles~~ 2026-10-05: `bots/puzzles/` tests decisions on single boards (22 hand-made with
  distractions, ~70 mined from recordings) without running games. Tuning shield/fire wording there took
  the suite from 65% to 95% (mined deaths 33% -> 91%, calm moments unchanged at 96%); the shield cutoff
  is now 0.5. See bots/puzzles/README.md.

### From the code review (2026-10-05)

Fixed the same day (each with a scenario in `bots/scenarios.mjs --local` that failed before and
passes after): a guest dropped for 4 s of silence became a ghost (watching, no teapot, never ending);
now the host says `dropped`, keeps its score, pots and color for 90 s, and lets it back in when it says
hello again (a hidden page waits until it is visible). A joiner that never connected left the host out
of the queue with "X is joining..." forever; the host now gives up after 15 s and re-queues. A solo host
that paused stayed in the queue (joiners were welcomed into a universe that wasn't running, then lost
contact); pausing alone now leaves the queue, resuming re-enters it, and a joiner who slips in resumes
the host. A guest's play clock never started (first game on a page: 0 s, so the score server refused
anything over 5000 as implausible), an heir inherited the old host's clock (another page's time, often
negative), and carrying on after a vanished host reset the clock, level and board; all three keep the
right clock now and the carried-on game still counts toward the mode's board.

Also done 2026-10-05: the joiner's wait (the status line counts down "connecting to X... 9", any key
or tap starts a solo universe of your own instead, the retry tells the matchmaker to `avoid` the host
that couldn't be reached, and after two misses it asks to be queued as a host, `hostOnly`); matchmaker
calls give up after 5 s instead of hanging the start; the heir is the guest with a live connection
heard from most recently (not the first joiner, who may be seconds from being dropped); the welcome
carries the name as made unique, so chat says "Ann 2" too. Scenarios: join-unreachable, join-bail,
heir-is-alive, chat.

Also done 2026-10-05, later: a guest whose page is hidden sends `away` with its inputs and the host
parks its teapot (taken out of play, the pot refunded, back when the page is visible; parked players
don't count toward difficulty). Guests of a vanished host regroup: by the last snapshot the lowest id
(people before bots) hosts a fresh universe and keeps the others' scores, pots and colors in
`departed`; the others wait 2 s and call `/mm/join {id, host}` (same id, so the heir knows them); if
that fails they carry on solo as before. Scenarios: guest-away, regroup.

Also done 2026-10-05: hosts tell the matchmaker their level (`solo {players, level}`, re-sent when
the level goes up); newcomers go to the lowest-level universe waiting, oldest among equals, and a
universe at level 2 (20,000 by its best score) is closed to newcomers: the host leaves the queue and
the matchmaker wouldn't send anyone anyway (`CLOSED_LEVEL` in both). The people already there play
on. Scenario: low-level-first.

Also done 2026-10-05: **the games list** (`/games/`, games/index.html, linked as Games on the top
line). Hosts describe their universe (`/mm/game`: players with bot flags, max, level, noBots, re-sent
when any of it changes, and again after a matchmaker restart); `/mm/games` lists them, open or
closed with the reason (full, level, not taking players). Filters (modes; open / closed / all) are
remembered, columns sort, the table scrolls under a sticky header, and it refreshes every 3 s. Join
links to `/?join=<host>&mode=`, which starts that game once you tap in; `play {host}` pairs you with
it if it's still open (else as usual, and the status line says it had closed). **No bots:** a
universe-wide flag the host holds (`game.noBots`, in snapshots and handoffs); any person in it can
switch it in the settings (guests send `nobots`), bots can't. Turning it on sends bots already there
home (`out`); the matchmaker pairs no bot with such a game and doesn't count it as waiting, so the
filler daemon leaves it alone. **Settings** (gear on the top line and the HUD, js/settings.js):
sound, volume (remembered), full screen, name (between games), and "Let bots join"; alone it
pauses, in a shared universe it parks your teapot (`in.w`, or `parkPlayer` on the host itself) and
a returning teapot spawns after half a second instead of three. **Solo** on the top line: a plain
game, no matchmaker. Scenarios: games-list-join, no-bots, settings-park, solo-button.

Also done 2026-10-05: more settings (all personal, remembered): names under teapots, reduce motion
(no intro or game-over spin; defaults to the system's preference), touch buttons left-handed
(mirrored) and sized 80-130%, "up to 2 / 3 / 4" players for co-op and melee (hosting: the game's
size; joining: only games no bigger, `play {max}`; the matchmaker caps games at 4, MAX_PLAYERS),
chat on/off, mute a player (by name; muted players stay muted), and a Controls section. A guest's
status line now names everyone in the game (it named only the host it joined). Join links skip the
start screen, and when that game ends you're back on the games list. Scenarios: settings-personal,
settings-touch, guest-status; games-list-join checks the last two.

Also done 2026-10-05: **+ New game** on the games page (always shown; the empty list's "Start one"
opens it too): a dialog for the game type, players up to 2 / 3 / 4 (not for duels) and "Let bots
join", remembered; Start goes to `/?new=1&mode=&max=&bots=` which hosts a game with those settings
straight away (`mp.newGame`: hostOnly, then noBots), and the game's end returns to the games page.
**No click-to-start:** the loading screen shows only while loading; the title flies in and the
attract mode begins by itself ~2 s later (a tap or key skips the wait). Attract is silent; the
fanfare (`SND.LevelCompletion`, CT_III's attract debut) now opens every game (beginGame, and
startGuest for guests), played by the key or tap that unlocks the audio. Coming from the games page
there was no gesture on this page, so on Safari the fanfare waits for the first key or tap.
Scenarios: games-list-new, attract-silent.

Fixed 2026-10-06 (from the first daily log review): a host whose page closes mid-handoff, losing the
handoff and some "follow the heir" notices, left its guests scattered (the live melee of 2026-10-05
20:10: three bots, each alone). Snapshots now carry the host's heir (`h`, Session.currentHeir: stable
until that player is gone, out or quiet 2.5 s); a regroup goes to that heir and never to the host the
snapshots came from; `rehost` goes out to everyone, the heir included, before the big `handoff`; and
a fill-in bot regrouping alone may host (joinOnly no longer blocks it). Scenario: host-leaves-bots
(its page drops the handoff and one notice before closing).

Done 2026-10-06: **the TURN relay.** coturn on the server (server/turnserver.conf, installed by
tools/install-turn.sh): UDP and TCP on 3478, TLS on 5349 with ct's certificate (copied by a certbot
renewal hook), relay ports 49160-49400, never relaying into private networks, small quotas. The
matchmaker hands out short-lived credentials (`/mm/ice`, TURN REST: HMAC of a secret shared with
coturn, ~/ctm-match/turn.secret on the server, never in git; registered ids only), which the client
fetches right after `play`. WebRTC still connects directly when it can; the relay only carries pairs
that can't (in the 2026-10-05 log: three of six friends). Each connection's route is logged in the
diagnostics ("route abc123: relay/relay udp via udp"). Scenarios: turn-relay (only relayed routes
allowed, `?relay`: failed before, connects now), turn-relay-tls (`?relay=tls`, the TLS address only).
Found on the way: matchmaker events that arrived before the page attached its handler were dropped
(a host's offer could beat a joiner's setup once `play` also fetched the relay's credentials, and
the join then timed out); the Matchmaker now holds them until a handler is set.

From the 2026-10-08 games with friends (six people, co-op): (1) P in a shared game handed the
universe from host to host (13 pauses, 5 hand-offs in two minutes; "Hit P to Play" makes P the first
key people press). Pausing in a shared universe now freezes your teapot in place under the pause
overlay, sound off, the others playing on; in duel and melee rivals can still shoot it, nothing else
can touch it; the host keeps hosting. Hidden pages and the settings freeze the same way (no more
parking). An X on the HUD ends the game, after "End this game?". (2) Collisions never happened
across the universe's seam (CT_III's box test didn't wrap): with three of four duel/melee starts on
a seam, a rival who hadn't moved couldn't be shot. Fixed in sprites.js `inRange`. (Players who sat
still at their spawn were new and didn't know how to thrust: not a bug.) Saucers now come at level
0 and percolators at level 1 (user's call). Scenarios: pause-shared, pause-melee-shot; guest-away
and settings-park check freezing.

Lag work (2026-10-09, from the analysis in the user's notes, CHEESETOAST_MP_LAG_2026-10-08): a guest
used to be a dumb terminal, about 130-190 ms from a key to its teapot moving. Now (net.js, protocol 2,
`PROTO`):
- **Prediction.** The guest runs its own 20 Hz ticks, numbers its inputs and sends the last four with
  each (`in.q`); the host applies one per tick in order (`applyInputs`, from `game.onTickStart`; skips
  ahead past three waiting) and reports the last one applied (players[16]). The guest moves its own
  teapot with the host's code (sprites.js `steerBits` + `shipMotion`, split out of shipMove), replays
  the inputs the host hasn't seen onto each snapshot's teapot, and fades the leftover difference out
  over ~120 ms. The camera follows the predicted teapot; thrust, shield and firing sounds and the
  shots themselves start at once (predicted shots give way to the host's, which ease from the present
  back to the host's timeline over 10 ticks). Collisions, deaths and scores stay the host's.
- **Playout buffer.** Everything else is drawn from buffered snapshots about one tick plus the
  measured jitter behind the newest (the host's clock is estimated from the earliest arrivals of the
  last 3 s), interpolated by time, extrapolated up to 3 ticks when the buffer runs dry. Events (sounds,
  explosions, popups) come on the reliable channel tagged with their tick and play when that tick is
  shown. (Guests also stopped showing score popups after 32: updateTextSprites never ran there.)
- **Binary snapshots** (js/wire.js): 22 bytes a sprite plus a small JSON part for the players; a
  50-sprite four-player universe is ~1.3 KB a tick, 27 KB/s per guest (JSON was 3.5-8 KB, 70-160 KB/s).
  A lossy message to a peer whose channel still holds a whole one is skipped (`bufferedAmount`).
- **Measured.** Pings on the reliable channel (they don't count as signs of life); round trips, snapshot
  gaps and losses, playout delay, prediction lead and misses, KB/s and snapshot size in `__mpDbg().lag`,
  the 20 s diags, and the stats overlay. The heir is now the fresh guest with the shortest round trip.
- **Testing:** `?netsim=RTT,JITTER,LOSS` on a page delays and drops its WebRTC traffic both ways
  (reliable messages keep their order); `?nopredict` turns prediction off. Scenarios predict-lag (a
  guest at +160 ms, 40 ms jitter, 3% loss: Left answers in one frame, prediction misses by 0) and busy-4
  (four bots, two on bad networks). Hosts and guests from before protocol 2 still play with new ones
  (JSON snapshots with events, unnumbered inputs; checked both ways against 1107f09).

Not done from that plan: delta snapshots (only changed sprites), keeping each snapshot to one packet,
chunking the handoff, running guests' clocks ahead of the host's, host fairness in duels, choosing the
host by connectivity in the matchmaker, and a universe hosted on the server.

Still to do, roughly by how bad they feel:

- **Heir choice, further:** pickHeir prefers a live, recently heard connection; it could also prefer
  bots on a spare machine or desktops over phones (the hello could carry `touch`).
- **Three-player duel:** two `play()` calls before the host's `busy()` are both sent to it and `addGuest`
  has no cap. Cap per mode on the server from the host's `players`, and have the host answer `full`.
- **Handoff size:** send errors are swallowed, and a `fullState` handoff is ~380 bytes a sprite against
  Chrome's 256 KiB message cap. Log errors, chunk the handoff.
- **"Connection trouble" note:** a guest whose snapshots stop sees a 4 s freeze and is then dumped into
  solo; say "waiting for X..." after 1 s.
- Small: "A shared universe can't pause" never clears until the next status change; during a spin-out
  the other players' orphan teapots mirror your keys (host after handoff, guest after being out:
  `gameTick` runs with `multi` false); `restoreState` drops `spawnedOnce`, so after a handoff duel
  respawns use the fixed starts; the iOS fullscreen-help button pauses, which in a shared universe is a
  step-down.
