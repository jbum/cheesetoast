#!/usr/bin/env python3
"""Cheese Toast multiplayer matchmaking and WebRTC signaling (see MULTIPLAYER.md).

Standard library only.  Runs on the loopback interface behind Apache, which
proxies /mm/ here (with flushpackets on, for the event stream).

The server never sees game traffic: it keeps two queues of solo players who
are open to company (one per mode: "coop", "duel", "melee"), pairs a newcomer with
the oldest of them, and relays the WebRTC offer/answer/ICE messages until the
two browsers connect directly.

    python3 match_server.py [--host 127.0.0.1] [--port 3004]

Endpoints (JSON in, JSON out, except the event stream):
    POST /mm/play   {name, mode, bot, joinOnly, avoid, hostOnly, host, max}
                                         -> {id, role: "host"}  (you're queued; play solo)
                                         or {id, role: "guest", host, hostName}
                                         or {role: "none"}  (joinOnly, and no person waiting)
                                         bots (bot: true) never count as waiting; with
                                         joinOnly they only join people (bots/filler.mjs);
                                         avoid: host ids not to pair with (they couldn't be
                                         reached); hostOnly: just queue me; host: join that
                                         one if it's open (the games list's Join), else as usual
                                         ("wanted": false in the answer); max: only games of
                                         at most that many players (2-4)
    GET  /mm/events?id=ID                Server-Sent Events for this player:
                                           {k: "joining", guest, name}   (host: someone is coming)
                                           {k: "signal", from, data}     (WebRTC setup)
    POST /mm/join   {id, host}           join that player's universe, keeping my id (guests
                                         regrouping after their host vanished)
                                         -> {id, role: "guest", host, hostName} or {role: "none"}
    POST /mm/signal {id, to, data}       relay a WebRTC message to another player
    POST /mm/solo   {id, players, level} in your mode's queue (your partner left, or there's
                                         room for more; players = how many are in your universe,
                                         level = its level: newcomers go to the lowest level
                                         waiting, oldest first; at CLOSED_LEVEL nobody is sent)
    POST /mm/busy   {id}                 out of the queue (you have a partner)
    POST /mm/leave  {id}                 gone (back to attract, or closing)
    POST /mm/ping   {id}                 keep-alive (every ~10 s); {ok: false} = unknown id
    POST /mm/rejoin {id, name, mode, bot, players, queued}
                                         re-register an id this server forgot (it restarted)
    POST /mm/game   {id, hosting, players: [[name, bot], ...], max, level, noBots}
                                         a host describes its universe (the games list); hosting
                                         false takes it off the list (it handed the universe on).
                                         noBots: no bot is sent to it, or offered to the filler
    GET  /mm/games                       every universe being hosted: [{id, mode, players, max,
                                         level, noBots, open, why, age}] (games/index.html)
    POST /mm/diag   {id, ...}            a game's diagnostics, written to the log (debugging)
    GET  /mm/ice?id=ID                   {iceServers: [...]} for RTCPeerConnection: STUN, plus
                                         the TURN relay (coturn on the server) with credentials good
                                         for ICE_TTL seconds (TURN REST: username "expiry:id",
                                         password = base64 HMAC-SHA1 of it with the shared
                                         secret in turn.secret), for registered ids only
    GET  /mm/status                      {"coop": n, "duel": n, "melee": n} people waiting,
                                         and "waiting": {mode: [seconds each has waited]}
"""
import argparse, base64, hashlib, hmac, json, os, queue, re, secrets, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

MODES = ('duel', 'coop', 'melee')
STALE = 30          # seconds without a ping or open event stream -> dropped
CLOSED_LEVEL = 2    # a universe at this level or above takes no newcomers (the client leaves the queue too)
MAX_PLAYERS = 4     # in one universe (the host's snapshots grow with players: lag)
STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
TURN_HOST = 'ct.krazydad.com'
ICE_TTL = 6 * 3600  # how long a TURN credential works (a long session of games)


def turn_secret():
    # shared with coturn (tools/install-turn.sh); none on a test machine: STUN only
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'turn.secret')) as f:
            return f.read().strip() or None
    except OSError:
        return os.environ.get('CT_TURN_SECRET') or None


