#!/usr/bin/python3
"""Local dev server with caching turned off (so an iPad always gets fresh files).

    /usr/bin/python3 tools/serve.py [port]    then open http://<this-mac>.local:8080/

Use /usr/bin/python3: the macOS firewall allows it incoming connections, but
blocks the Homebrew Pythons, so other devices on the LAN would get no answer.

To try the shared Hall of Cheese locally, run server/scores_server.py and set
CT_API to it; /api/ and /mod/ are then passed through (no password locally):

    CT_API=http://127.0.0.1:3002 /usr/bin/python3 tools/serve.py
"""
import http.server, os, socket, sys, urllib.request, urllib.error

API = os.environ.get('CT_API')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def proxied(self):
        return API and (self.path.startswith('/api/') or self.path.startswith('/mod'))

    def proxy(self, method):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() in ('content-type', 'x-ct-mod')}
        headers['X-Forwarded-For'] = self.client_address[0]
        req = urllib.request.Request(API + self.path, data=body, method=method, headers=headers)
        try:
            res = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as e:
            res = e
        data = res.read()
        self.send_response(res.status)
        self.send_header('Content-Type', res.headers.get('Content-Type', 'application/json'))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        return self.proxy('GET') if self.proxied() else super().do_GET()

    def do_POST(self):
        return self.proxy('POST') if self.proxied() else self.send_error(405)

    def do_DELETE(self):
        return self.proxy('DELETE') if self.proxied() else self.send_error(405)


host = socket.gethostname()
print(f'Serving on http://{host}:{PORT}/  (and http://localhost:{PORT}/)' + (f', API -> {API}' if API else ''))
http.server.ThreadingHTTPServer(('0.0.0.0', PORT), NoCacheHandler).serve_forever()
