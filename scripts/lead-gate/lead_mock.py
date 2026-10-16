#!/usr/bin/env python3
"""Local stand-in for the bopaero-leads Worker (copied from bopaero-embeds/tools/testbed).

    python3 scripts/lead-gate/lead_mock.py [port] [root]

Serves `root` (default: the repo) statically and answers POST /mock/lead the way the
Worker does: {"ok": true} - or a 502 when the name is "fail", so the error path can
be seen. Every lead received is appended to /mock/leads (GET) for the check script.
"""
import http.server, json, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root
LEADS = []

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a):
        pass
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        if self.path == '/mock/leads':
            return self._json(200, LEADS)
        return super().do_GET()
    def do_POST(self):
        if self.path != '/mock/lead':
            return self._json(404, {'error': 'not found'})
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        LEADS.append(body)
        if body.get('name') == 'fail':
            return self._json(502, {'error': 'unavailable'})
        return self._json(200, {'ok': True})

http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
