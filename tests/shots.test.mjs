// ショット地点の記録と、番手ごとの飛距離
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShot, holeShots, removeLastShot, shotDistances, clubStats, isShot, importShots, loadShots, CLUBS, loadBag, saveBag, normalizeBag, normalizeClubName } from '../js/shots.js';
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

test('番手の名前は自由（空白・制御文字を除き8文字まで）。読み込む記録は形を確かめる', () => {
  const list = addShot([], { ...at, ll: north(0), club: '  52°ウェッジ長い名前 ', t: 1 });
  assert.equal(list[0].club, '52°ウェッジ長'); // 8文字まで
  assert.ok(isShot(list[0]));
  assert.ok(CLUBS.includes('7I'));
  assert.ok(!isShot({ ...list[0], ll: [999, 0] }));
  assert.ok(!isShot({ ...list[0], club: 'あ'.repeat(20) })); // 長すぎる
  assert.ok(!isShot({ ...list[0], club: 5 }));
  assert.ok(!isShot({ ...list[0], date: 'abc' }));
  assert.ok(isShot({ ...list[0], club: '' }));             // 番手なし
});

test('番手の設定: 空・重複を除き、無ければ初めの並び。集計は設定の並び順', () => {
  fakeStorage();
  try {
    assert.deepEqual(loadBag(), CLUBS);
    assert.ok(saveBag(['1W', ' 1W', '', '52°', 'UT', '1W']));
    assert.deepEqual(loadBag(), ['1W', '52°', 'UT']);
    assert.deepEqual(normalizeBag(Array.from({ length: 40 }, (_, k) => `c${k}`)).length, 24);
    saveBag([]);
    assert.deepEqual(loadBag(), CLUBS);                     // 空なら初めの並び
  } finally { delete globalThis.localStorage; }
  let list = [];
  const shot = (club, m, t) => { list = addShot(list, { ...at, round: `r${t}`, ll: north(0), club, t }); list = addShot(list, { ...at, round: `r${t}`, ll: north(m), club: '', t: t + 1 }); };
  shot('7I', 140, 10); shot('UT', 180, 20); shot('ZZ', 100, 30);
  assert.deepEqual(clubStats(list, ['UT', '7I']).map((x) => x.club), ['UT', '7I', 'ZZ']); // 設定に無い番手は後ろ
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

test('番手名の整え方は何度かけても同じ。見えない文字を除き、絵文字を途中で切らない', () => {
  for (const raw of ['1234567 8', ' 52° ', '1234567😀', 'a\u202eb\u200bc', '  ', 'あいうえおかきくけこ']) {
    const once = normalizeClubName(raw);
    assert.equal(normalizeClubName(once), once, raw);
  }
  assert.equal(normalizeClubName('1234567 8'), '1234567');
  assert.equal(normalizeClubName('1234567😀'), '1234567😀'); // 8文字目が絵文字でも丸ごと残る
  assert.equal(normalizeClubName('a\u202eb\u200bc'), 'abc');
  const shot = addShot([], { ...at, ll: north(0), club: '1234567 8', t: 1 })[0];
  assert.ok(isShot(shot)); // 保存した記録は確かめで弾かれない
});

test('おすすめの番手: 平均がいちばん近い番手。届かない・短すぎるときはそれと分かる', async () => {
  const { recommendClub } = await import('../js/shots.js');
  const stats = [
    { club: '1W', n: 5, avg: 210, max: 230 },
    { club: '7I', n: 4, avg: 135, max: 145 },
    { club: '8I', n: 2, avg: 125, max: 130 },
    { club: 'SW', n: 6, avg: 70, max: 80 },
    { club: 'PT', n: 9, avg: 8, max: 15 },
  ];
  assert.equal(recommendClub(stats, 133).club, '7I');
  assert.equal(recommendClub(stats, 133).kind, 'ok');
  assert.equal(recommendClub(stats, 130).club, '7I');           // 7I と 8I の真ん中なら長い番手
  assert.equal(recommendClub(stats, 126).club, '8I');
  assert.deepEqual([recommendClub(stats, 260).club, recommendClub(stats, 260).kind], ['1W', 'short']);
  assert.deepEqual([recommendClub(stats, 40).club, recommendClub(stats, 40).kind], ['SW', 'soft']); // PT は使わない
  assert.equal(recommendClub(stats, 180, ['1W', 'SW']).club, '1W');   // 設定にある番手だけ（7I は使わない）
  assert.equal(recommendClub([], 133), null);
  assert.equal(recommendClub(stats, null), null);
});

test('番手の飛距離の設定: 設定した番手はその距離、無い番手は記録の平均でおすすめする', async () => {
  const { recoSources, normalizeClubDist, recommendClub } = await import('../js/shots.js');
  assert.deepEqual(normalizeClubDist({ '7I': '150', ' 9I ': 125.4, PW: 0, SW: 999, 'x': 'abc' }), { '7I': 150, '9I': 125 });
  assert.deepEqual(normalizeClubDist(null), {});
  const stats = [{ club: '7I', n: 4, avg: 120, max: 130 }, { club: '9I', n: 3, avg: 100, max: 110 }]; // 記録 [m]
  const src = recoSources(stats, { '7I': 150 }, ['1W', '7I', '9I']);   // 1W は設定も記録も無い
  assert.deepEqual(src.map((s) => [s.club, s.src]), [['7I', 'set'], ['9I', 'rec']]);
  assert.ok(Math.abs(src[0].avg - 150 * 0.9144) < 1e-9);
  const r = recommendClub(src, 150 * 0.9144);
  assert.deepEqual([r.club, r.src], ['7I', 'set']);
  assert.deepEqual([recommendClub(src, 100).club, recommendClub(src, 100).src], ['9I', 'rec']);
  assert.equal(recommendClub(recoSources([], {}, ['7I']), 100), null);   // 設定も記録も無ければ出さない
});

test('番手の飛距離の入力: 全角数字も読み、読めない入力は null（設定を消さない）', async () => {
  const { parseYards, recoSources } = await import('../js/shots.js');
  assert.equal(parseYards('150'), 150);
  assert.equal(parseYards('１５０'), 150);
  assert.equal(parseYards(' 150.4 '), 150);
  assert.equal(parseYards(''), '');
  assert.equal(parseYards('  '), '');
  assert.equal(parseYards('1e'), null);
  assert.equal(parseYards('--'), null);
  assert.equal(parseYards('-5'), null);
  // 番手名が toString でも、設定していなければ「設定あり」にしない
  assert.deepEqual(recoSources([], {}, ['toString', 'valueOf']), []);
});
