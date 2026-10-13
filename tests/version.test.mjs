// 画面の版（js/version.js）と Service Worker の版（sw.js）がずれていないか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { APP_VERSION } from '../js/version.js';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('sw.js の VERSION が js/version.js と同じ', () => {
  const m = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'sw.js に VERSION がありません');
  assert.equal(m[1], APP_VERSION);
});

test('sw.js が事前保存するファイルがすべて存在する', () => {
  const list = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((f) => f !== './');
  assert.ok(list.length > 10);
  for (const f of list) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} がありません`);
});

test('タイル保存の名前が sw.js と mapbase.js で同じ', () => {
  const mb = readFileSync(new URL('../js/mapbase.js', import.meta.url), 'utf8');
  const a = sw.match(/TILE_CACHE = '([^']+)'/)[1];
  const b = mb.match(/TILE_CACHE = '([^']+)'/)[1];
  assert.equal(a, b);
});

test('画面のファイルを変えたら版を上げている（npm run bump）', async () => {
  const { appHash, readLock } = await import('../tools/release.mjs');
  const lock = readLock();
  assert.equal(lock.version, APP_VERSION, 'version-lock.json の版が js/version.js と違います。npm run bump を実行してください');
  assert.equal(appHash(), lock.hash, '画面のファイルが変わったのに版が上がっていません。npm run bump を実行してください');
});
