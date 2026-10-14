# 画像 AI（Segment Anything）で、グリーン・バンカー・池の形を国土地理院の航空写真から取り直す
#
# 使い方（このフォルダの .venv の Python で実行）:
#   .venv/Scripts/python.exe autoseg.py ../../courses/ota-futaba.json work/ota-futaba.auto.json
#
# - グリーン: 冬の写真（全国最新写真・シームレス。グリーンだけ緑に写る）で、登録済みの中心を「ここ」と指して輪郭を取る
# - バンカー・池: 夏の写真（簡易空中写真。砂が白く写る）で、登録済みの位置を指して輪郭を取る（いまは円で近似）
# - 見落としバンカー: 夏の写真で「芝より明るい砂色」の塊を探し、AI で形にして「自動追加（要確認）」として足す
# - 取れなかったもの・おかしな形のものは元のまま残す。結果は work/ の確認画像で目視してから使う
import sys, os, json, math, io, time, urllib.request, urllib.error
import numpy as np, cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, 'work'); os.makedirs(os.path.join(WORK, 'tiles'), exist_ok=True)
Z = 18
R_EARTH = 6371008.8
LAYERS = {'winter': ('seamlessphoto', 'jpg'), 'summer': ('airphoto', 'png')}

# ---------- 座標 ----------
def ll2gp(lat, lng, *_):
    n = 2 ** Z * 256
    s = math.sin(math.radians(lat))
    return (lng + 180) / 360 * n, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n

def gp2ll(x, y):
    n = 2 ** Z * 256
    lng = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return [round(lat, 6), round(lng, 6)]

def m_per_px(lat):
    return 156543.03392 * math.cos(math.radians(lat)) / 2 ** Z

def dist_m(a, b):
    dl, dn = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(dl / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dn / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(h))

# ---------- 写真 ----------
_tiles = {}
def tile(layer, tx, ty):
    key = (layer, tx, ty)
    if key in _tiles: return _tiles[key]
    name, ext = LAYERS[layer]
    f = os.path.join(WORK, 'tiles', f'{name}_{Z}_{tx}_{ty}.{ext}')
    if not os.path.exists(f):
        req = urllib.request.Request(f'https://cyberjapandata.gsi.go.jp/xyz/{name}/{Z}/{tx}/{ty}.{ext}', headers={'User-Agent': 'golf-navi-personal/0.9'})
        for i in range(3):
            try:
                data = urllib.request.urlopen(req, timeout=30).read()
                open(f + '.part', 'wb').write(data)
                os.replace(f + '.part', f)  # 取れてから置く（失敗で空のファイルを残さない）
                break
            except urllib.error.HTTPError as e:
                if e.code == 404: break  # 写真の範囲外。取り直さない
                time.sleep(2)
            except Exception:
                time.sleep(2)
        time.sleep(0.3)  # 国土地理院のサーバーに負担をかけない
    im = np.array(Image.open(f).convert('RGB')) if os.path.exists(f) else np.zeros((256, 256, 3), np.uint8)
    _tiles[key] = im
    return im