def ice_servers(cid):
    servers = [{'urls': STUN}]
    secret = turn_secret()
    if secret:
        user = f'{int(time.time()) + ICE_TTL}:{cid}'
        cred = base64.b64encode(hmac.new(secret.encode(), user.encode(), hashlib.sha1).digest()).decode()
        servers.append({'urls': [f'turn:{TURN_HOST}:3478?transport=udp', f'turn:{TURN_HOST}:3478?transport=tcp',
                                 f'turns:{TURN_HOST}:5349?transport=tcp'],
                        'username': user, 'credential': cred})
    return servers
MAX_BODY = 64 * 1024


def log(msg):
    print(f'{datetime.now(timezone.utc).isoformat(timespec="seconds")} {msg}', flush=True)


class Client:
    def __init__(self, name, mode, bot=False):
        self.id = secrets.token_hex(6)
        self.name = name
        self.mode = mode
        self.bot = bot
        self.queued = time.time()   # when it last joined its queue
        self.players = 1            # in its universe (only lone players count as waiting)
        self.level = 0              # its universe's level (newcomers go to the lowest)
        self.hosting = False        # describes a universe it hosts (/mm/game)
        self.roster = []            # [[name, bot], ...] in that universe
        self.max = 4
        self.no_bots = False        # its players don't want bots
        self.since = time.time()    # when it started hosting
        self.inbox = queue.Queue()
        self.seen = time.time()
        self.streams = 0


