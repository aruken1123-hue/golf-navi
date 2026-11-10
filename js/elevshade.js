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

/**
 * 地図に重ねる層を作る。setBase(標高, 幅) で基準（ティーの高さ）と色を変える幅 [m] を決めると塗り直す。基準が無いあいだは何も塗らない
 * 拡大率 15 未満（コースより広い範囲）では塗らない（標高タイルを何枚も読まないように）
 */
export function createElevShadeLayer() {
  const Layer = L.GridLayer.extend({
    options: { tileSize: 256, minZoom: DEM_Z, maxZoom: 22, opacity: 1, zIndex: 2, updateWhenIdle: true, keepBuffer: 1 },
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
      clearTimeout(this._redrawTimer);
      this._redrawTimer = setTimeout(() => { if (this._map) this.redraw(); }, 250);
      return this;
    },
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const base = this._base, step = this._step;
      if (base == null || coords.z < DEM_Z) { setTimeout(() => done(null, canvas), 0); return canvas; }
      const scale = 2 ** (coords.z - DEM_Z); // 標高タイル1枚が、この拡大率で何枚分か
      const tx = Math.floor(coords.x / scale), ty = Math.floor(coords.y / scale);
      const ox = (coords.x - tx * scale) * (256 / scale), oy = (coords.y - ty * scale) * (256 / scale);
      loadDemGrid(DEM_Z, tx, ty).then((grid) => {
        // 塗っている間に基準が変わった・画面から外れた・作り直されたタイルは、計算も「読み込み済み」の知らせもしない
        if (this._base !== base || this._step !== step || this._tiles[this._tileCoordsToKey(coords)]?.el !== canvas) return;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(256, 256);
        const a = Math.round(SHADE_ALPHA * 255);
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) {
            const e = sampleGrid(grid, ox + (x + 0.5) / scale - 0.5, oy + (y + 0.5) / scale - 0.5);
            const col = bandColor(shadeBand(e - base, step));
            if (!col) continue;
            const i = (y * 256 + x) * 4;
            img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = a;
          }
        }
        ctx.putImageData(img, 0, 0);
        done(null, canvas);
      }, () => { if (this._tiles[this._tileCoordsToKey(coords)]?.el === canvas) done(null, canvas); }); // 圏外などで標高が取れない所は塗らない
      return canvas;
    },
  });
  return new Layer();
}
