// 標高タイルの読み方（ブラウザ依存部分を除いた計算）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDemRGB, tilePixel } from '../js/elev.js';
import { courseTileUrls, tilesInBbox } from '../js/mapbase.js';
import { roundHoles, validateCourse } from '../js/store.js';
import { readFileSync } from 'node:fs';

test('標高の色の読み方（国土地理院の仕様どおり）', () => {
  assert.equal(decodeDemRGB(128, 0, 0), null); // 無効値
  assert.equal(decodeDemRGB(0, 0, 0), 0);
  assert.ok(Math.abs(decodeDemRGB(0, 39, 246) - 102.3) < 1e-9); // 10230 × 0.01
  assert.ok(Math.abs(decodeDemRGB(255, 255, 255) - -0.01) < 1e-9); // 負の値
});

test('タイル番号（東京駅付近 z15 は既知の値）', () => {
  const t = tilePixel(35.681236, 139.767125, 15);
  assert.deepEqual([t.x, t.y], [29105, 12903]);
  assert.ok(t.px >= 0 && t.px < 256 && t.py >= 0 && t.py < 256);
});

const course = JSON.parse(readFileSync(new URL('../courses/ota-futaba.json', import.meta.url), 'utf8'));

test('太田双葉CCのデータが形式に合っている', () => {
  validateCourse(course);
  assert.equal(course.nines.length, 3);
  assert.deepEqual(course.nines.map((n) => n.holes.length), [9, 9, 9]);
});

test('ラウンドの並び（前半・後半で18ホール）', () => {
  const r = roundHoles(course, ['tenno', 'atago']);
  assert.equal(r.length, 18);
  assert.equal(r[0].nine.name, '天王');
  assert.equal(r[9].nine.name, '愛宕');
  assert.equal(r[9].hole.no, 1);
});

test('地図保存の枚数が常識的な範囲（サーバー負荷の確認）', () => {
  assert.ok(tilesInBbox(course.bbox, 18).length > 50);
  const n = courseTileUrls(course.bbox).length;
  assert.ok(n > 100 && n < 600, `${n} 枚`);
});