class Matchmaker:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}
        self.queues = {m: [] for m in MODES}    # client ids, oldest first

    def _alive(self, cid):
        c = self.clients.get(cid)
        return c is not None and (c.streams > 0 or time.time() - c.seen < STALE)

    def _dequeue(self, cid):
        for q in self.queues.values():
            if cid in q:
                q.remove(cid)

    def _open(self, cid):
        c = self.clients.get(cid)
        return (c is not None and self._alive(cid) and cid in self.queues[c.mode] and c.level < CLOSED_LEVEL
                and (not c.hosting or len(c.roster) < c.max))

    def play(self, name, mode, bot=False, join_only=False, avoid=(), host_only=False, host=None, max_players=MAX_PLAYERS):
        with self.lock:
            q = self.queues[mode]
            q[:] = [cid for cid in q if self._alive(cid)]
            # a fill-in bot only joins a person, and never waits in the queue itself;
            # no bot goes where the players have said no bots
            # (and none bigger than the newcomer likes: max_players)
            ok = lambda cid: (cid not in avoid and not (join_only and self.clients[cid].bot)
                              and not (bot and self.clients[cid].no_bots) and self._open(cid)
                              and self.clients[cid].max <= max_players)
            wanted = None
            if host and not host_only:
                wanted = host in q and ok(host)
            # the universe asked for (the games list), else the lowest-level one
            # waiting, the oldest among equals
            cands = [] if host_only else [cid for cid in q if ok(cid)]
            pick = host if wanted else (min(cands, key=lambda cid: self.clients[cid].level) if cands else None)
            if join_only and pick is None:
                return {'role': 'none'}
            c = Client(name, mode, bot)
            self.clients[c.id] = c
            if pick is not None:
                q.remove(pick)
                h = self.clients[pick]
                h.inbox.put({'k': 'joining', 'guest': c.id, 'name': name})
                log(f'{mode}: {name or c.id} joins {h.name or pick}' + (' (asked for it)' if wanted else ''))
                r = {'id': c.id, 'role': 'guest', 'host': pick, 'hostName': h.name}
            else:
                q.append(c.id)
                log(f'{mode}: {name or c.id} plays solo, queued ({len(q)} waiting)')
                r = {'id': c.id, 'role': 'host'}
            if wanted is not None:
                r['wanted'] = wanted
            return r

    def join(self, cid, host):
        with self.lock:
            c = self.clients.get(cid)
            h = self.clients.get(host)
            if not c or not h or not self._alive(host):
                return {'role': 'none'}
            self._dequeue(cid)
            c.seen = time.time()
            h.inbox.put({'k': 'joining', 'guest': cid, 'name': c.name})
            log(f'{c.mode}: {c.name or cid} regroups with {h.name or host}')
            return {'id': cid, 'role': 'guest', 'host': host, 'hostName': h.name}

    def signal(self, cid, to, data):
        with self.lock:
            target = self.clients.get(to)
            if not target or cid not in self.clients:
                return False
            self.clients[cid].seen = time.time()
            target.inbox.put({'k': 'signal', 'from': cid, 'data': data})
            return True

    def solo(self, cid, players=1, level=0):
        with self.lock:
            c = self.clients.get(cid)
            if not c:
                return False
            q = self.queues[c.mode]
            if cid not in q:
                q.append(cid)   # (already queued: keep the place, just update)
            if players <= 1 and c.players > 1:
                c.queued = time.time()   # alone again: the wait starts over
            c.players = players
            c.level = level
            c.seen = time.time()
            log(f'{c.mode}: {c.name or cid} ({cid[:6]}) is open to joiners ({players} in, level {level}; {len(q)} waiting)')
            return True

    def busy(self, cid):
        with self.lock:
            self._dequeue(cid)
            if cid in self.clients:
                self.clients[cid].seen = time.time()
            return True

    def leave(self, cid):
        with self.lock:
            self._dequeue(cid)
            c = self.clients.pop(cid, None)
            if c:
                c.inbox.put(None)   # ends its event stream
            return True

    def rejoin(self, cid, name, mode, bot, players, queued, level=0):
        with self.lock:
            if cid in self.clients:
                self.clients[cid].seen = time.time()
                return True
            c = Client(name, mode, bot)
            c.id = cid
            c.players = players
            c.level = level
            self.clients[cid] = c
            if queued:
                self.queues[mode].append(cid)
            log(f'{mode}: {name or cid} rejoined after a restart' + (' (queued)' if queued else ''))
            return True

    def game(self, cid, hosting, roster, max_players, level, no_bots):
        with self.lock:
            c = self.clients.get(cid)
            if not c:
                return False
            if hosting and not c.hosting:
                c.since = time.time()
            c.hosting, c.roster, c.max, c.level, c.no_bots = hosting, roster, max_players, level, no_bots
            c.seen = time.time()
            return True

    def games(self):
        with self.lock:
            t = time.time()
            out = []
            for cid, c in self.clients.items():
                if not c.hosting or not self._alive(cid):
                    continue
                open_ = self._open(cid)
                why = ('' if open_ else 'full' if len(c.roster) >= c.max else f'level {c.level}' if c.level >= CLOSED_LEVEL
                       else 'not taking players right now')
                out.append({'id': cid, 'mode': c.mode, 'players': [{'name': n, 'bot': bool(b)} for n, b in c.roster],
                            'max': c.max, 'level': c.level, 'noBots': c.no_bots, 'open': open_, 'why': why,
                            'age': round(t - c.since)})
            return out

    def ping(self, cid):
        with self.lock:
            c = self.clients.get(cid)
            if c:
                c.seen = time.time()
            return c is not None

    def status(self):
        with self.lock:
            t = time.time()
            # (a universe whose players said no bots doesn't count: the filler sends bots)
            people = {m: [self.clients[cid] for cid in q
                          if self._alive(cid) and not self.clients[cid].bot and self.clients[cid].players <= 1
                          and not self.clients[cid].no_bots]
                      for m, q in self.queues.items()}
            out = {m: len(cs) for m, cs in people.items()}
            out['waiting'] = {m: [round(t - c.queued) for c in cs] for m, cs in people.items()}
            return out

    def sweep(self):
        while True:
            time.sleep(10)
            with self.lock:
                for cid in list(self.clients):
                    if not self._alive(cid):
                        self._dequeue(cid)
                        self.clients.pop(cid, None)


