# パソコンでコースデータを直すためのローカルサーバー
#
# 使い方: このフォルダの1つ上（アプリのフォルダ）にある「pc-edit.bat」をダブルクリック
#         （または python tools/pcedit.py [ポート] [--no-browser]）。ブラウザで登録画面が開きます。
#
# - アプリのファイルをこのパソコンの中だけで配信する（127.0.0.1。ほかのパソコン・スマホからは見えない）
# - 登録画面の「PCのファイルに保存」で courses/<id>.json を直接書き換える。書き換える前の中身は
#   tools/pcedit-backups/ に控えを残す（公開しない）
# - 「スマホに公開」で、courses/ の変更だけを git でコミットして GitHub（main）に送る（数分でスマホに届く）
#
# 守り:
# - 受け付けるのは、このパソコンのブラウザでこのサーバーから開いた画面からの依頼だけ
#   （Host と Origin を確かめ、独自のヘッダーが無い依頼は断る。ほかのサイトから勝手に書き換えられないように）
# - 読み込んだあとに別の所でファイルが変わっていたら、上書きせずに知らせる（版 revision で確かめる）
# - 公開は main の枝で、まだ送っていないコミットが courses/ だけのときに限る（作りかけの画面のコードを出さない）
import sys, os, re, json, shutil, subprocess, datetime, webbrowser, threading, socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
COURSES = os.path.join(ROOT, 'courses')
BACKUPS = os.path.join(ROOT, 'tools', 'pcedit-backups')
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
PORT = int(ARGS[0]) if ARGS else 8770
OPEN_BROWSER = '--no-browser' not in sys.argv
ID_RE = re.compile(r'^[a-z0-9-]{1,64}$')
RESERVED_IDS = {'index'}  # courses/index.json（コース一覧）を上書きしない
MAX_BODY = 8 * 1024 * 1024
HEADER = 'X-Golfnavi-PC'
BRANCH = 'main'
lock = threading.Lock()


def course_path(cid):
    return os.path.join(COURSES, f'{cid}.json')


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_json_atomic(path, data, indent=1):
    # 一時ファイルは courses/ の外（公開されない所）に作る。同じドライブなので置き換えは一瞬で済む
    os.makedirs(BACKUPS, exist_ok=True)
    tmp = os.path.join(BACKUPS, os.path.basename(path) + '.tmp')
    try:
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=indent) + '\n')
        os.replace(tmp, path)  # 途中で止まっても、壊れたファイルを残さない
    finally:
        if os.path.exists(tmp): os.remove(tmp)


def check_course(c, cid):
    """最低限の形を確かめる（細かい検査は画面側の validateCourse が済ませている）"""
    if not isinstance(c, dict) or c.get('schemaVersion') != 1: return 'schemaVersion が 1 ではありません'
    if c.get('id') != cid: return 'コースの id が保存先と違います'
    if not isinstance(c.get('name'), str) or not c['name'].strip(): return 'コース名がありません'
    nines = c.get('nines')
    if not isinstance(nines, list) or not nines: return '9ホールのまとまり（nines）がありません'
    for n in nines:
        if not isinstance(n, dict) or not isinstance(n.get('holes'), list): return 'ホールの並びが不正です'
    return None


def git(*args):
    """戻り値: (終了コード, 標準出力, エラー出力)"""
    try:
        r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
                           timeout=180, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        return 1, '', 'git が見つかりません'
    except subprocess.TimeoutExpired:
        return 1, '', '時間切れ（ネットにつながっているか確かめてください）'
    return r.returncode, r.stdout, r.stderr


def changed_course_files():
    """courses/ の中で、まだコミットしていないファイル。戻り値: (一覧 or None, エラー)"""
    code, out, err = git('status', '--porcelain', '--', 'courses')
    if code != 0: return None, (err or out).strip()
    # 行頭の2文字（状態）と空白を除いた残りがファイル名。全体を strip すると1行目の空白が消えて1文字ずれる
    return [line[3:].strip().strip('"') for line in out.splitlines() if len(line) > 3], ''


