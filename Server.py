"""Tiny local web server for Open Road. Sends no-cache headers so the browser always loads the newest files."""
import http.server
import os
import sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("", port), Handler) as server:
        print("Open Road is running at http://localhost:%d  (Ctrl+C to stop)" % port)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
