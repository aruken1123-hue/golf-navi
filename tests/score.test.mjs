// スコアカードの計算と、カードの入れ替え（データを消さないこと）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newCard, sameSetup, hasEntries, isFull, isRecent, refreshPars, stepStrokes, stepPutts, clearHole, totals, diffText,
  nineRanges, archiveAndReplace, restoreFromHistory, loadCard, saveCard, RECENT_MS,
} from '../js/score.js';

const nine = (name, pars) => ({ name, holes: pars.map((par, i) => ({ no: i + 1, par })) });
const out = nine('愛宕', [4, 3, 4, 4, 3, 5, 4, 4, 5]);
const inn = nine('天王', [4, 4, 4, 4, 3, 5, 3, 4, 5]);
const holes = [...out.holes.map((hole) => ({ nine: out, hole })), ...inn.holes.map((hole) => ({ nine: inn, hole }))];

function fakeStorage({ failKey } = {}) {
  const mem = {};
  globalThis.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { if (k === failKey) throw new Error('quota'); mem[k] = String(v); },
  };
  return mem;
}

test('新しいカードは18ホール・未入力', () => {
  const c = newCard('ota-futaba', ['atago', 'tenno'], holes, '2026-10-14');
  assert.equal(c.holes.length, 18);
  assert.equal(c.holes[0].par, 4);
  assert.equal(c.holes[9].nine, '天王');
  assert.ok(!hasEntries(c));
});

test('打数: 未入力から＋で Par、−で Par−1。1〜20 の範囲', () => {
  const c = newCard('x', ['a', 'b'], holes);
  assert.equal(stepStrokes(c, 0, +1).strokes, 4);
  assert.equal(stepStrokes(c, 0, +1).strokes, 5);
  assert.equal(stepStrokes(c, 1, -1).strokes, 2); // Par3 から −
  for (let k = 0; k < 10; k++) stepStrokes(c, 1, -1);
  assert.equal(c.holes[1].strokes, 1);
});

test('パット: 未入力から＋で1。打数を超えない', () => {
  const c = newCard('x', ['a', 'b'], holes);
  assert.equal(stepPutts(c, 0, +1).putts, 1);
  stepStrokes(c, 0, +1); // 4
  for (let k = 0; k < 10; k++) stepPutts(c, 0, +1);
  assert.equal(c.holes[0].putts, 4);
  stepStrokes(c, 0, -1); stepStrokes(c, 0, -1); // 2打に減らすとパットも2に
  assert.equal(c.holes[0].putts, 2);
  clearHole(c, 0);
  assert.equal(c.holes[0].strokes, null);
});

test('合計: OUT・IN・合計と Par との差（入力済みのホールだけで比べる）', () => {
  const c = newCard('x', ['a', 'b'], holes);
  c.holes[0].strokes = 5; c.holes[0].putts = 2;
  c.holes[1].strokes = 3; c.holes[1].putts = 2;
  c.holes[2].strokes = 3; c.holes[2].putts = 1;
  const o = totals(c, 0, 9);
  assert.deepEqual([o.strokes, o.putts, o.par, o.played, o.diff], [11, 5, 36, 3, 0]);
  assert.equal(totals(c, 9, 18).diff, null);
  assert.equal(totals(c).par, 72);
  assert.deepEqual([diffText(0), diffText(3), diffText(-2), diffText(null)], ['E', '+3', '-2', '']);
});

test('Par 未設定のホールは差の計算から外す', () => {
  const c = newCard('x', ['a', 'b'], holes);
  c.holes[0].strokes = 5;            // Par4 → +1
  c.holes[1].par = null; c.holes[1].strokes = 5; // Par 不明
  const t = totals(c);
  assert.equal(t.strokes, 10);
  assert.equal(t.diff, 1);
  assert.equal(t.parMissing, 1);
});

test('Par を後から直したらカードにも反映する', () => {
  const c = newCard('x', ['a', 'b'], holes);
  c.holes[0].par = null;
  refreshPars(c, holes);
  assert.equal(c.holes[0].par, 4);
});

test('OUT/IN はナイン名が変わる位置で分ける', () => {
  const c = newCard('x', ['a', 'b'], holes);
  assert.deepEqual(nineRanges(c), [[0, 9], [9, 18]]);
});

test('続けるかの判定: 同じ設定か、最後の入力から12時間以内か、全部入力済みか', () => {
  const c = newCard('ota', ['atago', 'tenno'], holes, '2026-10-14', 1000);
  assert.ok(sameSetup(c, 'ota', ['atago', 'tenno'], 18));
  assert.ok(!sameSetup(c, 'ota', ['tenno', 'atago'], 18));
  assert.ok(isRecent(c, 1000 + RECENT_MS - 1));
  assert.ok(!isRecent(c, 1000 + RECENT_MS + 1));
  stepStrokes(c, 0, +1, 1000 + RECENT_MS); // 入力すると時刻が新しくなる
  assert.ok(isRecent(c, 1000 + RECENT_MS + 10));
  assert.ok(!isFull(c));
  c.holes.forEach((h) => { h.strokes = 4; });
  assert.ok(isFull(c));
});

test('入れ替えると前のカードは履歴へ。間違えて変えても元の設定に戻せばカードが戻る', () => {
  const mem = fakeStorage();
  const a = newCard('ota', ['atago', 'tenno'], holes);
  stepStrokes(a, 0, +1);
  saveCard(a);
  const b = newCard('ota', ['tenno', 'atago'], holes);
  assert.equal(archiveAndReplace(a, b), b);
  assert.equal(loadCard().nines.join(), 'tenno,atago');
  // 元の設定に戻すと、入力していたカードが戻る
  const r = restoreFromHistory('ota', ['atago', 'tenno'], 18, b);
  assert.ok(r);
  assert.equal(r.holes[0].strokes, 4);
  assert.equal(loadCard().nines.join(), 'atago,tenno');
  assert.equal(JSON.parse(mem['golfnavi.scoreHistory']).length, 0); // 空の b は履歴に残さない
  delete globalThis.localStorage;
});

test('履歴に保存できなければ入れ替えない（前のスコアを消さない）', () => {
  fakeStorage({ failKey: 'golfnavi.scoreHistory' });
  const a = newCard('ota', ['atago', 'tenno'], holes);
  stepStrokes(a, 0, +1);
  saveCard(a);
  assert.equal(archiveAndReplace(a, newCard('ota', ['tenno', 'atago'], holes)), null);
  assert.equal(loadCard().nines.join(), 'atago,tenno');
  delete globalThis.localStorage;
});

test('壊れた保存データは読まない', () => {
  const mem = fakeStorage();
  mem['golfnavi.score'] = JSON.stringify({ foo: 1 });
  assert.equal(loadCard(), null);
  mem['golfnavi.score'] = '{壊れた';
  assert.equal(loadCard(), null);
  delete globalThis.localStorage;
});
