// 2グリーン対応（データの移行・使うグリーンの選び方・グリーン専用ハザード）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCourse, greenNames, pickGreen, usableGreens, isHoleRegistered } from '../js/store.js';
import { hazardsAhead, greenDistances } from '../js/geo.js';

const LAT = 35.0, LNG = 139.0;
const pt = (n, e = 0) => [LAT + n / 111194.9, LNG + e / (111194.9 * Math.cos(LAT * Math.PI / 180))];

const course = (holes, extra = {}) => ({
  schemaVersion: 1, id: 't', name: 'テスト', ...extra,
  nines: [{ id: 'out', name: 'OUT', holes }],
});

test('旧形式（green 1つ）は greens に移り、最初の呼び名が付く', () => {
  const c = validateCourse(course([{ no: 1, green: { center: pt(150), front: null, back: null, polygon: null } }], { greenNames: ['ベント', '高麗'] }));
  const h = c.nines[0].holes[0];
  assert.equal(h.green, undefined);
  assert.equal(h.greens.length, 1);
  assert.equal(h.greens[0].name, 'ベント');
  assert.ok(isHoleRegistered(h));
});

test('呼び名が未設定なら A・B', () => {
  assert.deepEqual(greenNames(course([])), ['A', 'B']);
  const c = validateCourse(course([{ no: 1, green: null }]));
  assert.deepEqual(c.nines[0].holes[0].greens, []);
  assert.equal(isHoleRegistered(c.nines[0].holes[0]), false);
});

test('不正な呼び名・名前の無いグリーンは読み込まない', () => {
  assert.throws(() => validateCourse(course([], { greenNames: [] })));
  assert.throws(() => validateCourse(course([{ no: 1, greens: [{ center: pt(1) }] }])));
});

const twoGreen = {
  no: 1,
  greens: [
    { name: 'ベント', center: pt(150, -20), front: null, back: null, polygon: null },
    { name: '高麗', center: pt(150, 20), front: null, back: null, polygon: null },
  ],
  hazards: [
    { type: 'bunker', label: '左のガード', green: 'ベント', points: [pt(140, -30)] },
    { type: 'bunker', label: '右のガード', green: '高麗', points: [pt(140, 30)] },
    { type: 'water', label: '池', points: [pt(80)] },
  ],
};

test('使うグリーンの選び方', () => {
  assert.equal(pickGreen(twoGreen, '高麗').name, '高麗');
  assert.equal(pickGreen(twoGreen, 'ベント').name, 'ベント');
  assert.equal(pickGreen(twoGreen, '無い名前').name, 'ベント'); // 最初の登録済みグリーン
  const one = { greens: [{ name: '高麗', center: pt(100) }] };
  assert.equal(pickGreen(one, 'ベント').name, '高麗'); // 1グリーンのホールはそのグリーン
  assert.equal(pickGreen({ greens: [{ name: 'A', center: null }] }, 'A'), null); // 中央が無いと使えない
  assert.equal(usableGreens(twoGreen).length, 2);
});

test('グリーンを切り替えると距離が変わる', () => {
  const a = greenDistances(pt(0), pickGreen(twoGreen, 'ベント'));
  const b = greenDistances(pt(0), pickGreen(twoGreen, '高麗'));
  assert.ok(Math.abs(a.center - b.center) < 0.5); // 左右対称なので同じ距離
  assert.ok(a.center > 150);
});

test('別のグリーン専用のハザードは出さない', () => {
  const g = pickGreen(twoGreen, 'ベント');
  const labels = hazardsAhead(pt(0), twoGreen.hazards, g.center, g.name).map((x) => x.hazard.label);
  assert.deepEqual(labels, ['池', '左のガード']);
  const k = pickGreen(twoGreen, '高麗');
  assert.deepEqual(hazardsAhead(pt(0), twoGreen.hazards, k.center, k.name).map((x) => x.hazard.label), ['池', '右のガード']);
});

test('太田双葉のデータはベント・高麗の2グリーン形式', () => {
  const c = validateCourse(JSON.parse(readFileSync(new URL('../courses/ota-futaba.json', import.meta.url), 'utf8')));
  assert.deepEqual(greenNames(c), ['ベント', '高麗']);
  for (const n of c.nines) for (const h of n.holes) assert.ok(Array.isArray(h.greens));
});

test('v0.1 の書き出しファイル（呼び名なし）は公開版の呼び名で移行し、名前がずれない', () => {
  const c = validateCourse(course([{ no: 1, green: { center: pt(150) } }]), { fallbackNames: ['ベント', '高麗'] });
  assert.deepEqual(c.greenNames, ['ベント', '高麗']);
  assert.deepEqual(c.nines[0].holes[0].greens.map((g) => g.name), ['ベント']);
});

test('green と greens が両方ある（旧アプリで編集した）データでも、登録を捨てない', () => {
  const c = validateCourse(course([{ no: 1, green: { center: pt(150) }, greens: [] }], { greenNames: ['ベント', '高麗'] }));
  assert.deepEqual(c.nines[0].holes[0].greens.map((g) => g.name), ['ベント']);
  const d = validateCourse(course([{ no: 1, green: { center: pt(150) }, greens: [{ name: '高麗', center: pt(150, 30) }] }], { greenNames: ['ベント', '高麗'] }));
  assert.deepEqual(d.nines[0].holes[0].greens.map((g) => g.name), ['ベント', '高麗']);
});

test('使われているのに呼び名一覧に無い名前は一覧に足す', () => {
  const c = validateCourse(course([{ no: 1, greens: [{ name: 'A', center: pt(1) }], hazards: [{ label: 'x', points: [pt(1)], green: '左' }] }], { greenNames: ['ベント', '高麗'] }));
  assert.deepEqual(c.greenNames, ['ベント', '高麗', 'A', '左']);
});

test('呼び名の重複・1ホール内のグリーン名の重複は読み込まない', () => {
  assert.throws(() => validateCourse(course([], { greenNames: ['A', 'A'] })));
  assert.throws(() => validateCourse(course([{ no: 1, greens: [{ name: 'A', center: pt(1) }, { name: 'A', center: pt(2) }] }])));
});

test('端末内の古いデータより公開版が新しければ知らせる（revision で判定）', async () => {
  const { loadCourse } = await import('../js/store.js');
  const mem = {};
  globalThis.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; }, key: (i) => Object.keys(mem)[i], get length() { return Object.keys(mem).length; },
  };
  const published = course([{ no: 1, greens: [{ name: 'A', center: pt(100) }] }], { revision: 2, updated: '2026-10-13' });
  globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(published)) });
  // v0.1 の頃に保存した端末内データ（revision 無し、同じ日付）
  mem['golfnavi.course.t'] = JSON.stringify(course([{ no: 1, green: null }], { updated: '2026-10-13' }));
  const old = await loadCourse('t');
  assert.ok(old.__local);
  assert.ok(old.__publishedNewer, '同じ日付でも revision が古ければ知らせる');
  // 新しい公開版をもとに編集した端末内データ（revision 2）なら知らせない
  mem['golfnavi.course.t'] = JSON.stringify(course([{ no: 1, greens: [{ name: 'A', center: pt(90) }] }], { revision: 2 }));
  const cur = await loadCourse('t');
  assert.equal(cur.__publishedNewer, undefined);
  delete globalThis.localStorage; delete globalThis.fetch;
});

test('公開データに revision がある', () => {
  const c = JSON.parse(readFileSync(new URL('../courses/ota-futaba.json', import.meta.url), 'utf8'));
  assert.ok(Number.isInteger(c.revision) && c.revision >= 2);
});
