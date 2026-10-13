#!/usr/bin/env node
// Mine battle puzzles from multiplayer recordings (bots/logs/*-mp-*.jsonl.gz):
//   - half a second before each death: the board around the teapot that died
//   - just before each rival hit (a +2000 jump): the shooter's board
// Each board is set up in the real game (ctAgent.setup) to get the state a bot
// would see, and labeled by geometry (no Jev calls):
//   death: the most imminent harmful thing (ticks_until_collision <= 10): fire if
//          it is shootable, lined up (0 turn steps), in range and breaks in one
//          hit; otherwise shield.  Boards with no visible threat are skipped.
//          Skipped as ambiguous: a one-hit shootable threat one turn step off
//          (turning and shooting is as reasonable as shielding).
//   hit:   a rival in range within one turn step -> fire.
//   calm:  a moment every ~10 s with nothing harmful within 25 ticks -> no shield.
//
//   node bots/puzzles/mine.mjs [--logs '-mp-coop-'] [--max 40] [--out mined-coop.json]
// Writes bots/puzzles/mined.json (run.mjs --mined adds them to the suite).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadPlaywright, parseArgs, chromiumLaunchOptions, serveRepo, LOCAL_URL } from '../lib.mjs';
import { ST } from '../../js/constants.js';

// --lead: frames (ticks) before a death to take the board; --window: how soon (ticks) a
// threat must arrive to count; --append adds to --out; --prefix tags the ids (e.g. adv-)
const args = parseArgs(process.argv.slice(2), { logs: '', max: 60, out: 'mined.json', lead: 10, window: 10, append: false, prefix: '', kinds: 'death,calm,hit' });
const KINDS = new Set(String(args.kinds).split(','));
const here = path.dirname(new URL(import.meta.url).pathname);
const logDir = path.resolve(here, '../logs');
const NAMES = []; for (const [k, v] of Object.entries(ST)) NAMES[v] = k;
const SKIP = new Set(['Teapot', 'TeapotNew', 'Shield', 'Explosion', 'RingExplosion', 'ScoreTile', 'Quake', 'Morsel', 'DemoTeapot', 'Yummies', 'Creamer']);
const SHOTS = new Set(['Bullet', 'CreamBullet']);

const wrap = (dx, dy) => [((dx % 3840) + 5760) % 3840 - 1920, ((dy % 1920) + 2880) % 1920 - 960];

let files = fs.readdirSync(logDir).filter((f) => /-mp-(melee|duel|coop)-.*\.jsonl\.gz$/.test(f)).sort();
if (args.logs) { const re = new RegExp(String(args.logs).replace(/\*/g, '.*')); files = files.filter((f) => re.test(f)); }
files = files.slice(-12);   // the most recent recordings

function boardAt(fr, j, name, mode) {
  const f = fr[j], f0 = fr[j - 1];
  const me = f.ships.find((s) => s.name === name), me0 = f0.ships.find((s) => s.name === name);
  if (!me || !me0 || !me.pos || !me.pos[3] || !me0.pos) return null;
  const [mx, my, rot] = me.pos;
  const [mvx, mvy] = wrap(mx - me0.pos[0], my - me0.pos[1]);
  if (Math.hypot(mvx, mvy) > 30) return null;   // just respawned/teleported
  const rel = (x, y) => wrap(x - mx, y - my);
  // velocity of a sprite: the nearest same-type sprite one frame earlier
  const vel = (sp) => {
    let best = null, bd = 30;
    for (const q of f0.s) if (q[0] === sp[0]) {
      const [dx, dy] = wrap(sp[1] - q[1], sp[2] - q[2]);
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = [dx, dy]; }
    }
    return best || [0, 0];
  };
  const things = [], rivalShots = [];
  for (const sp of f.s) {
    const type = NAMES[sp[0]];
    if (!type || SKIP.has(type)) continue;
    const [x, y] = rel(sp[1], sp[2]);
    if (Math.hypot(x, y) > 450) continue;
    const [vx, vy] = vel(sp);
    if (SHOTS.has(type)) {
      if (mode === 'coop') continue;
      // someone else's shot: one that is getting closer
      const closing = -((vx - mvx) * x + (vy - mvy) * y) / Math.max(1, Math.hypot(x, y));
      if (closing > 1) rivalShots.push({ x, y, vx, vy });
      continue;
    }
    things.push({ type, x, y, vx: +vx.toFixed(2), vy: +vy.toFixed(2), rad: sp[5] });
  }
  const rivals = mode === 'coop' ? [] : f.ships.filter((s) => s.name !== name && s.pos && s.pos[3]).map((s) => {
    const [x, y] = rel(s.pos[0], s.pos[1]);
    return { x, y, heading: (s.pos[2] || 0) * 11.25 };
  }).filter((r) => Math.hypot(r.x, r.y) < 900);
  return { mode, me: { heading: (rot || 0) * 11.25, vx: +mvx.toFixed(2), vy: +mvy.toFixed(2), shield: me.shield ?? 100 }, things, rivals, rivalShots };
}

