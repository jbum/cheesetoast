#!/usr/bin/env python3
"""Shared Hall of Cheese: a tiny score server for Cheese Toast.

Standard library only (http.server + sqlite3).  Runs on the loopback
interface behind Apache, which proxies /api/ and /mod/ here and puts
HTTP basic auth in front of /mod/ and /api/mod/.

    python3 scores_server.py --db /path/scores.db [--host 127.0.0.1] [--port 3002]

Environment: TYPESAFE_API_KEY (Jev checks that new names are PG-13).

Public API (each game mode has its own board: single, coop, duel, melee)
    GET  /api/scores?mode=single  top 10 visible scores for that mode
    POST /api/scores            {name, score, level, seconds, mode} -> rank + top 10
    POST /api/name-check        {name} -> {ok, message}  (the PG-13 name check)
Moderator API (auth is Apache's job; also requires the X-CT-Mod header so a
cross-site form can't ride on the moderator's cached credentials)
    GET    /api/mod/scores      every entry, newest first
    POST   /api/mod/scores/<id> {name?, score?, level?, status?, mode?}  (mode moves it to another board)
    DELETE /api/mod/scores/<id>
    GET    /api/mod/names       remembered name verdicts
    POST   /api/mod/names       {name, verdict: "ok" | "rejected"}
    DELETE /api/mod/names?name= forget a verdict (the next use asks Jev again)
    GET    /mod/                the moderator page
"""
import argparse, json, os, re, sqlite3, threading, time, urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

TOP_N = 10
MODES = ('single', 'coop', 'duel', 'melee')
MAX_NAME = 32
MAX_BODY = 4096
POSTS_PER_HOUR = 30          # per IP address
JEV_URL = 'https://api.typesafe.ai/v1/systemone'
JEV_THRESHOLD = 0.5          # P(acceptable) below this rejects the name
HERE = os.path.dirname(os.path.abspath(__file__))