class Handler(BaseHTTPRequestHandler):
    mm: Matchmaker = None
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return {}
        try:
            obj = json.loads(self.rfile.read(n))
            return obj if isinstance(obj, dict) else {}
        except ValueError:
            return {}

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/mm/status':
            return self.send_json(200, self.mm.status())
        if url.path == '/mm/ice':
            cid = (parse_qs(url.query).get('id') or [''])[0]
            if cid not in self.mm.clients:   # (registered players only: no free relay)
                return self.send_json(404, {'error': 'unknown id'})
            return self.send_json(200, {'iceServers': ice_servers(cid)})
        if url.path == '/mm/games':
            return self.send_json(200, {'games': self.mm.games(), 'closedLevel': CLOSED_LEVEL})
        if url.path == '/mm/events':
            cid = (parse_qs(url.query).get('id') or [''])[0]
            return self.events(cid)
        return self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        path = urlparse(self.path).path
        b = self.body()
        cid = str(b.get('id', ''))
        if path == '/mm/play':
            mode = b.get('mode') if b.get('mode') in MODES else 'coop'
            name = str(b.get('name') or '')[:32]
            avoid = [x for x in (b.get('avoid') or []) if isinstance(x, str)][:8] if isinstance(b.get('avoid'), list) else []
            host = b.get('host') if isinstance(b.get('host'), str) else None
            try:
                want_max = max(2, min(MAX_PLAYERS, int(b.get('max') or MAX_PLAYERS)))
            except (TypeError, ValueError):
                want_max = MAX_PLAYERS
            return self.send_json(200, self.mm.play(name, mode, bool(b.get('bot')), bool(b.get('joinOnly')), avoid,
                                                    bool(b.get('hostOnly')), host, want_max))
        if path == '/mm/game':
            roster = []
            for p in (b.get('players') or [])[:8] if isinstance(b.get('players'), list) else []:
                if isinstance(p, list) and p:
                    roster.append([str(p[0] or '')[:32], bool(p[1]) if len(p) > 1 else False])
            try:
                max_players = max(1, min(MAX_PLAYERS, int(b.get('max') or MAX_PLAYERS)))
            except (TypeError, ValueError):
                max_players = 4
            ok = self.mm.game(cid, bool(b.get('hosting')), roster, max_players, self.level(b), bool(b.get('noBots')))
            return self.send_json(200 if ok else 404, {'ok': ok})
        if path == '/mm/join':
            return self.send_json(200, self.mm.join(cid, str(b.get('host', ''))))
        if path == '/mm/signal':
            ok = self.mm.signal(cid, str(b.get('to', '')), b.get('data'))
            return self.send_json(200 if ok else 404, {'ok': ok})
        if path == '/mm/diag':
            line = json.dumps(b, ensure_ascii=False)[:6000]
            log(f'diag {line}')
            return self.send_json(200, {'ok': True})
        if path == '/mm/rejoin':
            if not re.fullmatch(r'[0-9a-f]{12}', cid):
                return self.send_json(400, {'ok': False})
            mode = b.get('mode') if b.get('mode') in MODES else 'coop'
            try:
                players = max(1, int(b.get('players') or 1))
            except (TypeError, ValueError):
                players = 1
            ok = self.mm.rejoin(cid, str(b.get('name') or '')[:32], mode, bool(b.get('bot')), players, bool(b.get('queued')), self.level(b))
            return self.send_json(200, {'ok': ok})
        if path == '/mm/solo':
            try:
                players = max(1, int(b.get('players') or 1))
            except (TypeError, ValueError):
                players = 1
            return self.send_json(200, {'ok': self.mm.solo(cid, players, self.level(b))})
        fn = {'/mm/busy': self.mm.busy, '/mm/leave': self.mm.leave, '/mm/ping': self.mm.ping}.get(path)
        if fn:
            return self.send_json(200, {'ok': fn(cid)})
        return self.send_json(404, {'error': 'not found'})

    @staticmethod
    def level(b):
        try:
            return max(0, min(10_000, int(b.get('level') or 0)))
        except (TypeError, ValueError):
            return 0

    def events(self, cid):
        c = self.mm.clients.get(cid)
        if not c:
            return self.send_json(404, {'error': 'unknown id'})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()
        c.streams += 1
        try:
            self.wfile.write(b': hello\n\n')
            self.wfile.flush()
            while True:
                try:
                    msg = c.inbox.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b': keep-alive\n\n')   # keeps proxies from timing out
                    self.wfile.flush()
                    continue
                if msg is None:
                    break
                self.wfile.write(b'data: ' + json.dumps(msg).encode() + b'\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            c.streams -= 1
            c.seen = time.time()
        self.close_connection = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=3004)
    a = ap.parse_args()
    Handler.mm = Matchmaker()
    threading.Thread(target=Handler.mm.sweep, daemon=True).start()
    log(f'matchmaker listening on {a.host}:{a.port}')
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