def crop(layer, cx, cy, half):
    """全体画素 (cx, cy) を中心に一辺 2*half の画像を切り出す。戻り値: 画像, 左上の全体画素"""
    x0, y0 = int(cx - half), int(cy - half)
    x1, y1 = x0 + 2 * half, y0 + 2 * half
    out = np.zeros((2 * half, 2 * half, 3), np.uint8)
    for tx in range(x0 // 256, (x1 - 1) // 256 + 1):
        for ty in range(y0 // 256, (y1 - 1) // 256 + 1):
            t = tile(layer, tx, ty)
            ax0, ay0 = max(x0, tx * 256), max(y0, ty * 256)
            ax1, ay1 = min(x1, tx * 256 + 256), min(y1, ty * 256 + 256)
            out[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = t[ay0 - ty * 256:ay1 - ty * 256, ax0 - tx * 256:ax1 - tx * 256]
    return out, (x0, y0)

# ---------- AI ----------
from segment_anything import sam_model_registry, SamPredictor
import torch
torch.set_num_threads(max(1, os.cpu_count() - 1))
sam = sam_model_registry['vit_b'](checkpoint=os.path.join(HERE, 'models', 'sam_vit_b_01ec64.pth'))
sam.eval()
predictor = SamPredictor(sam)
_last_img = None

def segment(layer, center_ll, half_px, area_m2, extra_points=()):
    """center_ll を「ここ」と指して形を取る。area_m2=(最小, 最大)。戻り値: (多角形[緯度経度], 面積m², 信頼度) か None"""
    global _last_img
    gx, gy = ll2gp(*center_ll)
    img, (x0, y0) = crop(layer, gx, gy, half_px)
    key = (layer, x0, y0, half_px)
    if _last_img != key:
        predictor.set_image(img)
        _last_img = key
    pts = [[gx - x0, gy - y0]] + [[ll2gp(*p)[0] - x0, ll2gp(*p)[1] - y0] for p in extra_points]
    masks, scores, _ = predictor.predict(point_coords=np.array(pts, float), point_labels=np.ones(len(pts)), multimask_output=True)
    mpp = m_per_px(center_ll[0])
    best = None
    for m, sc in zip(masks, scores):
        m8 = m.astype(np.uint8)
        if not m8[int(gy - y0), int(gx - x0)]: continue          # 指した点を含まない形は使わない
        if m8[0, :].any() or m8[-1, :].any() or m8[:, 0].any() or m8[:, -1].any(): continue  # 切り出しの端まで広がる＝取りすぎ
        area = m8.sum() * mpp * mpp
        if not (area_m2[0] <= area <= area_m2[1]): continue
        if best is None or sc > best[2]: best = (m8, area, float(sc))
    if not best: return None
    m8, area, sc = best
    m8 = cv2.morphologyEx(m8, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(m8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts: return None
    c = max(cnts, key=cv2.contourArea)
    poly = cv2.approxPolyDP(c, 1.0, True)[:, 0, :]
    if len(poly) < 4: return None
    return [gp2ll(x0 + px + 0.5, y0 + py + 0.5) for px, py in poly], area, sc, img, (x0, y0), m8

# ---------- 見落としバンカーの候補（夏の写真で芝より明るい砂色） ----------
def sand_candidates(center_ll, half_px):
    gx, gy = ll2gp(*center_ll)
    img, (x0, y0) = crop('summer', gx, gy, half_px)
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV).astype(np.float32)
    V, S = hsv[..., 2] / 255, hsv[..., 1] / 255
    bg = cv2.medianBlur(img, 31).astype(np.float32).mean(axis=2) / 255
    mask = ((V > 0.62) & (S < 0.30) & (V - bg > 0.12)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, cen = cv2.connectedComponentsWithStats(mask)
    mpp = m_per_px(center_ll[0])
    out = []
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA] * mpp * mpp
        if not (12 <= area <= 500): continue
        w, h = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if max(w, h) / max(min(w, h), 1) > 4: continue  # 細長い＝カート道・道路
        out.append(gp2ll(x0 + cen[i][0], y0 + cen[i][1]))
    return out

def poly_centroid(poly):
    return [sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)]

def inside(p, poly):
    c = np.array([ll2gp(*q) for q in poly], np.float32)
    return cv2.pointPolygonTest(c, ll2gp(*p), False) >= 0

def near_any(p, polys, m):
    return any(min(dist_m(p, q) for q in pl) < m or dist_m(p, poly_centroid(pl)) < m for pl in polys if pl)

# ---------- 実行 ----------
def main(src, dst):
    course = json.load(open(src, encoding='utf-8'))
    report = {'greens': [], 'bunkers': [], 'water': [], 'added': []}
    vis = []  # 確認画像用
    only = os.environ.get('ONLY')  # 例: ONLY=愛宕1 で1ホールだけ試す
    for nine in course['nines']:
        for h in nine['holes']:
            tag = f"{nine['name']}{h['no']}"
            if only and tag not in only.split(','): continue
            tee = h['tees'][0]['pos'] if h.get('tees') else None
            # グリーン（冬の写真）
            for g in h['greens']:
                if not g.get('center'): continue
                r = segment('winter', g['center'], 64, (120, 1600))
                if r is None: r = segment('summer', g['center'], 64, (120, 1600))
                if r:
                    poly, area, sc, img, org, m8 = r
                    g['polygon'] = poly
                    mo = cv2.moments(m8, binaryImage=True)  # 面積の重心（頂点の平均は頂点の多い側へ寄る）
                    c = gp2ll(org[0] + mo['m10'] / mo['m00'] + 0.5, org[1] + mo['m01'] / mo['m00'] + 0.5)
                    g['center'] = c + g['center'][2:3]  # 標高は元の値（グリーン上なので差は小さい）
                    vis.append((tag + g['name'][0], img, m8))
                report['greens'].append({'hole': tag, 'green': g['name'], 'ok': bool(r), 'area_m2': round(r[1]) if r else None})
            # バンカー・池（夏の写真）
            done = []
            for z in h['hazards']:
                if z.get('line') or z.get('type') not in ('bunker', 'water'): continue
                c = poly_centroid(z['polygon']) if z.get('polygon') else (poly_centroid(z['points']) if z.get('points') else None)
                if not c: continue
                if z['type'] == 'bunker':
                    r = segment('summer', c, 48, (8, 700))
                    kind = 'bunkers'
                else:
                    r = segment('summer', c, 110, (60, 12000))
                    kind = 'water'
                if r and any(t == z['type'] and gr == z.get('green') and inside(poly_centroid(r[0]), q) for t, gr, q in done):
                    z['_dup'] = True  # 1つの変形バンカーを円いくつかで登録していた → 1つにまとめる
                    report['merged'] = report.get('merged', 0) + 1
                    continue
                if r:
                    z['polygon'] = r[0]; z['points'] = []
                    done.append((z['type'], z.get('green'), r[0]))
                    vis.append((tag + ('B' if kind == 'bunkers' else 'W'), r[3], r[5]))
                report[kind].append({'hole': tag, 'label': z['label'], 'ok': bool(r), 'area_m2': round(r[1]) if r else None})
            h['hazards'] = [z for z in h['hazards'] if not z.get('_dup')]
            # 見落としバンカー: グリーン周り（半径40m）と、ティー→グリーンの途中で探す
            known = [g['polygon'] for n2 in course['nines'] for h2 in n2['holes'] for g in h2['greens'] if g.get('polygon')]                 + [z['polygon'] for n2 in course['nines'] for h2 in n2['holes'] for z in h2['hazards'] if not z.get('line') and z.get('polygon')]
            centers = [g['center'] for g in h['greens'] if g.get('center')]
            if tee and centers:
                gc = centers[0]
                for t in (0.45, 0.65):  # 着地点あたり
                    centers.append([tee[0] + (gc[0] - tee[0]) * t, tee[1] + (gc[1] - tee[1]) * t])
            seen = []
            for ctr in centers:
                for cand in sand_candidates(ctr, 90):
                    if near_any(cand, known + seen, 4): continue
                    r = segment('summer', cand, 48, (12, 500))
                    if not r: continue
                    if any(inside(poly_centroid(r[0]), q) or inside(poly_centroid(q), r[0]) for q in known + seen): continue  # 既存の形と重なる
                    # 砂かどうか（夏の写真で形の中が明るく彩度が低い）
                    img, (x0, y0), m8 = r[3], r[4], r[5]
                    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
                    px_in = hsv[m8.astype(bool)]
                    if px_in[:, 2].mean() < 150 or px_in[:, 1].mean() > 80: continue
                    z = {'type': 'bunker', 'label': 'バンカー（自動追加・要確認）', 'points': [], 'polygon': r[0], 'auto': True}
                    h['hazards'].append(z)
                    seen.append(r[0])
                    vis.append((tag + '+', img, m8))
                    report['added'].append({'hole': tag, 'area_m2': round(r[1])})
            print(f"{tag}: グリーン {sum(1 for x in report['greens'] if x['hole'] == tag and x['ok'])}/{len(h['greens'])}"
                  f" 追加バンカー {sum(1 for x in report['added'] if x['hole'] == tag)}", flush=True)
    json.dump(course, open(dst, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    json.dump(report, open(os.path.join(WORK, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    # 確認用: 切り出しと取れた形を並べた一覧（1枚 128px）
    tiles_per_row = 10
    rows = []
    for i in range(0, len(vis), tiles_per_row):
        row = []
        for name, img, m8 in vis[i:i + tiles_per_row]:
            v = cv2.resize(img, (128, 128))
            mm = cv2.resize(m8, (128, 128), interpolation=cv2.INTER_NEAREST)
            cnts, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            v = v.copy(); cv2.drawContours(v, cnts, -1, (255, 0, 0), 2)
            cv2.putText(v, name, (3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)
            row.append(v)
        while len(row) < tiles_per_row: row.append(np.zeros((128, 128, 3), np.uint8))
        rows.append(np.hstack(row))
    for k in range(0, len(rows), 8):
        Image.fromarray(np.vstack(rows[k:k + 8])).save(os.path.join(WORK, f'check_{k // 8 + 1}.png'))
    s = {k: f"{sum(1 for x in v if x.get('ok', True))}/{len(v)}" if isinstance(v, list) else v for k, v in report.items()}
    print('結果:', s)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
