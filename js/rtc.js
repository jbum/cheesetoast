// Matchmaking client (server/match_server.py at /mm/) and a WebRTC transport
// for net.js sessions.  Game traffic goes browser to browser over two data
// channels: "u" (unordered, no retransmits) for snapshots and inputs, "r"
// (reliable) for everything else.  The matchmaker only relays connection setup.

// STUN finds each browser's public address; when two networks still can't
// reach each other (strict NATs, some cellular and school networks), the TURN
// relay on the server carries the traffic.  The matchmaker hands out the relay's
// short-lived credentials (/mm/ice); these are the fallback without them.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
// ?relay forces every connection through the relay (testing); ?relay=tls
// through its TLS address only (as for a network that blocks UDP)
const RELAY = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('relay') : null;
const FORCE_RELAY = RELAY !== null;
// ?netsim=RTT[,JITTER[,LOSS]] (testing): this page's connections behave like a
// worse network, RTT ms more round trip (half each way), up to JITTER ms more
// each way at random, and LOSS (0-1) of the lossy messages lost each way.  The
// reliable channel keeps its order, as SCTP would.
const NETSIM = (() => {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('netsim') : null;
  if (!q) return null;
  const [rtt = 0, jitter = 0, loss = 0] = q.split(',').map(Number);
  return { oneWay: rtt / 2, jitter, loss };
})();
const relayOnlyTls = (servers) => servers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => u.startsWith('turns:')) })).filter((s) => s.urls.length);

export class Matchmaker {
  constructor(base = 'mm/') {
    this.base = base;
    this.id = null;
    this.handler = null;
    this.early = [];   // events that came before anyone listened (a host's offer can beat the page's setup)
    this.es = null;
  }

  // who handles our events; any that arrived before it was set are handed over
  get onevent() { return this.handler; }
  set onevent(fn) {
    this.handler = fn;
    if (fn) for (const e of this.early.splice(0)) fn(e);
  }

