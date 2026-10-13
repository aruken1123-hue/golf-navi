# 確認用のローカルサーバー。ブラウザにファイルを保存させない（古い JS で確認してしまうのを防ぐ）
# 使い方: python tools/devserver.py [ポート]
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