SCHEMA = """
CREATE TABLE IF NOT EXISTS scores (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  score    INTEGER NOT NULL,
  level    INTEGER NOT NULL DEFAULT 0,
  seconds  REAL,
  created  TEXT    NOT NULL,
  ip       TEXT,
  status   TEXT    NOT NULL DEFAULT 'ok'   -- ok | pending | hidden
);
CREATE INDEX IF NOT EXISTS scores_rank ON scores(status, score DESC, id);
CREATE TABLE IF NOT EXISTS names (
  norm     TEXT PRIMARY KEY,               -- normalized name
  verdict  TEXT NOT NULL,                  -- ok | rejected
  p_ok     REAL,                           -- Jev's P(acceptable); NULL if set by hand
  source   TEXT NOT NULL,                  -- jev | moderator
  checked  TEXT NOT NULL
);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def norm_name(name):
    return re.sub(r'\s+', ' ', name.strip().lower())


class Store:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        # boards per game mode (older databases predate the column: their scores are single-player)
        cols = [r[1] for r in self.db.execute('PRAGMA table_info(scores)')]
        if 'mode' not in cols:
            self.db.execute("ALTER TABLE scores ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'")
        self.db.execute('CREATE INDEX IF NOT EXISTS scores_mode_rank ON scores(mode, status, score DESC, id)')
        self.db.commit()

    def q(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur

    def top(self, mode='single'):
        rows = self.q("SELECT id, name, score, level FROM scores WHERE status = 'ok' AND mode = ? "
                      "ORDER BY score DESC, id LIMIT ?", (mode, TOP_N)).fetchall()
        return [dict(r) for r in rows]

    def rank_of(self, row_id, score, mode='single'):
        r = self.q("SELECT COUNT(*) FROM scores WHERE status = 'ok' AND mode = ? AND "
                   "(score > ? OR (score = ? AND id < ?))", (mode, score, score, row_id)).fetchone()
        return r[0] + 1


# ---------------------------------------------------------------- name check

def ask_jev(name):
    """P(name is fine for a PG-13 leaderboard), or None if Jev can't be reached."""
    key = os.environ.get('TYPESAFE_API_KEY')
    if not key:
        return None
    body = {
        'model': 'jev-latest',
        'state': {'player_name': name},
        'questions': {
            'pg13': {
                'type': 'noul',
                'instructions': 'A player typed `player_name` to appear on the public high-score '
                                'list of a cute arcade game played by all ages. Is it acceptable '
                                'to show publicly under a PG-13 standard?',
                'criteria': {
                    'true': 'Acceptable: real names, nicknames, handles, initials, silly or '
                            'nonsense words, jokes, potty humor and cheeky taunts (fart, butt, '
                            '"bite me", "eat my shorts"), and mild words such as "heck" or "damn".',
                    'false': 'Not acceptable: strong profanity, sexual or explicit content, slurs, '
                             'hate figures or hate symbols, harassment, encouraging self-harm, '
                             'hard-drug references, or any of these disguised with misspellings, '
                             'spacing, symbols, leetspeak or abbreviations (such as "kys").',
                },
            },
        },
    }
    req = urllib.request.Request(JEV_URL, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            out = json.load(res)
        return float(out['answers']['pg13']['noul'])
    except Exception as e:  # network, quota, bad response: let a moderator decide
        log(f'jev error: {e!r}')
        return None


def ask_jev_chat(text):
    """P(chat message is fine under PG-13), or None if Jev can't be reached."""
    key = os.environ.get('TYPESAFE_API_KEY')
    if not key:
        return None
    body = {
        'model': 'jev-latest',
        'state': {'chat_message': text},
        'questions': {'pg13': {
            'type': 'noul',
            'instructions': 'A player typed `chat_message` in the chat of a cute arcade game played by all '
                            'ages; it appears in a speech balloon to the other players. Is it acceptable '
                            'under a PG-13 standard?',
            'criteria': {
                'true': 'Acceptable: greetings, game talk, friendly trash talk, jokes, mild words such as '
                        '"heck", "damn" or "sucks".',
                'false': 'Not acceptable: strong profanity, sexual content, slurs, hate, threats, '
                         'harassment, personal information (addresses, phone numbers), or any of these '
                         'disguised with misspellings, spacing, symbols or abbreviations.',
            },
        }},
    }
    req = urllib.request.Request(JEV_URL, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=6) as res:
            return float(json.load(res)['answers']['pg13']['noul'])
    except Exception as e:
        log(f'jev chat error: {e!r}')
        return None


def name_verdict(store, name):
    """'ok', 'rejected', or None (couldn't check)."""
    n = norm_name(name)
    row = store.q('SELECT verdict FROM names WHERE norm = ?', (n,)).fetchone()
    if row:
        return row['verdict']
    p = ask_jev(name)
    if p is None:
        return None
    verdict = 'ok' if p >= JEV_THRESHOLD else 'rejected'
    store.q('INSERT OR REPLACE INTO names (norm, verdict, p_ok, source, checked) '
            "VALUES (?, ?, ?, 'jev', ?)", (n, verdict, p, now()))
    log(f'jev: {name!r} p_ok={p:.3f} -> {verdict}')
    return verdict


# ---------------------------------------------------------------- helpers

def log(msg):
    print(f'{now()} {msg}', flush=True)


class RateLimit:
    def __init__(self, per_hour):
        self.per_hour = per_hour
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, ip):
        t = time.time()
        with self.lock:
            recent = [h for h in self.hits.get(ip, []) if t - h < 3600]
            if len(recent) >= self.per_hour:
                self.hits[ip] = recent
                return False
            recent.append(t)
            self.hits[ip] = recent
            if len(self.hits) > 10000:   # forget idle addresses
                self.hits = {k: v for k, v in self.hits.items() if v and t - v[-1] < 3600}
            return True


BOT_PREFIX = '\U0001F916 '   # robot face: fill-in bots (bots/filler.mjs) are "🤖 Grace" etc.


def clean_name(raw):
    if not isinstance(raw, str):
        return None
    bot = raw.strip().startswith(BOT_PREFIX.strip())
    name = re.sub(r'[^\x20-\x7e]', '', raw).strip()
    name = re.sub(r'\s+', ' ', name)[:MAX_NAME - (len(BOT_PREFIX) if bot else 0)]
    if bot and name:
        name = BOT_PREFIX + name
    return name or None


