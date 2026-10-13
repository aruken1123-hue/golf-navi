// 地図の土台（国土地理院の航空写真）と、コース範囲の地図の事前保存
/* global L */
import { DEM_SOURCES, demTileUrl, tilePixel } from './elev.js';

const PHOTO_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
export const TILE_CACHE = 'gsi-tiles-v1'; // sw.js と同じ名前
const PHOTO_ZOOMS = [15, 16, 17, 18];

export function createMap(el) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, maxZoom: 20 });
  L.tileLayer(PHOTO_URL, {
    minZoom: 5, maxNativeZoom: 18, maxZoom: 20,
    crossOrigin: true, // CORSで取る（Service Workerで保存できる形にするため）
    attribution: '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院（全国最新写真（シームレス））</a>',
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  // 画面の組み立て後に枠の大きさが変わっても、地図を枠いっぱいに描き直す
  if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize()).observe(el);
  return map;
}

/** コースの外枠を薄く描く（OSM由来なので出典を足す） */
export function drawOutline(map, course) {
  if (!course.outline || course.outline.length < 3) return null;
  map.attributionControl.addAttribution('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>');
  return L.polygon(course.outline, { color: '#fff', weight: 1, opacity: 0.5, fill: false, interactive: false }).addTo(map);
}

export const HAZARD_TYPES = {
  bunker: { label: 'バンカー', color: '#f5d76e' },
  water: { label: '池', color: '#3fa9f5' },
  lateral_water: { label: '池（横）', color: '#e74c3c' },
  ob: { label: 'OB', color: '#ffffff' },
  other: { label: 'その他', color: '#ff9f43' },
};

const ll2 = (p) => [p[0], p[1]];

// Leaflet のツールチップは文字列を HTML として扱う。読み込んだJSONやOSMの名前を
// そのまま渡すとスクリプトを埋め込めるので、必ず文字として表示する要素で渡す
function textNode(text) {
  const span = document.createElement('span');
  span.textContent = text ?? '';
  return span;
}

/**
 * 1ホール分（ティー・ルート線・グリーン・ハザード）を group に描き、範囲を返す。
 * activeGreen（グリーンの名前）を渡すと、そのグリーンを濃く、ほかのグリーンと専用ハザードを薄く描く。
 */
export function drawHole(group, hole, activeGreen, { requireCenter = true } = {}) {
  const pts = [];
  const add = (p) => { pts.push(ll2(p)); return ll2(p); };
  for (const t of hole.tees || []) {
    L.circleMarker(add(t.pos), { radius: 6, color: '#fff', weight: 2, fillColor: '#2d8cff', fillOpacity: 1 })
      .bindTooltip(textNode(`ティー（${t.name}）`)).addTo(group);
  }
  const greens = hole.greens || [];
  // プレー画面は中央のあるグリーンだけが対象。登録画面は登録途中（中央なし）でも選んだ名前を強調する
  const active = greens.find((g) => g.name === activeGreen && (g.center || !requireCenter)) || greens.find((g) => g.center);
  const route = hole.line && hole.line.length >= 2 ? hole.line.map(ll2)
    : hole.tees?.[0] && active?.center ? [ll2(hole.tees[0].pos), ll2(active.center)] : null;
  if (route) L.polyline(route, { color: '#fff', weight: 2, opacity: 0.7, dashArray: '6 6', interactive: false }).addTo(group);
  const showNames = greens.length >= 2;
  for (const g of greens) {
    const on = g === active || !active;
    const o = on ? 1 : 0.35;
    const name = `${g.name}グリーン`;
    if (g.polygon && g.polygon.length >= 3) {
      L.polygon(g.polygon.map(add), { color: '#7CFC00', weight: 2, opacity: o, fillOpacity: 0.25 * o }).bindTooltip(textNode(name)).addTo(group);
    }
    for (const [key, label] of [['front', '前'], ['back', '奥']]) {
      if (g[key]) L.circleMarker(add(g[key]), { radius: 4, color: '#7CFC00', weight: 2, opacity: o, fillOpacity: 0.6 * o }).bindTooltip(textNode(`${name}・${label}`)).addTo(group);
    }
    if (g.center) {
      const m = L.circleMarker(add(g.center), { radius: on ? 7 : 5, color: '#fff', weight: 2, opacity: o, fillColor: on ? '#e60033' : '#888', fillOpacity: on ? 1 : 0.6 }).addTo(group);
      if (showNames) m.bindTooltip(textNode(g.name), { permanent: true, direction: 'top', offset: [0, -6], className: on ? 'green-label' : 'green-label off' });
      else m.bindTooltip(textNode(`${name}・中央`));
    }
  }
  for (const h of hole.hazards || []) {
    const color = (HAZARD_TYPES[h.type] || HAZARD_TYPES.other).color;
    const o = !h.green || !active || h.green === active.name ? 1 : 0.35; // 別のグリーン専用なら薄く
    const label = h.green ? `${h.label}（${h.green}）` : h.label;
    if (h.line && h.line.length >= 2) {
      // OB は白の破線、それ以外の線は種類の色
      L.polyline(h.line.map(add), { color, weight: 2, opacity: 0.8 * o, dashArray: h.type === 'ob' ? '6 6' : null })
        .bindTooltip(textNode(label)).addTo(group);
    } else if (h.polygon && h.polygon.length >= 3) {
      L.polygon(h.polygon.map(add), { color, weight: 2, opacity: o, fillOpacity: 0.3 * o }).bindTooltip(textNode(label)).addTo(group);
    } else {
      for (const p of h.points || []) {
        L.circleMarker(add(p), { radius: 6, color: '#000', weight: 1, opacity: o, fillColor: color, fillOpacity: 0.9 * o }).bindTooltip(textNode(label)).addTo(group);
      }
      if ((h.points || []).length === 2) L.polyline(h.points.map(ll2), { color, weight: 3, opacity: o, interactive: false }).addTo(group);
    }
  }
  return pts.length ? L.latLngBounds(pts) : null;
}

/** bbox [南, 西, 北, 東] を覆うタイル番号の一覧 */
export function tilesInBbox(bbox, z) {
  const a = tilePixel(bbox[2], bbox[1], z); // 北西
  const b = tilePixel(bbox[0], bbox[3], z); // 南東
  const out = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
  return out;
}

/** コース範囲の航空写真と標高タイルのURL一覧 */
export function courseTileUrls(bbox) {
  const urls = [];
  for (const z of PHOTO_ZOOMS) {
    for (const t of tilesInBbox(bbox, z)) urls.push(PHOTO_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y));
  }
  for (const src of DEM_SOURCES) {
    for (const t of tilesInBbox(bbox, src.z)) urls.push(demTileUrl(src.layer, t.z, t.x, t.y));
  }
  return urls;
}

/**
 * コース範囲のタイルを端末に保存する（圏外でも地図と高低差が出るように）。
 * 国土地理院のサーバーに負担をかけないよう、同時4本まで・保存済みは取り直さない。
 */
export async function prefetchCourseTiles(bbox, onProgress) {
  const cache = await caches.open(TILE_CACHE);
  const urls = courseTileUrls(bbox);
  let done = 0, failed = 0;
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cache.put(url, res);
          else if (res.status !== 404) failed++; // 標高データの無い場所は 404 で正常
        }
      } catch { failed++; }
      done++;
      onProgress?.(done, urls.length, failed);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { total: urls.length, failed };
}