def unpushed():
    """まだ GitHub に送っていないコミット。戻り値: (件数 or None, courses/ 以外を含むか, エラー)"""
    code, out, err = git('rev-list', '--count', '@{u}..HEAD')
    if code != 0: return None, False, (err or out).strip()
    n = int(out.strip() or 0)
    if n == 0: return 0, False, ''
    # 自分の未送信コミットで変えたファイルだけを見る（diff A..B だと相手側だけの変更まで数えてしまう）
    code, out, err = git('log', '--name-only', '--format=', '@{u}..HEAD')
    if code != 0: return n, True, (err or out).strip()
    others = [f for f in out.splitlines() if f.strip() and not f.startswith('courses/')]
    return n, bool(others), ''


def current_branch():
    code, out, _ = git('rev-parse', '--abbrev-ref', 'HEAD')
    return out.strip() if code == 0 else None


def status():
    files, err = changed_course_files()
    n, others, err2 = unpushed()
    return {'ok': True, 'unpublished': files or [], 'unpushed': n or 0,
            'gitError': (err or err2) or None if files is None or n is None else None}


class Handler(SimpleHTTPRequestHandler):
    # Windows ではファイルの種類をレジストリから決めるため、パソコンによって .js が text/plain になることがある
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                      '.webmanifest': 'application/manifest+json', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # 確認のたびに最新のファイルを使う
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/api/' in (self.path or ''): super().log_message(fmt, *args)

    # ---- 守り ----
    def host_ok(self):
        host = (self.headers.get('Host') or '').lower()
        return host in (f'127.0.0.1:{PORT}', f'localhost:{PORT}')

    def api_ok(self):
        """書き換える依頼は、このサーバーから開いた画面からだけ受け付ける"""
        if not self.host_ok(): return False
        origin = self.headers.get('Origin')
        if origin and origin.lower() not in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'): return False
        return self.headers.get(HEADER) == '1'

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY: raise ValueError('送られたデータの大きさが不正です')
        return json.loads(self.rfile.read(n).decode('utf-8'))

    # ---- 受け付け ----
    def do_HEAD(self):
        if not self.host_ok():
            self.send_error(403); return
        super().do_HEAD()

    def do_GET(self):
        if not self.host_ok():
            self.send_error(403); return
        if self.path.split('?')[0] == '/api/pc/status':
            if self.headers.get(HEADER) != '1':
                self.send_json(403, {'error': 'forbidden'}); return
            # 公開の順番待ちに入れない（長い公開中でも画面の読み込みが止まらないように。git status は同時でも壊れない）
            self.send_json(200, status())
            return
        super().do_GET()

    def do_OPTIONS(self):
        self.send_error(403)  # ほかのサイトからの依頼（事前確認）には答えない

    def do_PUT(self):
        m = re.fullmatch(r'/api/pc/course/([a-z0-9-]{1,64})', self.path.split('?')[0])
        if not m or not self.api_ok():
            self.send_json(403, {'error': 'この画面からは保存できません'}); return
        cid = m.group(1)
        if cid in RESERVED_IDS:
            self.send_json(400, {'error': f'コースの id に「{cid}」は使えません'}); return
        try:
            body = self.read_body()
        except Exception as e:
            self.send_json(400, {'error': f'データを読めません: {e}'}); return
        course, base = body.get('course'), body.get('baseRevision')
        err = check_course(course, cid)
        if err:
            self.send_json(400, {'error': err}); return
        path = course_path(cid)
        with lock:
            cur = None
            if os.path.exists(path):
                try:
                    cur = read_json(path)
                except Exception as e:
                    self.send_json(500, {'error': f'今のファイルを読めません: {e}'}); return
            cur_rev = cur.get('revision', 0) if isinstance(cur, dict) else None
            # 読み込んだあとに、別の所（公開版の取り込みなど）でファイルが変わっていたら上書きしない
            if cur is not None and base != cur_rev:
                self.send_json(409, {'error': 'conflict', 'fileRevision': cur_rev}); return
            try:
                if cur is not None:
                    os.makedirs(BACKUPS, exist_ok=True)
                    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
                    shutil.copy2(path, os.path.join(BACKUPS, f'{cid}.{stamp}.r{cur_rev}.json'))
                course['revision'] = (cur_rev or 0) + 1
                course['updated'] = datetime.date.today().isoformat()
                write_json_atomic(path, course)
            except Exception as e:
                self.send_json(500, {'error': f'ファイルに書き込めませんでした（ほかのアプリで開いていませんか）: {e}'}); return
            try:
                # コース一覧に無ければ足す（前回ここで止まってファイルだけできていても、次の保存で足される）
                idx_path = os.path.join(COURSES, 'index.json')
                idx = read_json(idx_path)
                added = False
                if not any(c.get('id') == cid for c in idx.get('courses', [])):
                    idx.setdefault('courses', []).append({'id': cid, 'name': course['name'], 'file': f'{cid}.json'})
                    write_json_atomic(idx_path, idx, indent=2)
                    added = True
            except Exception as e:
                self.send_json(500, {'error': f'コースのファイルは保存しましたが、コース一覧（courses/index.json）に足せませんでした。もう一度保存してください: {e}'}); return
            st = status()
        self.send_json(200, {'ok': True, 'revision': course['revision'], 'updated': course['updated'], 'newCourse': added, **st})

    def do_POST(self):
        if self.path.split('?')[0] != '/api/pc/publish' or not self.api_ok():
            self.send_json(403, {'error': 'この画面からは公開できません'}); return
        with lock:
            branch = current_branch()
            if branch != BRANCH:
                self.send_json(409, {'error': f'いまの枝が {branch} です（{BRANCH} のときだけ公開できます）'}); return
            files, err = changed_course_files()
            if files is None:
                self.send_json(500, {'error': f'git を使えません: {err}'}); return
            n, others, err = unpushed()
            if n is None:
                self.send_json(500, {'error': f'GitHub との違いを確かめられません: {err}'}); return
            if others:
                self.send_json(409, {'error': 'まだ GitHub に送っていない、コース以外のコミットがあります。作業中のものが混ざらないよう、公開をやめました'}); return
            if not files and n == 0:
                self.send_json(200, {'ok': True, 'nothing': True, **status()}); return
            if files:
                code, out, err = git('add', '--', 'courses')
                if code == 0:
                    msg = 'コースデータをパソコンで修正（' + '、'.join(os.path.basename(f) for f in files) + '）'
                    code, out, err = git('commit', '-m', msg, '--', 'courses')
                if code != 0:
                    git('reset', '-q', '--', 'courses')  # コミット予定に残さない（ほかのコミットに混ざらないように）
                    self.send_json(500, {'error': f'コミットできませんでした: {(err or out).strip()[-800:]}'}); return
            code, out, err = git('push')
            if code != 0:
                self.send_json(500, {'error': 'GitHub に送れませんでした。コミットはこのパソコンに残っているので、'
                                     'もう一度「スマホに公開」を押すと送り直します。'
                                     f'（もう1台のパソコンで先に送っていると断られます。その場合は取り込みが必要です）: {(err or out).strip()[-600:]}',
                                     **status()}); return
            st = status()
        self.send_json(200, {'ok': True, 'files': files, **st})


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


if __name__ == '__main__':
    url = f'http://127.0.0.1:{PORT}/editor.html'
    if port_in_use(PORT):
        print(f'すでに起動しています。ブラウザで開きます: {url}')
        if OPEN_BROWSER: webbrowser.open(url)
        sys.exit(0)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'パソコン編集のサーバーを起動しました: {url}')
    print('終えるときは、この黒い画面を閉じてください。')
    if OPEN_BROWSER: threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
