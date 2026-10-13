// 距離・方位・図形計算（画面に依存しない純粋関数）
// 座標はすべて [緯度, 経度, 標高(任意)] の配列。Leaflet と同じ順（GeoJSON とは逆）。

const EARTH_R = 6371008.8; // 地球の平均半径 [m]
const RAD = Math.PI / 180;
export const M_PER_YD = 0.9144;

/** 2点間の距離 [m]（ハーバサイン式） */
export function distanceM(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const toYards = (m) => m / M_PER_YD;

/** a から b への方位 [度]（北=0、時計回り） */
export function bearingDeg(a, b) {
  const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) -
    Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// ゴルフ場の広さ（数km）なら、基準点まわりの平面近似で誤差は無視できる
function toXY(origin, p) {
  return [
    (p[1] - origin[1]) * RAD * EARTH_R * Math.cos(origin[0] * RAD),
    (p[0] - origin[0]) * RAD * EARTH_R,
  ];
}
function fromXY(origin, [x, y]) {
  return [
    origin[0] + y / (EARTH_R * RAD),
    origin[1] + x / (EARTH_R * Math.cos(origin[0] * RAD) * RAD),
  ];
}

/**
 * from→toward を延長した直線と多角形の境界との交点を、from に近い順で返す。
 * グリーンの「前・奥」を現在地に合わせて求めるのに使う。
 */
export function lineIntersections(from, toward, polygon) {
  const d = toXY(from, toward);
  const hits = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = toXY(from, polygon[i]);
    const q = toXY(from, polygon[(i + 1) % polygon.length]);
    const e = [q[0] - p[0], q[1] - p[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue; // 平行
    const t = (p[0] * e[1] - p[1] * e[0]) / den; // 直線上の位置（0=from）
    const u = (p[0] * d[1] - p[1] * d[0]) / den; // 辺上の位置（0〜1）
    if (t >= 0 && u >= 0 && u <= 1) hits.push(fromXY(from, [d[0] * t, d[1] * t]));
  }
  return hits.sort((a, b) => distanceM(from, a) - distanceM(from, b));
}

/** 多角形の境界上で pos に最も近い点 */
export function nearestPointOnPolygon(pos, polygon) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const p = toXY(pos, polygon[i]);
    const q = toXY(pos, polygon[(i + 1) % polygon.length]);
    const e = [q[0] - p[0], q[1] - p[1]];
    const len2 = e[0] ** 2 + e[1] ** 2;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(p[0] * e[0] + p[1] * e[1]) / len2));
    const c = [p[0] + e[0] * t, p[1] + e[1] * t];
    const dd = Math.hypot(c[0], c[1]);
    if (dd < bestD) { bestD = dd; best = c; }
  }
  return best && fromXY(pos, best);
}

/**
 * グリーンの前・中央・奥までの距離 [m]。
 * polygon があれば現在地→中央の線との交点から前・奥を求め、無ければ登録点を使う。
 */
export function greenDistances(pos, green) {
  const center = distanceM(pos, green.center);
  if (green.polygon && green.polygon.length >= 3) {
    const hits = lineIntersections(pos, green.center, green.polygon);
    if (hits.length >= 2) {
      return { front: distanceM(pos, hits[0]), center, back: distanceM(pos, hits[hits.length - 1]) };
    }
  }
  return {
    front: green.front ? distanceM(pos, green.front) : null,
    center,
    back: green.back ? distanceM(pos, green.back) : null,
  };
}

/**
 * ハザードまでの距離 [m]。reach=手前（届く距離）、carry=越える距離。
 * points が1点なら reach のみ、2点なら手前・奥。polygon があればそちらを優先。
 * polygon の carry は、グリーン方向の線が形を横切る最後の点まで（横に長い池・OBで過大にしないため）。
 * 線が形を通らなければ、一番遠い頂点までを使う。
 */
export function hazardDistances(pos, hazard, greenCenter) {
  if (hazard.polygon && hazard.polygon.length >= 3) {
    const reach = distanceM(pos, nearestPointOnPolygon(pos, hazard.polygon));
    const hits = greenCenter ? lineIntersections(pos, greenCenter, hazard.polygon) : [];
    const carry = hits.length >= 2
      ? distanceM(pos, hits[hits.length - 1])
      : Math.max(...hazard.polygon.map((p) => distanceM(pos, p)));
    return { reach, carry };
  }
  const ds = (hazard.points || []).map((p) => distanceM(pos, p));
  if (ds.length === 0) return null;
  return { reach: Math.min(...ds), carry: ds.length > 1 ? Math.max(...ds) : null };
}

/** 点の並びの重心（頂点の平均） */
export function centroid(pts) {
  if (!pts || pts.length === 0) return null;
  return [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
}

function hazardVertices(hazard) {
  return hazard.polygon && hazard.polygon.length >= 3 ? hazard.polygon : hazard.points || [];
}

/**
 * 現在地より前（グリーン寄り）にあるハザードだけを、近い順に距離付きで返す。
 * どれか1つの頂点でも現在地よりグリーンに近ければ「前」とみなす（長いOB・横の池が途中で消えないように）。
 */
export function hazardsAhead(pos, hazards, greenCenter) {
  const toGreen = distanceM(pos, greenCenter);
  return hazards
    .map((h) => ({ hazard: h, dist: hazardDistances(pos, h, greenCenter) }))
    .filter((x) => x.dist && hazardVertices(x.hazard).some((p) => distanceM(p, greenCenter) < toGreen))
    .sort((a, b) => a.dist.reach - b.dist.reach);
}

/** 高低差 [m]（正=打ち上げ、負=打ち下ろし）。どちらかの標高が無ければ null */
export function elevationDiff(fromElev, toElev) {
  if (fromElev == null || toElev == null) return null;
  return toElev - fromElev;
}
