// A private copy of the site for flow checks: the game served straight from
// the repo plus its own matchmaker (server/match_server.py on a spare port),
// so scenarios never touch the live queue or meet real players.  Bots on one
// machine still connect to each other over WebRTC, as they do on the live site.
//
//   const site = await startLocalSite();   // { url, log, close() }
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };

export async function startLocalSite({ port = 8104, mmPort = 3104 } = {}) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const log = [];
  const mm = spawn('/usr/bin/python3', [path.join(root, 'server/match_server.py'), '--port', String(mmPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [mm.stdout, mm.stderr]) s.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) log.push(l); });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/mm/')) {
      // relay to the matchmaker, streaming (the event stream stays open)
      const p = http.request({ host: '127.0.0.1', port: mmPort, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1' } },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      p.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(p);
      return;
    }
    if (u.pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no api here'); }
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';   // (games/)
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${mmPort}/mm/status`); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    log,
    close() { mm.kill(); server.close(); },
  };
}