  async post(path, body) {
    // (a call that hangs would leave the game unable to start: give it 5 s)
    const res = await fetch(this.base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    if (!res.ok) throw new Error(`matchmaker ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async status() {
    try { return await (await fetch(this.base + 'status', { cache: 'no-store' })).json(); } catch (e) { return null; }
  }

  // -> { id, role: 'host' } or { id, role: 'guest', host, hostName }
  async play(name, mode, extra = {}) {
    this.close();
    const r = await this.post('play', { name, mode, ...extra });
    if (r.role === 'none') return r;   // joinOnly and nobody waiting
    this.id = r.id;
    this.me = { name, mode, bot: !!extra.bot };
    this.queued = r.role === 'host';
    this.players = 1;
    this.listen();
    this.pingTimer = setInterval(() => this.ping(), 10000);
    await this.fetchIce();
    return r;
  }

  // the ICE servers for our connections (with the relay's credentials)
  async fetchIce() {
    try {
      const r = await (await fetch(this.base + 'ice?id=' + encodeURIComponent(this.id), { cache: 'no-store' })).json();
      if (Array.isArray(r.iceServers)) this.ice = r.iceServers;
    } catch (e) { /* STUN only */ }
  }

  listen() {
    if (this.es) this.es.close();
    this.es = new EventSource(this.base + 'events?id=' + encodeURIComponent(this.id));
    this.es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (this.handler) this.handler(m); else this.early.push(m);
    };
  }

  // The matchmaker keeps everything in memory: after it restarts it doesn't
  // know us (ping says ok: false), so register again under the same id, back
  // in the queue if we were waiting there, and reopen the event stream.
  async ping() {
    if (!this.id) return;
    try {
      const r = await this.post('ping', { id: this.id });
      if (r.ok === false) {
        await this.post('rejoin', { id: this.id, ...this.me, players: this.players, level: this.level || 0, queued: this.queued });
        if (this.lastGame) await this.post('game', { id: this.id, ...this.lastGame });   // back on the games list
        this.listen();
      }
    } catch (e) { /* offline for a moment: try again next time */ }
  }

  // describe the universe we host, for the games list (games/index.html):
  // { hosting, players: [[name, bot]], max, level, noBots }.  Unchanged
  // descriptions aren't sent again.
  game(info) {
    const body = JSON.stringify(info);
    if (!this.id || body === this.lastGameBody) return;
    this.lastGame = info; this.lastGameBody = body;
    return this.post('game', { id: this.id, ...info }).catch(() => {});
  }

  // join one particular player's universe (regrouping after a lost host),
  // keeping our id; null if that player isn't there
  async join(host) {
    const r = await this.post('join', { id: this.id, host });
    if (!r || r.role !== 'guest') return null;
    this.queued = false;
    return r;
  }

  signal(to, data) { return this.post('signal', { id: this.id, to, data }).catch(() => {}); }
  // open to joiners: players = how many are in our universe, level = its level
  solo(players = 1, level = 0) {
    this.queued = true; this.players = players; this.level = level;
    return this.id && this.post('solo', { id: this.id, players, level }).catch(() => {});
  }
  busy() { this.queued = false; return this.id && this.post('busy', { id: this.id }).catch(() => {}); }

  leave() {
    const id = this.id;
    this.close();
    if (!id) return;
    const body = JSON.stringify({ id });
    // sendBeacon survives the page closing
    if (navigator.sendBeacon) navigator.sendBeacon(this.base + 'leave', new Blob([body], { type: 'application/json' }));
    else fetch(this.base + 'leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.es) this.es.close();
    this.es = null;
    this.id = null;
  }
}

export class RTCTransport {
  constructor(mm) {
    this.mm = mm;
    this.selfId = mm.id;
    this.peers = new Map();     // peer id -> { pc, u, r, open }
    this.onmessage = null;
    this.onpeer = null;         // (peerId, 'open' | 'closed')
    this.onlog = null;          // diagnostics
    this.bytesIn = 0;           // traffic, for the lag stats (net.js)
    this.bytesOut = 0;
    this.skipped = 0;           // lossy messages not sent to a peer that was still sending the last one
    this.netsim = NETSIM;
  }

  // ?netsim: when a message sent or received now should go through.  Lossy
  // ones (null: lost) may overtake each other; reliable ones keep their order.
  simDelay(p, key, lossy) {
    const ns = this.netsim;
    if (lossy && ns.loss && Math.random() < ns.loss) return null;
    const at = performance.now() + ns.oneWay + Math.random() * ns.jitter;
    if (lossy) return at;
    p[key] = Math.max(p[key] || 0, at);
    return p[key];
  }
  log(m) { this.onlog && this.onlog(m); }

  peer(id) {
    let p = this.peers.get(id);
    if (p) return p;
    const servers = this.mm.ice || ICE_SERVERS;
    const pc = new RTCPeerConnection({ iceServers: RELAY === 'tls' ? relayOnlyTls(servers) : servers, ...(FORCE_RELAY ? { iceTransportPolicy: 'relay' } : {}) });
    p = { pc, u: null, r: null, open: false, pendingIce: [] };
    this.peers.set(id, p);
    pc.onicecandidate = (e) => {
      if (e.candidate && e.candidate.candidate) { this.log(`ice out: ${e.candidate.type || '?'} ${e.candidate.protocol || ''} ${(e.candidate.address || '').slice(0, 24)}`); this.mm.signal(id, { ice: e.candidate.toJSON() }); }
    };
    pc.oniceconnectionstatechange = () => this.log(`ice state: ${pc.iceConnectionState}`);
    pc.ondatachannel = (e) => this.attach(id, e.channel);
    pc.onconnectionstatechange = () => {
      this.log(`connection: ${pc.connectionState}`);
      if (['failed', 'closed'].includes(pc.connectionState)) this.dropPeer(id);
    };
    return p;
  }

  attach(id, ch) {
    const p = this.peers.get(id);
    if (!p) return;
    p[ch.label] = ch;
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => {
      this.bytesIn += e.data.length || e.data.byteLength || 0;
      let m;
      // (bytes are a snapshot, wire.js; everything else is JSON)
      if (typeof e.data !== 'string') m = { k: 'snapb', bin: e.data };
      else try { m = JSON.parse(e.data); } catch (err) { return; }
      m.from = id;
      if (this.netsim) {
        const at = this.simDelay(p, 'simIn' + ch.label, ch.label === 'u');
        if (at === null) return;
        setTimeout(() => this.onmessage && this.onmessage(m), at - performance.now());
        return;
      }
      this.onmessage && this.onmessage(m);
    };
    ch.onopen = () => {
      if (p.u && p.r && p.u.readyState === 'open' && p.r.readyState === 'open' && !p.open) {
        p.open = true;
        this.onpeer && this.onpeer(id, 'open');
        this.noteRoute(id, p);
      }
    };
    if (ch.readyState === 'open') ch.onopen();
  }

  // how this connection travels (direct, via STUN, or relayed), for the
  // diagnostics: "route abc123: relay udp"
  async noteRoute(id, p) {
    try {
      const stats = await p.pc.getStats();
      let pair = null;
      stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
      p.route = local ? `${local.candidateType}/${remote ? remote.candidateType : '?'} ${local.protocol || ''}${local.relayProtocol ? ' via ' + local.relayProtocol : ''}` : '?';
      this.log(`route ${String(id).slice(0, 6)}: ${p.route}`);
    } catch (e) { /* no stats */ }
  }

  // host: start a connection to a guest the matchmaker sent our way
  async connectTo(id) {
    const p = this.peer(id);
    this.attach(id, p.pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
    this.attach(id, p.pc.createDataChannel('r', { ordered: true }));
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    this.mm.signal(id, { sdp: p.pc.localDescription.toJSON() });
  }

  // relayed connection setup from the other browser
  async handleSignal(from, data) {
    this.log(`signal in: ${data.sdp ? data.sdp.type : data.ice ? 'ice' : '?'}`);
    const p = this.peer(from);
    if (data.sdp) {
      await p.pc.setRemoteDescription(data.sdp);
      for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        this.mm.signal(from, { sdp: p.pc.localDescription.toJSON() });
      }
    } else if (data.ice) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.ice).catch(() => {});
      else p.pendingIce.push(data.ice);
    }
  }

  // to: one peer id, a list of them, or (none) everyone; bin: send these
  // bytes (an ArrayBuffer) instead of the object as JSON
  send(obj) {
    const ids = obj.to ? [].concat(obj.to) : [...this.peers.keys()];
    const msg = obj.bin || JSON.stringify(obj);
    const size = obj.bin ? obj.bin.byteLength : msg.length;
    for (const id of ids) {
      const p = this.peers.get(id);
      const ch = p && (obj.lossy ? p.u : p.r);
      if (!ch || ch.readyState !== 'open') continue;
      // a lossy message (a snapshot) to a peer whose link hasn't yet taken the
      // last one: skip it, the next supersedes it anyway (queueing them would
      // only make that player's picture later and later)
      if (obj.lossy && ch.bufferedAmount > size) { this.skipped++; p.skipped = (p.skipped || 0) + 1; continue; }
      this.bytesOut += size;
      if (this.netsim) {
        const at = this.simDelay(p, 'simOut' + ch.label, !!obj.lossy);
        if (at !== null) {
          p.simPending = (p.simPending || 0) + 1;
          setTimeout(() => { p.simPending--; try { if (ch.readyState === 'open') ch.send(msg); } catch (e) { /* closing */ } }, at - performance.now());
        }
        continue;
      }
      try { ch.send(msg); } catch (e) { /* closing */ }
    }
  }

  dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch (e) { /* closed */ }
    this.onpeer && this.onpeer(id, 'closed');
  }

  close() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
  }

  // close once everything queued has been sent (e.g. a handoff), within ms
  closeWhenFlushed(ms = 4000) {
    const t0 = performance.now();
    const check = () => {
      const pending = [...this.peers.values()].some((p) => p.r && p.r.readyState === 'open' && (p.r.bufferedAmount > 0 || p.simPending > 0));
      if (!pending || performance.now() - t0 > ms) setTimeout(() => this.close(), 300);
      else setTimeout(check, 50);
    };
    check();
  }
}