const candidates = [];
for (const file of files) {
  const mode = file.match(/-mp-(melee|duel|coop)-/)[1];
  // (a recording cut off mid-game is read as far as it goes)
  const text = zlib.gunzipSync(fs.readFileSync(path.join(logDir, file)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString();
  const rows = [];
  for (const l of text.split('\n')) { try { if (l.trim()) rows.push(JSON.parse(l)); } catch (e) { break; } }
  if (rows.length < 30) continue;
  const fr = rows.slice(1);
  const alive = {}, score = {}, bornAt = {};
  fr.forEach((f, k) => {
    const present = new Set();
    for (const s of f.ships) {
      present.add(s.name);
      const a = !!(s.pos && s.pos[3]);
      if (a && !alive[s.name]) bornAt[s.name] = k;
      if (alive[s.name] && !a && k - (bornAt[s.name] || 0) > 80 && k > 12)
        candidates.push({ kind: 'death', file, mode, k: k - args.lead, name: s.name, t: (f.t / 20).toFixed(1) });
      if ((s.score || 0) - (score[s.name] || 0) >= 2000 && k > 12 && mode !== 'coop')
        candidates.push({ kind: 'hit', file, mode, k: k - 8, name: s.name, t: (f.t / 20).toFixed(1) });
      if (a && k - (bornAt[s.name] || 0) > 80 && k % 200 === 100)
        candidates.push({ kind: 'calm', file, mode, k, name: s.name, t: (f.t / 20).toFixed(1) });
      alive[s.name] = a; score[s.name] = s.score || 0;
    }
    for (const n of Object.keys(alive)) if (!present.has(n) && alive[n]) {
      if (k - (bornAt[n] || 0) > 80) candidates.push({ kind: 'death', file, mode, k: k - args.lead, name: n, t: (f.t / 20).toFixed(1) });
      alive[n] = false;
    }
  });
  for (const c of candidates.filter((c) => c.file === file)) c.board = boardAt(fr, c.k, c.name, mode);
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await serveRepo(context, path.resolve(here, '../..'));
const page = await context.newPage();
await page.goto(LOCAL_URL + '?agent&solo');
await page.waitForFunction(() => window.ctAgent && document.getElementById('start').classList.contains('ready'), null, { timeout: 60000 });
await page.evaluate(() => { ctAgent.seed(1); ctAgent.manual(true); ctAgent.start(); });

const HARM = new Set(['asteroid', 'enemy', 'enemy_shot', 'rival_shot', 'teeth']);
const out = [];
const skipped = { noBoard: 0, noThreat: 0, noRival: 0, ambiguous: 0, notCalm: 0 };
for (const c of candidates) {
  if (!KINDS.has(c.kind)) continue;
  if (!c.board) { skipped.noBoard++; continue; }
  const st = await page.evaluate((b) => ctAgent.setup(b), c.board);
  const id = `${args.prefix}${c.kind}-${c.file.slice(11, 19).replace(/-/g, '')}-${c.name.replace(/\W+/g, '')}-${c.t}s`;
  if (c.kind === 'death') {
    const threats = st.entities.filter((e) => HARM.has(e.kind) && e.ticks_to_impact != null && e.ticks_to_impact <= args.window)
      .sort((a, b) => a.ticks_to_impact - b.ticks_to_impact);
    if (!threats.length) { skipped.noThreat++; continue; }
    const t = threats[0];
    if ((t.kind === 'asteroid' || t.kind === 'enemy') && t.hits_left <= 1 && Math.abs(t.turn_steps) === 1 && t.in_fire_range) { skipped.ambiguous++; continue; }
    const shootable = (t.kind === 'asteroid' || t.kind === 'enemy') && t.hits_left <= 1 && t.turn_steps === 0 && t.in_fire_range;
    const expect = shootable ? { fire: true } : (c.board.me.shield > 10 ? { shield: true } : null);
    if (!expect) { skipped.noThreat++; continue; }
    out.push({ id, source: `${c.file} @${c.t}s, ${c.name} died ${(args.lead / 20).toFixed(2)} s later`, why: `${t.kind} ${t.type} hits in ${t.ticks_to_impact} ticks, ${t.turn_steps} steps off the spout`, ...c.board, expect });
  } else if (c.kind === 'calm') {
    const soon = st.entities.filter((e) => HARM.has(e.kind) && e.ticks_to_impact != null && e.ticks_to_impact <= 25);
    if (soon.length) { skipped.notCalm++; continue; }
    out.push({ id, source: `${c.file} @${c.t}s, ${c.name}`, why: 'nothing harmful within 25 ticks', ...c.board, expect: { shield: false } });
  } else {
    const r = st.entities.find((e) => e.kind === 'rival' && e.in_fire_range && Math.abs(e.turn_steps) <= 1);
    if (!r) { skipped.noRival++; continue; }
    out.push({ id, source: `${c.file} @${c.t}s, ${c.name} hit a rival 0.4 s later`, why: `rival ${r.turn_steps} steps off the spout, gap ${r.gap}`, ...c.board, expect: { fire: true } });
  }
}
await browser.close();
// a mix: deaths, calm moments and hits, up to --max
const by = (k) => out.filter((p) => p.id.startsWith(args.prefix + k));
const kept = [...by('death').slice(0, Math.ceil(args.max * 0.55)), ...by('calm').slice(0, Math.ceil(args.max * 0.4)), ...by('hit')].slice(0, args.max);
const outFile = path.join(here, args.out);
const before = args.append && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')).filter((p) => !p.id.startsWith(args.prefix || '\u0000')) : [];
fs.writeFileSync(outFile, JSON.stringify([...before, ...kept], null, 1));
console.log(`${candidates.length} moments from ${files.length} recordings; kept ${kept.length} (death: ${by('death').length > 0 ? kept.filter((p) => p.id.startsWith(args.prefix + 'death')).length : 0}, calm: ${kept.filter((p) => p.id.startsWith(args.prefix + 'calm')).length}, hit: ${kept.filter((p) => p.id.startsWith(args.prefix + 'hit')).length}); skipped ${JSON.stringify(skipped)}`);
for (const p of kept) console.log(`  ${p.id}: ${p.why} -> ${JSON.stringify(p.expect)}`);
