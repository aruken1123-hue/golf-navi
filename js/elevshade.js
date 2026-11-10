// 高低差の色分け: ティーの高さを基準に、まわりの土地が高い所を赤系、低い所を青系で地図に重ねる
// 国土地理院の標高タイル（5m）を読み、地図の画面の1枚ごとに色を塗る
/* global L */
import { loadDemGrid } from './elev.js';

export const SHADE_ALPHA = 0.5;   // 写真が透けて見える濃さ
const DEM_Z = 15;                 // 5m の標高タイルの拡大率
export const SHADE_STEPS = [1, 2, 3, 5, 10]; // 色を変える幅の候補 [m]
export const SHADE_LEVELS = 6;    // 高い側・低い側それぞれの段の数

// 高い所は黄→赤、低い所は水色→青紫（暗い写真の上でも見えるよう、明るめの色）
export const UP_COLORS = ['#ffe066', '#ffbf3f', '#ff8f2e', '#f2552c', '#d1262b', '#9b1230'];
export const DOWN_COLORS = ['#b8ecff', '#7fd4ff', '#4fb2ff', '#4a86ff', '#6a63ff', '#8a45f0'];

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const UP_RGB = UP_COLORS.map(hex), DOWN_RGB = DOWN_COLORS.map(hex);

/**
 * 色を変える幅 [m] を、ホールの中の高低差の大きさ（ティーとグリーンの差の最大 [m]）から決める。
 * 大きい差でも段が足りるよう、差が 5 段ほど（5.5 段まで）に収まる、いちばん細かい幅を選ぶ
 */
export function shadeStepFor(maxAbsDiff) {
  const d = Math.abs(Number(maxAbsDiff) || 0);
  return SHADE_STEPS.find((s) => d / s <= 5.5) ?? SHADE_STEPS[SHADE_STEPS.length - 1];
}

/**
 * ティーとの高低差 [m] → 何段目の色か。幅 step の何倍に近いかで決める（±step/2 未満は塗らない＝0）。
 * 高いと 1〜6、低いと −1〜−6（6 はそれ以上をまとめる）
 */
export function shadeBand(diff, step = 2) {
  if (!Number.isFinite(diff) || !(step > 0)) return 0;
  const k = Math.min(SHADE_LEVELS, Math.round(Math.abs(diff) / step));
  if (k === 0) return 0; // −0 を返さない
  return diff > 0 ? k : -k;
}

/** 段 → [r, g, b] か null（塗らない） */
export function bandColor(band) {
  if (!band) return null;
  return band > 0 ? UP_RGB[band - 1] : DOWN_RGB[-band - 1];
}

/** 凡例の色（左から: 低い→同じくらい→高い）。{ color, label }。label はその段のおよその差 */
export function legendRows(step = 2) {
  const rows = [];
  for (let k = SHADE_LEVELS; k >= 1; k--) rows.push({ color: DOWN_COLORS[k - 1], label: `−${k * step}m${k === SHADE_LEVELS ? '〜' : ''}` });
  rows.push({ color: null, label: '0' });
  for (let k = 1; k <= SHADE_LEVELS; k++) rows.push({ color: UP_COLORS[k - 1], label: `+${k * step}m${k === SHADE_LEVELS ? '〜' : ''}` });
  return rows;
}