def plausible(score, level, seconds):
    """Loose sanity checks; anything stranger is left to the moderator."""
    if not (0 < score <= 100_000_000 and 0 <= level <= 10_000):
        return False
    if seconds is not None and score > 5000 + 3000 * seconds:
        return False
    return True


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = 'CheeseToastScores/1'
    store: Store = None
    limiter: RateLimit = None
    chat_limiter: RateLimit = None

    def log_message(self, fmt, *args):   # keep the log to our own lines
        pass

    def client_ip(self):
        fwd = self.headers.get('X-Forwarded-For')
        return fwd.split(',')[0].strip() if fwd else self.client_address[0]

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            obj = json.loads(self.rfile.read(n))
        except ValueError:
            return None
        return obj if isinstance(obj, dict) else None

    def is_mod_call(self):
        # Apache has already checked the password; this header can't be sent
        # by a plain cross-site form, so a forged request from elsewhere fails
        return self.headers.get('X-CT-Mod') == '1'

    def route(self, method):
        url = urlparse(self.path)
        path = url.path.rstrip('/') or '/'
        try:
            if path == '/api/scores' and method == 'GET':
                mode = (parse_qs(url.query).get('mode') or ['single'])[0]
                if mode not in MODES:
                    mode = 'single'
                return self.send_json(200, {'mode': mode, 'scores': self.store.top(mode)})
            if path == '/api/name-check' and method == 'POST':
                return self.name_check()
            if path == '/api/scores' and method == 'POST':
                return self.post_score()
            if path == '/api/chat-check' and method == 'POST':
                return self.chat_check()
            if path == '/mod' and method == 'GET':
                return self.send_file(os.path.join(HERE, 'mod.html'), 'text/html; charset=utf-8')
            if path.startswith('/api/mod/'):
                if not self.is_mod_call():
                    return self.send_json(403, {'error': 'forbidden'})
                return self.mod(method, path, parse_qs(url.query))
            return self.send_json(404, {'error': 'not found'})
        except Exception as e:
            log(f'error {method} {self.path}: {e!r}')
            return self.send_json(500, {'error': 'server error'})

    def do_GET(self): self.route('GET')
    def do_POST(self): self.route('POST')
    def do_DELETE(self): self.route('DELETE')

    def send_file(self, path, ctype):
        with open(path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- public

    def post_score(self):
        ip = self.client_ip()
        body = self.read_json()
        if body is None:
            return self.send_json(400, {'error': 'bad request'})
        name = clean_name(body.get('name'))
        mode = body.get('mode') if body.get('mode') in MODES else 'single'
        try:
            score = int(body.get('score'))
            level = int(body.get('level', 0))
            seconds = body.get('seconds')
            seconds = None if seconds is None else float(seconds)
        except (TypeError, ValueError):
            return self.send_json(400, {'error': 'bad request'})
        if not name:
            return self.send_json(422, {'error': 'name', 'message': 'Please engrave a name.'})
        if not plausible(score, level, seconds):
            log(f'implausible from {ip}: {name!r} {score} lvl {level} {seconds}s')
            return self.send_json(422, {'error': 'score', 'message': 'That score could not be recorded.'})
        if not self.limiter.allow(ip):
            return self.send_json(429, {'error': 'busy', 'message': 'Too many scores; try again later.'})

        verdict = name_verdict(self.store, name)
        if verdict == 'rejected':
            return self.send_json(422, {'error': 'name',
                                        'message': "That name can't go in the Hall of Cheese. Try another?"})
        status = 'ok' if verdict == 'ok' else 'pending'
        cur = self.store.q('INSERT INTO scores (name, score, level, seconds, created, ip, status, mode) '
                           'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                           (name, score, level, seconds, now(), ip, status, mode))
        row_id = cur.lastrowid
        log(f'score {row_id} ({mode}): {name!r} {score} lvl {level} {status} from {ip}')
        rank = self.store.rank_of(row_id, score, mode) if status == 'ok' else None
        return self.send_json(200, {'ok': True, 'id': row_id, 'status': status, 'rank': rank, 'mode': mode,
                                    'scores': self.store.top(mode)})

    def name_check(self):
        """The player-name screen: is this name OK (PG-13)?  {ok, message, checked}"""
        body = self.read_json() or {}
        name = clean_name(body.get('name'))
        if not name:
            return self.send_json(200, {'ok': False, 'message': 'Please type a name.'})
        if not self.chat_limiter.allow(self.client_ip()):
            return self.send_json(429, {'ok': False, 'message': 'Slow down a little.'})
        verdict = name_verdict(self.store, name)
        if verdict == 'rejected':
            return self.send_json(200, {'ok': False, 'message': "That name isn't allowed. Try another?", 'checked': True})
        return self.send_json(200, {'ok': True, 'name': name, 'checked': verdict is not None})

    def chat_check(self):
        """Multiplayer chat: is this message OK to show?  {ok, checked}"""
        ip = self.client_ip()
        body = self.read_json() or {}
        text = body.get('text')
        if not isinstance(text, str) or not text.strip():
            return self.send_json(400, {'error': 'bad request'})
        text = re.sub(r'[^\x20-\x7e]', '', text).strip()[:100]
        if not self.chat_limiter.allow(ip):
            return self.send_json(429, {'ok': False, 'message': 'Slow down a little.'})
        p = ask_jev_chat(text)
        if p is None:
            return self.send_json(200, {'ok': True, 'checked': False})   # the browser falls back to a word list
        if p < JEV_THRESHOLD:
            log(f'chat rejected from {ip}: {text!r} p_ok={p:.2f}')
        return self.send_json(200, {'ok': p >= JEV_THRESHOLD, 'checked': True})

    # ---- moderator

    def mod(self, method, path, query):
        st = self.store
        if path == '/api/mod/scores' and method == 'GET':
            rows = st.q('SELECT * FROM scores ORDER BY id DESC LIMIT 1000').fetchall()
            # each board's public top 10, by mode (ranks are per board)
            top = {m: [r['id'] for r in st.top(m)] for m in MODES}
            return self.send_json(200, {'scores': [dict(r) for r in rows], 'top': top, 'modes': list(MODES)})
        m = re.fullmatch(r'/api/mod/scores/(\d+)', path)
        if m:
            row_id = int(m.group(1))
            if method == 'DELETE':
                st.q('DELETE FROM scores WHERE id = ?', (row_id,))
                log(f'mod: deleted {row_id}')
                return self.send_json(200, {'ok': True})
            if method == 'POST':
                body = self.read_json() or {}
                sets, args = [], []
                if 'name' in body:
                    name = clean_name(body['name'])
                    if not name:
                        return self.send_json(400, {'error': 'bad name'})
                    sets.append('name = ?'); args.append(name)
                for key in ('score', 'level'):
                    if key in body:
                        sets.append(f'{key} = ?'); args.append(int(body[key]))
                if 'mode' in body:   # move it to another board
                    if body['mode'] not in MODES:
                        return self.send_json(400, {'error': 'bad board'})
                    sets.append('mode = ?'); args.append(body['mode'])
                if 'status' in body:
                    if body['status'] not in ('ok', 'pending', 'hidden'):
                        return self.send_json(400, {'error': 'bad status'})
                    sets.append('status = ?'); args.append(body['status'])
                if not sets:
                    return self.send_json(400, {'error': 'nothing to change'})
                st.q(f'UPDATE scores SET {", ".join(sets)} WHERE id = ?', (*args, row_id))
                log(f'mod: updated {row_id} {body}')
                return self.send_json(200, {'ok': True})
        if path == '/api/mod/names' and method == 'GET':
            rows = st.q('SELECT * FROM names ORDER BY checked DESC LIMIT 1000').fetchall()
            return self.send_json(200, {'names': [dict(r) for r in rows]})
        if path == '/api/mod/names' and method == 'POST':
            body = self.read_json() or {}
            name = clean_name(body.get('name'))
            if not name or body.get('verdict') not in ('ok', 'rejected'):
                return self.send_json(400, {'error': 'bad request'})
            st.q('INSERT OR REPLACE INTO names (norm, verdict, p_ok, source, checked) '
                 "VALUES (?, ?, NULL, 'moderator', ?)", (norm_name(name), body['verdict'], now()))
            log(f'mod: name {name!r} -> {body["verdict"]}')
            return self.send_json(200, {'ok': True})
        if path == '/api/mod/names' and method == 'DELETE':
            name = (query.get('name') or [''])[0]
            st.q('DELETE FROM names WHERE norm = ?', (norm_name(name),))
            return self.send_json(200, {'ok': True})
        return self.send_json(404, {'error': 'not found'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=3002)
    args = ap.parse_args()
    Handler.store = Store(args.db)
    Handler.limiter = RateLimit(POSTS_PER_HOUR)
    Handler.chat_limiter = RateLimit(600)   # chat checks per IP per hour
    log(f'listening on {args.host}:{args.port}, db {args.db}, '
        f'jev {"on" if os.environ.get("TYPESAFE_API_KEY") else "OFF (no key)"}')
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
