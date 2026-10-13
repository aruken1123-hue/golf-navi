// GPS でのホール自動切り替えの判定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideAutoHole, newTracker, markManual, AUTO_HOLE } from '../js/autohole.js';
import { validateCourse, roundHoles, pickGreen } from '../js/store.js';

const LAT = 35.0, LNG = 139.0;
const pt = (n, e = 0) => [LAT + n / 111194.9, LNG + e / (111194.9 * Math.cos(LAT * Math.PI / 180))];
const tee = (p, name = 'レギュラー') => ({ name, pos: p });
// 1番: ティー(0,0)→グリーン(0,350)。2番: ティーは1番グリーンの横 (370, 20)。3番: ティーは1番ティーから60m横
const holes = [
  { hole: { tees: [tee(pt(0))] } },
  { hole: { tees: [tee(pt(370, 20))] } },
  { hole: { tees: [tee(pt(5, 60))] } },
];
const green1 = pt(350);
const at = (tr, pos, now, idx = 0, acc = 5, g = green1, hs = holes) =>
  decideAutoHole({ pos, acc, now, holes: hs, idx, currentGreen: g, tracker: tr });

test('次のティーに一定時間とどまったら切り替える', () => {
  const tr = newTracker();
  assert.equal(at(tr, pt(380, 20), 0), -1); // 着いた直後は待つ
  assert.equal(at(tr, pt(381, 20), AUTO_HOLE.DWELL_MS - 1), -1);
  assert.equal(at(tr, pt(381, 21), AUTO_HOLE.DWELL_MS + 1), 1);
});

test('次のホール以外のティーには切り替えない（済んだホール・先のホール）', () => {
  // 2番にいる状態で、済んだ1番のティーに立っても 1番には戻らない
  const tr = newTracker();
  assert.equal(at(tr, pt(0), 0, 1, 5, pt(700)), -1);
  assert.equal(at(tr, pt(0), 60000, 1, 5, pt(700)), -1);
  // 1番にいて、3番ティー（次の次）に立っても 3番には飛ばない
  const tr2 = newTracker();
  assert.equal(at(tr2, pt(5, 60), 0, 0), -1);
  assert.equal(at(tr2, pt(5, 60), 60000, 0), -1);
});

test('今のグリーンのほうが近い（パット中）なら切り替えない', () => {
  const hs = [holes[0], { hole: { tees: [tee(pt(365, 12))] } }];
  const tr = newTracker();
  assert.equal(at(tr, pt(352, 3), 0, 0, 5, green1, hs), -1);
  assert.equal(at(tr, pt(352, 3), 60000, 0, 5, green1, hs), -1);
  // ティーに立てば切り替わる（グリーンから 25m 以内のティーでも切替漏れしない）
  assert.equal(at(tr, pt(365, 12), 70000, 0, 5, green1, hs), -1);
  assert.equal(at(tr, pt(365, 12), 80000, 0, 5, green1, hs), 1);
});

test('バックティーなどレギュラー以外のティーでも切り替わる', () => {
  const hs = [holes[0], { hole: { tees: [tee(pt(420, 20)), tee(pt(470, 20), 'バック')] } }];
  const tr = newTracker();
  assert.equal(at(tr, pt(475, 20), 0, 0, 5, green1, hs), -1);
  assert.equal(at(tr, pt(475, 20), 9000, 0, 5, green1, hs), 1);
});

test('最終ホールの後は切り替えない', () => {
  const tr = newTracker();
  assert.equal(at(tr, pt(0), 0, 2), -1);
  assert.equal(at(tr, pt(0), 60000, 2), -1);
});

test('GPS の誤差が大きいときは判定せず、候補も消す', () => {
  const tr = newTracker();
  at(tr, pt(380, 20), 0); // 候補になる
  assert.equal(at(tr, pt(380, 20), 5000, 0, 80), -1); // 誤差大 → 候補を消す
  assert.equal(at(tr, pt(380, 20), 9000), -1); // ここから数え直し
  assert.equal(at(tr, pt(380, 20), 18000), 1);
});

test('手で選んだ後は60m以上動くまで止める。位置が無いときは次の良い位置を基準にする', () => {
  const tr = newTracker();
  markManual(tr, null); // 位置が取れていない状態で手で選んだ
  assert.equal(at(tr, pt(380, 20), 0), -1); // この位置が基準になる
  assert.equal(at(tr, pt(380, 20), 60000), -1);
  assert.ok(tr.manualAt);
  at(tr, pt(200), 70000); // 離れたら解除
  assert.equal(tr.manualAt, null);
});

test('実データ: 御所ノ入9番グリーン横の御所ノ入1番ティーで 1H に戻らない（御所ノ入→天王）', () => {
  const c = validateCourse(JSON.parse(readFileSync(new URL('../courses/ota-futaba.json', import.meta.url), 'utf8')));
  const hs = roundHoles(c, ['goshonoiri', 'tenno']);
  const g9 = pickGreen(hs[8].hole, 'ベント').center;
  const t1 = hs[0].hole.tees[0].pos; // 御所ノ入1番ティー（9番グリーンの近く）
  const tr = newTracker();
  assert.equal(at(tr, t1, 0, 8, 5, g9, hs), -1);
  assert.equal(at(tr, t1, 60000, 8, 5, g9, hs), -1);
  // 天王1番ティー（10H）に行けば切り替わる
  const tt1 = hs[9].hole.tees[0].pos;
  at(tr, tt1, 70000, 8, 5, g9, hs);
  assert.equal(at(tr, tt1, 80000, 8, 5, g9, hs), 9);
});

test('実データ: 天王2番ティーにいても、32m先の御所ノ入9番(18H)には切り替わらない', () => {
  const c = validateCourse(JSON.parse(readFileSync(new URL('../courses/ota-futaba.json', import.meta.url), 'utf8')));
  const hs = roundHoles(c, ['tenno', 'goshonoiri']);
  const tt2 = hs[1].hole.tees[0].pos;
  const g1 = pickGreen(hs[0].hole, 'ベント').center;
  const tr = newTracker();
  // 天王1番（idx 0）から 2番ティーへ → 2番(idx 1)に切り替わる
  at(tr, tt2, 0, 0, 5, g1, hs);
  assert.equal(at(tr, tt2, 9000, 0, 5, g1, hs), 1);
  // 天王2番(idx 1)で同じ場所に居続けても、18H には飛ばない
  const g2 = pickGreen(hs[1].hole, 'ベント').center;
  assert.equal(at(tr, tt2, 20000, 1, 5, g2, hs), -1);
  assert.equal(at(tr, tt2, 90000, 1, 5, g2, hs), -1);
});
