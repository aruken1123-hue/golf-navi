# autoseg.py の結果をふるいにかけ、怪しい形は元に戻す
#   .venv/Scripts/python.exe postcheck.py 元のコース.json 取り直したコース.json 出力.json [除外するもの...]
# 除外の書き方: 「御所ノ入9:高麗」（グリーンを元に戻す）、「御所ノ入7:+2」（そのホールの自動追加2つ目を捨てる）
# ふるいの基準:
#   グリーン: 面積 150〜900m²、へこみが少ない（凸包に対する面積比 0.88 以上）。元の形は色で取った小さめの形なので比べない
#             採用した形の中心は面積の重心にする
#   バンカー・池: 同じ種類で中心が 15m 以内の元の形より極端に小さい（35%未満）ときは、一部しか取れていないので元に戻す
#   自動追加のバンカー: 細長くない（縦横比 3 以下）、長方形すぎない（屋根を除く）、へこみが少ない、
#             どのホールの既存バンカー・池・グリーンとも重ならない（隣のホールのバンカーを拾い直したものを除く）
#             近いグリーンが一方だけ（30m 以内で、もう一方より 1.5 倍以上近い）なら、そのグリーン用にする
import sys, json, math, datetime
import numpy as np, cv2

LAT0 = None  # 平面に直すときの基準緯度（コース全体で1つにする。多角形ごとに変えると経度方向が大きくずれる）

def to_xy(poly):
    k = 111320 * math.cos(math.radians(LAT0))
    return np.array([[p[1] * k, -p[0] * 110540] for p in poly], np.float64)

def from_xy(x, y):
    k = 111320 * math.cos(math.radians(LAT0))
    return [round(-y / 110540, 6), round(x / k, 6)]

def shape(poly):
    if not poly or len(poly) < 3: return None
    c = (to_xy(poly) - to_xy(poly).mean(axis=0)).astype(np.float32)  # 原点近くに寄せてから float32 にする（桁落ち防止）
    area = abs(cv2.contourArea(c))
    hull = abs(cv2.contourArea(cv2.convexHull(c))) or 1
    (_, _), (w, h), _ = cv2.minAreaRect(c)
    w, h = max(w, h), max(min(w, h), 0.1)
    return {'area': area, 'solidity': area / hull, 'aspect': w / h, 'rect': area / (w * h)}

def area_centroid(poly):
    """面積の重心（頂点の平均は、頂点の多い側に寄る）"""
    c = to_xy(poly)
    o = c.mean(axis=0)
    x, y = c[:, 0] - o[0], c[:, 1] - o[1]
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    cr = x * y1 - x1 * y
    a = cr.sum() / 2
    if abs(a) < 1e-9: return from_xy(*o)
    return from_xy(o[0] + ((x + x1) * cr).sum() / (6 * a), o[1] + ((y + y1) * cr).sum() / (6 * a))

def center_xy(poly):
    return to_xy(poly).mean(axis=0)

def inside(p_xy, poly):
    c = to_xy(poly)
    o = c.mean(axis=0)
    return cv2.pointPolygonTest((c - o).astype(np.float32), (float(p_xy[0] - o[0]), float(p_xy[1] - o[1])), False) >= 0

def overlaps(p, q):
    """どちらかの中心がもう一方の中に入っていれば重なっているとみなす"""
    return inside(center_xy(p), q) or inside(center_xy(q), p)

def main(src, auto, dst, excludes):
    global LAT0
    a = json.load(open(src, encoding='utf-8')); b = json.load(open(auto, encoding='utf-8'))
    LAT0 = a['nines'][0]['holes'][0]['tees'][0]['pos'][0]
    ex = set(excludes)
    log = []
    # コース全体の既存の形（自動追加以外）。自動追加の重なり判定に使う
    existing = [z['polygon'] for n in b['nines'] for h in n['holes'] for z in h['hazards'] if not z.get('auto') and not z.get('line') and z.get('polygon')]
    for na, nb in zip(a['nines'], b['nines']):
        for ha, hb in zip(na['holes'], nb['holes']):
            tag = f"{nb['name']}{hb['no']}"
            for ga, gb in zip(ha['greens'], hb['greens']):
                gb['front'], gb['back'] = ga.get('front'), ga.get('back')  # 手入力の前・奥は残す（形がある所は形から計算される）
                sa, sb = shape(ga.get('polygon')), shape(gb.get('polygon'))
                if gb.get('polygon') == ga.get('polygon') or sb is None: continue  # 取り直せなかった
                ok = sb['solidity'] >= 0.88 and 150 <= sb['area'] <= 900 and f"{tag}:{gb['name']}" not in ex
                log.append(f"{'採用' if ok else '戻す'} {tag} {gb['name']}グリーン 面積 {sa and round(sa['area'])}→{round(sb['area'])}m² へこみ比 {sb['solidity']:.2f}")
                if ok:
                    gb['center'] = area_centroid(gb['polygon']) + ga['center'][2:3]
                else:
                    gb['polygon'], gb['center'] = ga.get('polygon'), ga['center']
            existing += [g['polygon'] for g in hb['greens'] if g.get('polygon')]
            # 取り直したバンカー・池: 元より極端に小さい（一部しか取れていない）ときは元の形に戻す
            for z in hb['hazards']:
                if z.get('auto') or z.get('line') or z['type'] not in ('bunker', 'water') or not z.get('polygon'): continue
                cz = center_xy(z['polygon'])
                olds = [o for o in ha['hazards'] if o['type'] == z['type'] and not o.get('line') and o.get('polygon')
                        and np.linalg.norm(center_xy(o['polygon']) - cz) < 15]
                if not olds: continue
                near = min(olds, key=lambda o: np.linalg.norm(center_xy(o['polygon']) - cz))
                if near['polygon'] == z['polygon']: continue
                so, sn = shape(near['polygon']), shape(z['polygon'])
                if sn['area'] < 0.35 * so['area']:
                    log.append(f"戻す {tag} {z['label']} 面積 {round(so['area'])}→{round(sn['area'])}m²（一部しか取れていない）")
                    z['polygon'] = near['polygon']
            n = 0
            keep = []
            for z in hb['hazards']:
                if not z.get('auto'):
                    keep.append(z); continue
                n += 1
                s = shape(z['polygon'])
                dup = any(overlaps(z['polygon'], q) for q in existing)
                ok = s['aspect'] <= 3 and s['rect'] <= 0.85 and s['solidity'] >= 0.7 and not dup and f"{tag}:+{n}" not in ex
                log.append(f"{'採用' if ok else '捨てる'} {tag} 自動追加{n} 面積 {round(s['area'])}m² 縦横比 {s['aspect']:.1f} 長方形度 {s['rect']:.2f} へこみ比 {s['solidity']:.2f}"
                           + ('（既存の形と重なる）' if dup else ''))
                if not ok: continue
                z.pop('auto', None)
                gs = sorted(((np.linalg.norm(center_xy(z['polygon']) - center_xy(g['polygon'])), g['name']) for g in hb['greens'] if g.get('polygon')))
                if len(gs) >= 2 and gs[0][0] < 30 and gs[1][0] > 1.5 * gs[0][0]:
                    z['green'] = gs[0][1]
                    log.append(f"　→ {gs[0][1]}グリーン用（{gs[0][0]:.0f}m / {gs[1][0]:.0f}m）")
                existing.append(z['polygon'])
                keep.append(z)
            hb['hazards'] = keep
    b['revision'] = a.get('revision', 1) + 1
    b['updated'] = datetime.date.today().isoformat()
    json.dump(b, open(dst, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    print('\n'.join(log))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
