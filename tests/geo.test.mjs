// 実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceM, toYards, bearingDeg, lineIntersections, nearestPointOnPolygon,
  greenDistances, hazardDistances, hazardsAhead, elevationDiff, playsLikeM, pinPoint, PIN_POS, transformPoints,
} from '../js/geo.js';

// 緯度35度付近で、北へ1m ≒ 緯度 1/111195 度
const LAT = 35.0, LNG = 139.0;
const north = (m, e = 0) => [LAT + m / 111194.9, LNG + e / (111194.9 * Math.cos(LAT * Math.PI / 180))];
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b} (±${tol})`);

test('距離: 北へ100m', () => near(distanceM(north(0), north(100)), 100));
test('距離: 東へ150m', () => near(distanceM(north(0), north(0, 150)), 150));
test('ヤード換算', () => near(toYards(91.44), 100, 1e-9));
test('方位: 北=0・東=90', () => {
  near(bearingDeg(north(0), north(100)), 0, 0.1);
  near(bearingDeg(north(0), north(0, 100)), 90, 0.1);
});

// 中心が北150m、一辺20mの正方形グリーン
const greenSq = [north(140, -10), north(140, 10), north(160, 10), north(160, -10)];

test('直線と多角形の交点: 前140m・奥160m', () => {
  const hits = lineIntersections(north(0), north(150), greenSq);
  assert.equal(hits.length, 2);
  near(distanceM(north(0), hits[0]), 140);
  near(distanceM(north(0), hits[1]), 160);
});

test('多角形の最近点', () => {
  near(distanceM(north(0), nearestPointOnPolygon(north(0), greenSq)), 140);
});

test('グリーン距離: 多角形あり', () => {
  const d = greenDistances(north(0), { center: north(150), polygon: greenSq });
  near(d.front, 140); near(d.center, 150); near(d.back, 160);
});

test('グリーン距離: 多角形なし（登録点）', () => {
  const d = greenDistances(north(0), { center: north(150), front: north(138), back: north(162), polygon: null });
  near(d.front, 138); near(d.back, 162);
});

test('ハザード距離: 1点・2点・多角形', () => {
  assert.deepEqual(Object.keys(hazardDistances(north(0), { points: [north(80)] })), ['reach', 'carry']);
  assert.equal(hazardDistances(north(0), { points: [north(80)] }).carry, null);
  const two = hazardDistances(north(0), { points: [north(80), north(95)] });
  near(two.reach, 80); near(two.carry, 95);
  const poly = hazardDistances(north(0), { polygon: [north(100, -5), north(100, 5), north(110, 5), north(110, -5)] });
  near(poly.reach, 100); near(poly.carry, 110.1); // 奥の角まで
  assert.equal(hazardDistances(north(0), { points: [] }), null);
});

test('前方のハザードだけを近い順に返す', () => {
  const hz = [
    { label: '奥', points: [north(120)] },
    { label: '後ろ', points: [north(-30)] },
    { label: '手前', points: [north(60)] },
  ];
  const r = hazardsAhead(north(0), hz, north(150));
  assert.deepEqual(r.map((x) => x.hazard.label), ['手前', '奥']);
});

test('高低差', () => {
  assert.equal(elevationDiff(150, 158), 8);
  assert.equal(elevationDiff(null, 158), null);
});

test('横に長い池: 越えはグリーン方向に横切る距離（遠い角までではない）', () => {
  // 北100〜110m、東西に ±100m 広がる池。グリーンは真北150m
  const pond = { polygon: [north(100, -100), north(100, 100), north(110, 100), north(110, -100)] };
  const d = hazardDistances(north(0), pond, north(150));
  near(d.reach, 100);
  near(d.carry, 110); // 角までだと約149m になってしまう
});

test('長いOB: 中心が後ろでも、前に続いていれば一覧に残る', () => {
  // 右側に南-50m〜北140m まで続くOB（重心は北45m付近）。現在地は北60m
  const ob = { label: '右OB', points: [], polygon: [north(-50, 40), north(140, 40), north(140, 45), north(-50, 45)] };
  const r = hazardsAhead(north(60), [ob], north(150));
  assert.equal(r.length, 1);
});

test('線のハザード（OBライン）: 最短距離のみ、越えは出さない', () => {
  // 右 30m に南北へ伸びる OB ライン
  const ob = { type: 'ob', label: '右OB', points: [], line: [north(-50, 30), north(200, 30)] };
  const d = hazardDistances(north(0), ob, north(150));
  near(d.reach, 30);
  assert.equal(d.carry, null);
  assert.equal(hazardsAhead(north(0), [ob], north(150)).length, 1);
  // 後ろだけにある線は出さない
  const behind = { type: 'ob', label: '後ろ', points: [], line: [north(-80, 30), north(-20, 30)] };
  assert.equal(hazardsAhead(north(0), [behind], north(150)).length, 0);
});

test('コース範囲(bbox)からの距離（下見モードの判定に使う）', async () => {
  const { distanceToBbox } = await import('../js/geo.js');
  const bbox = [LAT, LNG, north(200)[0], north(0, 200)[1]]; // 南西角から北・東へ 200m
  assert.equal(distanceToBbox(north(100, 100), bbox), 0); // 内側
  near(distanceToBbox(north(300, 100), bbox), 100); // 北に 100m はみ出し
  near(distanceToBbox(north(-1000, 100), bbox), 1000); // 南に 1km
});

test('実質の距離: 打ち上げは長く、打ち下ろしは短く（高さ1mにつき1m）', () => {
  assert.equal(playsLikeM(150, 10), 160);
  assert.equal(playsLikeM(150, -25), 125);
  assert.equal(playsLikeM(20, -30), 0);   // マイナスにはしない
  assert.equal(playsLikeM(150, null), null);
  assert.equal(playsLikeM(null, 5), null);
});

test('ピン位置: グリーンの前端から奥端までの 1/4・1/2・3/4 の点', () => {
  // 北へ 100〜130m にある四角いグリーン（緯度 1度 ≒ 111,195m）
  const y = (m) => 36.35 + m / 111195;
  const green = { center: [y(115), 139.33], polygon: [[y(100), 139.3297], [y(100), 139.3303], [y(130), 139.3303], [y(130), 139.3297]] };
  const pos = [36.35, 139.33];
  assert.ok(Math.abs(pinPoint(pos, green, PIN_POS.front).dist - 107.5) < 0.5);
  assert.ok(Math.abs(pinPoint(pos, green, PIN_POS.mid).dist - 115) < 0.5);
  assert.ok(Math.abs(pinPoint(pos, green, PIN_POS.back).dist - 122.5) < 0.5);
  // 形が無ければ登録された前・奥の点、どちらも無ければ null
  assert.ok(Math.abs(pinPoint(pos, { center: green.center, front: [y(102), 139.33], back: [y(126), 139.33] }, 0.5).dist - 114) < 0.5);
  assert.equal(pinPoint(pos, { center: green.center }, 0.5), null);
  // グリーンの奥（北 140m）から打つときも、ティーの向きで決めたピンは動かない（手前ピン = 北 107.5m の点）
  const behind = [y(140), 139.33];
  assert.ok(Math.abs(pinPoint(behind, green, PIN_POS.front, pos).dist - 32.5) < 0.5);
});

test('点をまとめて移動・回転する（中心まわりに右回り、東へ dx・北へ dy）', () => {
  const pivot = [36.35, 139.33];
  const north10 = [36.35 + 10 / 111195, 139.33]; // 中心の 10m 北
  // 東へ 3m・北へ 4m 動かすと、中心からの距離は 5m
  const [m] = transformPoints([pivot], { dx: 3, dy: 4, pivot });
  assert.ok(Math.abs(distanceM(pivot, m) - 5) < 0.01);
  // 右回りに 90° 回すと、北 10m の点は東 10m に来る
  const [r] = transformPoints([north10], { rotDeg: 90, pivot });
  assert.ok(Math.abs(r[0] - pivot[0]) < 1e-7);
  assert.ok(r[1] > pivot[1]);
  assert.ok(Math.abs(distanceM(pivot, r) - 10) < 0.01);
  // 回転しても形の大きさは変わらない（2点の間の距離が同じ）
  const a = [36.351, 139.331], b = [36.3515, 139.3318];
  const [a2, b2] = transformPoints([a, b], { rotDeg: 37, dx: -12, dy: 5, pivot });
  assert.ok(Math.abs(distanceM(a, b) - distanceM(a2, b2)) < 0.01);
  // 元の点は変えない
  assert.deepEqual(north10, [36.35 + 10 / 111195, 139.33]);
});
