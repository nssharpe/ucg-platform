"""Tiny CORS-enabled static server so the Supabase dashboard page can fetch
the generated SQL locally (keeps the 443KB payload out of the model context)."""
import http.server, socketserver, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
    def log_message(self, *a): pass

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

with Server(('127.0.0.1', 8732), H) as httpd:
    print('serving on http://127.0.0.1:8732')
    httpd.serve_forever()
