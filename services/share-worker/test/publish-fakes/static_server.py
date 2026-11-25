"""A static file server with HEAD and single Range (stands in for the Hong Kong
bucket's public URL and GitHub's asset CDN). python3 static_server.py <dir> <port>"""
import http.server
import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _file(self):
        path = os.path.normpath(os.path.join(ROOT, self.path.split("?")[0].lstrip("/")))
        return path if path.startswith(ROOT + os.sep) and os.path.isfile(path) else None

    def do_HEAD(self):
        self._serve(body=False)

    def do_GET(self):
        self._serve(body=True)

    def _serve(self, body):
        path = self._file()
        if not path:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = open(path, "rb").read()
        m = re.match(r"^bytes=(\d+)-(\d*)$", self.headers.get("Range", ""))
        if m:
            start = int(m.group(1))
            end = min(int(m.group(2)) if m.group(2) else len(data) - 1, len(data) - 1)
            chunk = data[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        else:
            chunk = data
            self.send_response(200)
        self.send_header("Content-Length", str(len(chunk)))
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if body:
            self.wfile.write(chunk)


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), Handler).serve_forever()
