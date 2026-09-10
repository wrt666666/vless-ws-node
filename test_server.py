import http.server
import socketserver
import sys

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'OK-from-local-test-server\n'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        self.do_GET()
    def log_message(self, *a):
        pass

# 简单 HTTP 服务器, 端口 9999
class ReuseTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

with ReuseTCPServer(('127.0.0.1', 9999), H) as s:
    print('test HTTP server on 127.0.0.1:9999', flush=True)
    s.serve_forever()