/** 256×256 の標高の格子から、格子の画素座標 (gx, gy) の値を4点の重みで補う（端は切り詰め）。NaN を含めば NaN */
export function sampleGrid(grid, gx, gy) {
  const x0 = Math.max(0, Math.min(254, Math.floor(gx))), y0 = Math.max(0, Math.min(254, Math.floor(gy)));
  const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
  const i = y0 * 256 + x0;
  const a = grid[i], b = grid[i + 1], c = grid[i + 256], d = grid[i + 257];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** 引いた縮尺でも塗る下限（これより引くと標高タイルを何十枚も読むので塗らない） */
export const SHADE_MIN_ZOOM = 13;
const RETRY_MS = 15000; // 標高が取れなかったタイルを読み直すまでの時間

/**
 * 地図のタイル (z, x, y) を塗るのに要る標高タイル（z15）の番号の一覧と、画素の換算。
 * z が 15 以上なら1枚、14 なら 2×2 枚、13 なら 4×4 枚
 */
export function demTilesFor(z, x, y) {
  const f = 2 ** (DEM_Z - z); // 地図の1画素が、標高タイルの何画素か
  const gx0 = x * 256 * f, gy0 = y * 256 * f; // このタイルの左上（標高タイル z15 の全体画素）
  const span = 256 * f;
  const tiles = [];
  for (let ty = Math.floor(gy0 / 256); ty <= Math.floor((gy0 + span - 1e-9) / 256); ty++) {
    for (let tx = Math.floor(gx0 / 256); tx <= Math.floor((gx0 + span - 1e-9) / 256); tx++) tiles.push([tx, ty]);
  }
  return { f, gx0, gy0, tiles };
}

/**
 * 地図に重ねる層を作る。setBase(標高, 幅) で基準（ティーの高さ）と色を変える幅 [m] を決めると塗り直す。基準が無いあいだは何も塗らない
 * 長いホールを小さな地図に収めて縮尺が引いても塗れるよう、拡大率 13 まで（標高タイルを何枚かつないで）塗る。
 * 圏外などで標高が取れなかったタイルは、しばらくして読み直す
 */
export function createElevShadeLayer() {
  const Layer = L.GridLayer.extend({
    options: { tileSize: 256, minZoom: SHADE_MIN_ZOOM, maxZoom: 22, opacity: 1, zIndex: 2, updateWhenIdle: true, keepBuffer: 1 },
    initialize(options) {
      L.setOptions(this, options);
      this._base = null;
      this._step = 2;
    },
    setBase(elev, step = 2) {
      const v = Number.isFinite(elev) ? elev : null;
      if (v === this._base && step === this._step) return this;
      this._base = v;
      this._step = step;
      // ホールを開いた直後は、ティー・グリーンの標高が続けて届く。塗り直しは少し待って1回にまとめる
      this._scheduleRedraw(250);
      return this;
    },
    onRemove(map) {
      clearTimeout(this._redrawTimer);
      L.GridLayer.prototype.onRemove.call(this, map);
    },
    _scheduleRedraw(ms) {
      clearTimeout(this._redrawTimer);
      this._redrawTimer = setTimeout(() => this.redraw(), ms);
    },
    // Leaflet の redraw は地図の拡大率を整数に丸めずにタイルを作る（17.25 などの中途半端な拡大率だと、
    // ありえない番号のタイルになって塗れない）。丸めてから作り直す _setView を使う
    redraw() {
      if (!this._map) return this;
      this._removeAllTiles();
      this._tileZoom = undefined;
      this._setView(this._map.getCenter(), this._map.getZoom());
      return this;
    },
    _alive(coords, canvas, base, step) {
      return this._base === base && this._step === step && this._tiles[this._tileCoordsToKey(coords)]?.el === canvas;
    },
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const base = this._base, step = this._step;
      if (base == null || coords.z < SHADE_MIN_ZOOM) { setTimeout(() => done(null, canvas), 0); return canvas; }
      const { f, gx0, gy0, tiles } = demTilesFor(coords.z, coords.x, coords.y);
      Promise.allSettled(tiles.map(([tx, ty]) => loadDemGrid(DEM_Z, tx, ty))).then((rs) => {
        // 塗っている間に基準が変わった・画面から外れた・作り直されたタイルは、計算も「読み込み済み」の知らせもしない
        if (!this._alive(coords, canvas, base, step)) return;
        const grids = new Map();
        let failed = false;
        rs.forEach((r, k) => { if (r.status === 'fulfilled') grids.set(tiles[k].join('/'), r.value); else failed = true; });
        if (failed) this._scheduleRedraw(RETRY_MS); // 電波が戻ったら塗れるよう、しばらくして読み直す
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(256, 256);
        const a = Math.round(SHADE_ALPHA * 255);
        for (let y = 0; y < 256; y++) {
          const gy = gy0 + (y + 0.5) * f - 0.5;
          const ty = Math.floor((gy + 0.5) / 256);
          for (let x = 0; x < 256; x++) {
            const gx = gx0 + (x + 0.5) * f - 0.5;
            const tx = Math.floor((gx + 0.5) / 256);
            const grid = grids.get(`${tx}/${ty}`);
            if (!grid) continue;
            const e = sampleGrid(grid, gx - tx * 256, gy - ty * 256);
            const col = bandColor(shadeBand(e - base, step));
            if (!col) continue;
            const i = (y * 256 + x) * 4;
            img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = a;
          }
        }
        ctx.putImageData(img, 0, 0);
        done(null, canvas);
      });
      return canvas;
    },
  });
  return new Layer();
}
