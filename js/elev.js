// 標高の取得（国土地理院の標高タイルを読み、だめなら標高APIを使う）
// 仕様: https://maps.gsi.go.jp/development/demtile.html

const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
// 精度の高い順に試す
export const DEM_SOURCES = [
  { name: '5m（レーザ）', layer: 'dem5a_png', z: 15 },
  { name: '5m（写真測量）', layer: 'dem5b_png', z: 15 },
  { name: '5m（写真測量5C）', layer: 'dem5c_png', z: 15 },
  { name: '10m', layer: 'dem_png', z: 14 },
];
const ELEV_API = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';

/** 標高タイルの画素の色を標高 [m] に直す。無効値は null */
export function decodeDemRGB(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null; // (128,0,0) はデータなし
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}

/** 緯度経度 → ズーム z のタイル番号とタイル内の画素位置（Webメルカトル） */
export function tilePixel(lat, lng, z) {
  const n = 2 ** z * 256;
  const px = ((lng + 180) / 360) * n;
  const s = Math.sin(lat * Math.PI / 180);
  const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return {
    x: Math.floor(px / 256), y: Math.floor(py / 256),
    px: Math.floor(px) % 256, py: Math.floor(py) % 256,
  };
}

export function demTileUrl(layer, z, x, y) {
  return `${GSI}/${layer}/${z}/${x}/${y}.png`;
}

// 読み込んだタイルの画素を覚えておく（同じホール内では何度も同じタイルを使う）
const tileCache = new Map();
const TILE_CACHE_MAX = 40;

const NO_DATA = 'none'; // その場所にはこの種類の標高データが無い（404）

// 戻り値: 画素データ / NO_DATA / null（通信失敗。次回やり直す）
async function loadTilePixels(url) {
  if (tileCache.has(url)) return tileCache.get(url);
  const promise = (async () => {
    const res = await fetch(url, { mode: 'cors' });
    if (res.status === 404) return NO_DATA; // 覚えておき、何度も問い合わせない
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, 256, 256).data;
  })().catch(() => null);
  tileCache.set(url, promise);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  const data = await promise;
  if (data === null) tileCache.delete(url); // 通信失敗は次回やり直す
  return data;
}

/**
 * 標高 [m] とデータ源を返す。取れなければ { elev: null }。
 * 標高タイル（地図保存でオフラインでも使える）を優先し、最後に標高APIを使う。
 */
export async function getElevation(lat, lng) {
  for (const src of DEM_SOURCES) {
    const t = tilePixel(lat, lng, src.z);
    const data = await loadTilePixels(demTileUrl(src.layer, src.z, t.x, t.y));
    if (!data || data === NO_DATA) continue;
    const i = (t.py * 256 + t.px) * 4;
    const elev = decodeDemRGB(data[i], data[i + 1], data[i + 2]);
    if (elev != null) return { elev: Math.round(elev * 10) / 10, source: src.name };
  }
  try {
    const res = await fetch(`${ELEV_API}?lon=${lng}&lat=${lat}&outtype=JSON`);
    const j = await res.json();
    if (typeof j.elevation === 'number') return { elev: j.elevation, source: j.hsrc };
  } catch { /* 圏外など */ }
  return { elev: null, source: null };
}
