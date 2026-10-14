// ショット地点の記録と、番手ごとの飛距離
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShot, holeShots, removeLastShot, shotDistances, clubStats, isShot, importShots, loadShots, CLUBS } from '../js/shots.js';
import { distanceM } from '../js/geo.js';

const at = { date: '2026-10-14', courseId: 'ota', round: 'card-1', hole: '1:atago-1' };
// 北へ m メートル進んだ点（緯度 1度 ≒ 111,195m）
const north = (m) => [36.35 + m / 111195, 139.33];

function fakeStorage() {
  const mem = {};
  globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  return mem;
}

test('同じホールで続けて記録した2地点の距離が、前の地点の番手の飛距離になる', () => {
  let list = [];
  list = addShot(list, { ...at, ll: north(0), club: '1W', t: 1 });
  list = addShot(list, { ...at, ll: north(200), club: '7I', t: 2 });
  list = addShot(list, { ...at, ll: north(340), club: 'PW', t: 3 });
  list = addShot(list, { ...at, hole: '2:atago-2', ll: north(1000), club: '5I', t: 4 }); // 別のホールにはつながらない
  const d = shotDistances(list);
  assert.equal(d.length, 2);
  assert.equal(d[0].club, '1W');
  assert.ok(Math.abs(d[0].m - 200) < 0.5);
  assert.equal(d[1].club, '7I');
  assert.ok(Math.abs(d[1].m - 140) < 0.5);
  assert.equal(holeShots(list, at).length, 3);
});

test('番手ごとの平均と最大（番手なし・範囲外は入れない）', () => {
  let list = [];
  const round = (date, m7) => {
    list = addShot(list, { date, courseId: 'ota', round: date, hole: '1:h1', ll: north(0), club: '7I', t: Date.parse(`${date}T10:00:00`) });
    list = addShot(list, { date, courseId: 'ota', round: date, hole: '1:h1', ll: north(m7), club: '', t: Date.parse(`${date}T10:05:00`) });
    list = addShot(list, { date, courseId: 'ota', round: date, hole: '1:h1', ll: north(m7 + 3), club: '', t: Date.parse(`${date}T10:06:00`) });
  };
  round('2026-10-01', 140);
  round('2026-10-02', 150);
  list = addShot(list, { date: '2026-10-03', courseId: 'ota', round: 'r3', hole: '1:h1', ll: north(0), club: '7I', t: 1 });
  list = addShot(list, { date: '2026-10-03', courseId: 'ota', round: 'r3', hole: '1:h1', ll: north(900), club: '', t: 2 }); // 押し忘れ（900m）
  const s = clubStats(list);
  assert.deepEqual(s.map((x) => x.club), ['7I']);
  assert.equal(s[0].n, 2);
  assert.ok(Math.abs(s[0].avg - 145) < 0.5);
  assert.ok(Math.abs(s[0].max - 150) < 0.5);
});

test('最後の記録の取り消しは、そのホールの最後の1つだけ', () => {
  let list = [];
  list = addShot(list, { ...at, ll: north(0), club: '1W', t: 1 });
  list = addShot(list, { ...at, ll: north(200), club: '7I', t: 2 });
  list = addShot(list, { ...at, hole: '2:atago-2', ll: north(500), club: '1W', t: 3 });
  list = removeLastShot(list, at);
  assert.deepEqual(holeShots(list, at).map((s) => s.club), ['1W']);
  assert.equal(list.length, 2);
  assert.equal(removeLastShot([], at).length, 0);
});

test('知らない番手は番手なしにし、読み込む記録は形を確かめる', () => {
  const list = addShot([], { ...at, ll: north(0), club: '<b>x</b>', t: 1 });
  assert.equal(list[0].club, '');
  assert.ok(isShot(list[0]));
  assert.ok(CLUBS.includes('7I'));
  assert.ok(!isShot({ ...list[0], ll: [999, 0] }));
  assert.ok(!isShot({ ...list[0], club: 'XX' }));
  assert.ok(!isShot({ ...list[0], date: 'abc' }));
});

test('バックアップの読み込み: 同じ記録は足さず、壊れた記録は飛ばす', () => {
  fakeStorage();
  try {
    const a = addShot([], { ...at, ll: north(0), club: '1W', t: 1 });
    const b = addShot(a, { ...at, ll: north(200), club: '7I', t: 2 });
    assert.deepEqual(importShots(a), { added: 1, noRoom: 0 });
    assert.deepEqual(importShots([...b, { id: 'x' }, null]), { added: 1, noRoom: 0 });
    assert.deepEqual(importShots(b), { added: 0, noRoom: 0 });
    assert.equal(loadShots().length, 2);
    assert.deepEqual(importShots('abc'), { added: 0, noRoom: 0 });
    assert.ok(Math.abs(distanceM(loadShots()[0].ll, loadShots()[1].ll) - 200) < 0.5);
  } finally { delete globalThis.localStorage; }
});

test('同じ日に同じコースを2回回っても、ラウンドが違えばショットはつながらない', () => {
  let list = [];
  const r1 = { ...at, round: 'card-1' }, r2 = { ...at, round: 'card-2' };
  list = addShot(list, { ...r1, ll: north(0), club: '1W', t: 1 });
  list = addShot(list, { ...r1, ll: north(230), club: 'PT', t: 2 });    // 1回目の最後（グリーン上）
  list = addShot(list, { ...r2, ll: north(0), club: '1W', t: 100 });    // 2回目のティー
  list = addShot(list, { ...r2, ll: north(210), club: '', t: 101 });
  const d = shotDistances(list);
  assert.deepEqual(d.map((x) => [x.club, Math.round(x.m)]), [['1W', 230], ['1W', 210]]);
  assert.equal(holeShots(list, r2).length, 2);
});

test('手で指定した位置の記録には印が付く', () => {
  const list = addShot([], { ...at, ll: north(0), club: '1W', manual: true, t: 1 });
  assert.equal(list[0].manual, true);
  assert.equal(addShot([], { ...at, ll: north(0), t: 1 })[0].manual, undefined);
});

test('バックアップの読み込みでは、今ある記録を押し出さない', async () => {
  const mem = fakeStorage();
  try {
    const { SHOTS_MAX } = await import('../js/shots.js');
    const mine = Array.from({ length: SHOTS_MAX }, (_, k) => ({ id: `m${k}`, t: k, date: '2026-01-01', courseId: 'ota', round: 'r', hole: '1:a', ll: [36, 139], acc: 5, club: '' }));
    mem['golfnavi.shots'] = JSON.stringify(mine);
    const extra = addShot([], { ...at, ll: north(0), t: 1e12 });
    assert.deepEqual(importShots(extra), { added: 0, noRoom: 1 });
    assert.equal(JSON.parse(mem['golfnavi.shots']).length, SHOTS_MAX);
  } finally { delete globalThis.localStorage; }
});
