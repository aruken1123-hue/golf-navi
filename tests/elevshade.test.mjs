// 高低差の色分け（色を変える幅・段の決め方・色・凡例・標高の補い方）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadeStepFor, shadeBand, bandColor, legendRows, sampleGrid, UP_COLORS, DOWN_COLORS, SHADE_LEVELS } from '../js/elevshade.js';

test('色を変える幅は、ホールの高低差が5段ほどに収まるいちばん細かい幅', () => {
  assert.equal(shadeStepFor(0), 1);
  assert.equal(shadeStepFor(3), 1);    // 平らなショートコース
  assert.equal(shadeStepFor(5), 1);
  assert.equal(shadeStepFor(8), 2);
  assert.equal(shadeStepFor(-14), 3);  // 打ち下ろし（符号は見ない）
  assert.equal(shadeStepFor(25), 5);   // 山のコース（太田双葉 愛宕1番は約25m 打ち下ろし）
  assert.equal(shadeStepFor(26.5), 5);
  assert.equal(shadeStepFor(48), 10);
  assert.equal(shadeStepFor(200), 10); // それ以上は 10m で頭打ち
  assert.equal(shadeStepFor(NaN), 1);
});

test('段は幅の何倍に近いかで決まり、幅の半分未満は塗らない', () => {
  assert.equal(shadeBand(0, 2), 0);
  assert.equal(shadeBand(0.99, 2), 0);
  assert.equal(shadeBand(1, 2), 1);
  assert.equal(shadeBand(2.9, 2), 1);
  assert.equal(shadeBand(3, 2), 2);
  assert.equal(shadeBand(-5.5, 2), -3);
  assert.equal(shadeBand(-24, 5), -5);
  assert.equal(shadeBand(40, 2), SHADE_LEVELS);   // いちばん上の段はそれ以上をまとめる
  assert.equal(shadeBand(-40, 2), -SHADE_LEVELS);
});

test('標高が取れない所（NaN）は塗らない', () => {
  assert.equal(shadeBand(NaN, 2), 0);
  assert.equal(shadeBand(Infinity, 2), 0);
  assert.equal(bandColor(0), null);
});

test('高い所は赤系、低い所は青系の色になる', () => {
  const [r1, , b1] = bandColor(3);
  assert.ok(r1 > b1, '高い所は赤が強い');
  const [r2, , b2] = bandColor(-3);
  assert.ok(b2 > r2, '低い所は青が強い');
  assert.equal(bandColor(UP_COLORS.length).length, 3);
  assert.equal(bandColor(-DOWN_COLORS.length).length, 3);
});

test('凡例は低い→同じくらい→高いの順で、ラベルは幅の倍数', () => {
  const rows = legendRows(5);
  assert.equal(rows.length, SHADE_LEVELS * 2 + 1);
  assert.equal(rows[0].color, DOWN_COLORS[SHADE_LEVELS - 1]);
  assert.equal(rows[0].label, '−30m〜');
  assert.equal(rows[SHADE_LEVELS].color, null);
  assert.equal(rows[SHADE_LEVELS + 1].label, '+5m');
  assert.equal(rows[rows.length - 1].label, '+30m〜');
});

test('標高の格子から、間の値を4点の重みで補う（端は切り詰め、NaN は NaN）', () => {
  const g = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) g[y * 256 + x] = x + 1000 * y;
  assert.equal(sampleGrid(g, 10, 20), 10 + 20000);
  assert.ok(Math.abs(sampleGrid(g, 10.5, 20.25) - (10.5 + 20250)) < 1e-3);
  assert.equal(sampleGrid(g, -5, -5), 0);                 // 左上の外
  assert.equal(sampleGrid(g, 300, 300), 255 + 255000);    // 右下の外
  g[5 * 256 + 5] = NaN;
  assert.ok(Number.isNaN(sampleGrid(g, 5.5, 5.5)));
});
