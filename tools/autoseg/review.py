# 自動で取り直した形を、ホールごとに夏の写真へ重ねた確認画像にする
#   .venv/Scripts/python.exe review.py 元のコース.json 取り直したコース.json
# 白い細線 = 元の形、色付き = 取り直した形（赤: ベント、橙: 高麗、桃: バンカー、青: 池、黄: 自動追加のバンカー）
# 出力: work/review/<ホール>.png
import sys, os, json, math, urllib.request, time
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, 'work'); OUT = os.path.join(WORK, 'review'); os.makedirs(OUT, exist_ok=True)
Z = 18

def ll2gp(lat, lng, *_):
    n = 2 ** Z * 256
    s = math.sin(math.radians(lat))
    return (lng + 180) / 360 * n, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n

def tile(tx, ty):
    f = os.path.join(WORK, 'tiles', f'airphoto_{Z}_{tx}_{ty}.png')
    if not os.path.exists(f):
        req = urllib.request.Request(f'https://cyberjapandata.gsi.go.jp/xyz/airphoto/{Z}/{tx}/{ty}.png', headers={'User-Agent': 'golf-navi-personal/0.9'})
        try:
            data = urllib.request.urlopen(req, timeout=30).read()
            open(f + '.part', 'wb').write(data)
            os.replace(f + '.part', f)  # 取れてから置く（失敗で空のファイルを残さない）
        except Exception:
            return Image.new('RGB', (256, 256))
        time.sleep(0.3)
    return Image.open(f).convert('RGB')

def polys(h):
    out = []
    for g in h['greens']:
        if g.get('polygon'): out.append(('g' + g['name'], g['polygon']))
    for z in h['hazards']:
        if z.get('line') or not z.get('polygon'): continue
        out.append(('auto' if z.get('auto') else z['type'], z['polygon']))
    return out

def main(src, dst):
    a = json.load(open(src, encoding='utf-8')); b = json.load(open(dst, encoding='utf-8'))
    font = ImageFont.truetype('C:/Windows/Fonts/meiryob.ttc', 16)
    for na, nb in zip(a['nines'], b['nines']):
        for ha, hb in zip(na['holes'], nb['holes']):
            pa, pb = polys(ha), polys(hb)
            pts = [ll2gp(*p) for _, pl in pa + pb for p in pl] + [ll2gp(*t['pos']) for t in hb.get('tees', [])]
            if not pts: continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            x0, y0, x1, y1 = int(min(xs)) - 30, int(min(ys)) - 30, int(max(xs)) + 30, int(max(ys)) + 30
            im = Image.new('RGB', (x1 - x0, y1 - y0))
            for tx in range(x0 // 256, x1 // 256 + 1):
                for ty in range(y0 // 256, y1 // 256 + 1):
                    im.paste(tile(tx, ty), (tx * 256 - x0, ty * 256 - y0))
            d = ImageDraw.Draw(im, 'RGBA')
            P = lambda p: (ll2gp(*p)[0] - x0, ll2gp(*p)[1] - y0)
            for _, pl in pa:
                d.polygon([P(p) for p in pl], outline=(255, 255, 255, 230), width=1)
            col = {'gベント': (255, 40, 40), 'g高麗': (255, 160, 0), 'bunker': (255, 0, 255), 'water': (0, 140, 255), 'auto': (255, 255, 0)}
            for k, pl in pb:
                c = col.get(k, (0, 255, 200))
                d.polygon([P(p) for p in pl], outline=c + (255,), fill=c + (40,), width=2)
            for t in hb.get('tees', []):
                x, y = P(t['pos']); d.rectangle([x - 5, y - 5, x + 5, y + 5], outline=(0, 230, 255), width=2)
            sc = min(1.0, 900 / max(im.size))
            if sc < 1: im = im.resize((int(im.size[0] * sc), int(im.size[1] * sc)), Image.LANCZOS)
            ImageDraw.Draw(im).text((6, 4), f"{nb['name']}{hb['no']}", fill=(255, 255, 0), font=font)
            im.save(os.path.join(OUT, f"{nb['name']}{hb['no']}.png"))
    print('ok', OUT)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
