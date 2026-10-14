// スコアカード（1〜4人）の計算と、カードの入れ替え（データを消さないこと）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newCard, sameSetup, hasEntries, isFull, isRecent, refreshPars, stepStrokes, stepPutts, clearHole, totals, diffText,
  nineRanges, archiveAndReplace, restoreFromHistory, loadCard, saveCard, RECENT_MS, normalizeNames, setPlayers,
  willDropEntries, migrateCard, MAX_PLAYERS, listRecords, deleteRecord, stepOb, OB_PLAYER,
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

test('人数・名前を整える（空欄は「自分」「2人目」…、最大4人）', () => {
  assert.deepEqual(normalizeNames(['', '太郎', ' ']), ['自分', '太郎', '3人目']);
  assert.deepEqual(normalizeNames([]), ['自分']);
  assert.equal(normalizeNames(['a', 'b', 'c', 'd', 'e']).length, MAX_PLAYERS);
});

test('新しいカードは人数分・18ホール・未入力', () => {
  const c = newCard('ota', ['atago', 'tenno'], holes, ['自分', '太郎', '花子'], '2026-10-14');
  assert.equal(c.players.length, 3);
  assert.equal(c.holes.length, 18);
  assert.equal(c.holes[0].s.length, 3);
  assert.ok(!hasEntries(c));
});

test('打数: 未入力から＋で Par、−で Par−1。人ごとに別々', () => {
  const c = newCard('x', ['a', 'b'], holes, ['自分', '太郎']);
  assert.equal(stepStrokes(c, 0, 0, +1).strokes, 4);
  assert.equal(stepStrokes(c, 0, 0, +1).strokes, 5);
  assert.equal(stepStrokes(c, 0, 1, -1).strokes, 3); // 太郎は Par−1 から
  assert.equal(c.holes[0].s[0].strokes, 5);
  for (let k = 0; k < 10; k++) stepStrokes(c, 1, 0, -1);
  assert.equal(c.holes[1].s[0].strokes, 1);
});

test('パット: 未入力から＋で1。打数を超えない。入力を消すのはその人だけ', () => {
  const c = newCard('x', ['a', 'b'], holes, ['自分', '太郎']);
  stepStrokes(c, 0, 0, +1); // 4
  for (let k = 0; k < 10; k++) stepPutts(c, 0, 0, +1);
  assert.equal(c.holes[0].s[0].putts, 4);
  stepStrokes(c, 0, 0, -1); stepStrokes(c, 0, 0, -1);
  assert.equal(c.holes[0].s[0].putts, 2);
  stepStrokes(c, 0, 1, +1);
  clearHole(c, 0, 0);
  assert.equal(c.holes[0].s[0].strokes, null);
  assert.equal(c.holes[0].s[1].strokes, 4); // 太郎の分は残る
});

test('合計は人ごと。Par との差は入力済みのホールだけで比べる', () => {
  const c = newCard('x', ['a', 'b'], holes, ['自分', '太郎']);
  [[5, 2], [3, 2], [3, 1]].forEach(([s, p], i) => { c.holes[i].s[0] = { strokes: s, putts: p }; });
  c.holes[0].s[1] = { strokes: 7, putts: 3 };
  const me = totals(c, 0, 0, 9);
  assert.deepEqual([me.strokes, me.putts, me.par, me.played, me.diff], [11, 5, 36, 3, 0]);
  const taro = totals(c, 1);
  assert.deepEqual([taro.strokes, taro.diff], [7, 3]);
  assert.equal(totals(c, 0, 9, 18).diff, null);
  assert.deepEqual([diffText(0), diffText(3), diffText(-2), diffText(null)], ['E', '+3', '-2', '']);
});

test('Par 未設定のホールは差の計算から外す。Par を後から直したら反映', () => {
  const c = newCard('x', ['a', 'b'], holes);
  c.holes[0].s[0].strokes = 5;
  c.holes[1].par = null; c.holes[1].s[0].strokes = 5;
  const t = totals(c, 0);
  assert.deepEqual([t.strokes, t.diff, t.parMissing], [10, 1, 1]);
  refreshPars(c, holes);
  assert.equal(c.holes[1].par, 3);
});

test('人数を途中で変える: 増やした人は未入力、減らすと消える人の入力を事前に分かる', () => {
  const c = newCard('x', ['a', 'b'], holes, ['自分', '太郎']);
  stepStrokes(c, 0, 1, +1);
  setPlayers(c, ['自分', '太郎', '花子']);
  assert.equal(c.holes[0].s.length, 3);
  assert.equal(c.holes[0].s[1].strokes, 4);
  assert.equal(c.holes[0].s[2].strokes, null);
  assert.ok(willDropEntries(c, 1));   // 太郎を外すと入力が消える
  assert.ok(!willDropEntries(c, 2));  // 花子は未入力
  setPlayers(c, ['自分', 'たろう']);
  assert.equal(c.players[1].name, 'たろう');
  assert.equal(c.holes[0].s[1].strokes, 4);
});

test('1人用（v0.7.0）のカードは「自分」の分として引き継ぐ', () => {
  const old = { id: 'x', date: '2026-10-14', courseId: 'ota', nines: ['a', 'b'],
    holes: [{ nine: '愛宕', no: 1, par: 4, strokes: 5, putts: 2 }, { nine: '愛宕', no: 2, par: 3, strokes: null, putts: null }] };
  const c = migrateCard(old);
  assert.deepEqual(c.players, [{ name: '自分' }]);
  assert.deepEqual(c.holes[0].s, [{ strokes: 5, putts: 2 }]);
  assert.equal(c.holes[0].strokes, undefined);
  assert.equal(migrateCard({ foo: 1 }), null);
});

test('OUT/IN はナイン名が変わる位置で分ける', () => {
  assert.deepEqual(nineRanges(newCard('x', ['a', 'b'], holes)), [[0, 9], [9, 18]]);
});

test('続けるかの判定: 同じ設定か、最後の入力から12時間以内か、全員全ホール入力済みか', () => {
  const c = newCard('ota', ['atago', 'tenno'], holes, ['自分', '太郎'], '2026-10-14', 1000);
  assert.ok(sameSetup(c, 'ota', ['atago', 'tenno'], 18));
  assert.ok(!sameSetup(c, 'ota', ['tenno', 'atago'], 18));
  assert.ok(isRecent(c, 1000 + RECENT_MS - 1));
  assert.ok(!isRecent(c, 1000 + RECENT_MS + 1));
  c.holes.forEach((h) => { h.s[0].strokes = 4; });
  assert.ok(!isFull(c)); // 太郎が未入力
  c.holes.forEach((h) => { h.s[1].strokes = 5; });
  assert.ok(isFull(c));
});

test('入れ替えると前のカードは履歴へ。元の設定に戻せばカードが戻る', () => {
  const mem = fakeStorage();
  const a = newCard('ota', ['atago', 'tenno'], holes, ['自分', '太郎']);
  stepStrokes(a, 0, 1, +1);
  saveCard(a);
  const b = newCard('ota', ['tenno', 'atago'], holes);
  assert.equal(archiveAndReplace(a, b), b);
  const r = restoreFromHistory('ota', ['atago', 'tenno'], 18, b);
  assert.ok(r);
  assert.equal(r.holes[0].s[1].strokes, 4);
  assert.equal(loadCard().players.length, 2);
  assert.equal(JSON.parse(mem['golfnavi.scoreHistory']).length, 0);
  delete globalThis.localStorage;
});

test('履歴に保存できなければ入れ替えない（前のスコアを消さない）', () => {
  fakeStorage({ failKey: 'golfnavi.scoreHistory' });
  const a = newCard('ota', ['atago', 'tenno'], holes);
  stepStrokes(a, 0, 0, +1);
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

test('壊れたカード（列が多い・中身が null・名前が無い）でも人数にそろえて読む', () => {
  const c = migrateCard({ id: 'x', date: '2026-10-14', courseId: 'ota', nines: ['a', 'b'],
    players: [{ name: '自分' }, {}],
    holes: [{ nine: '愛宕', no: 1, par: 4, s: [{ strokes: 5, putts: 2 }, null, { strokes: 9, putts: 9 }] }] });
  assert.deepEqual(c.players.map((p) => p.name), ['自分', '2人目']);
  assert.equal(c.holes[0].s.length, 2);
  assert.deepEqual(c.holes[0].s[1], { strokes: null, putts: null });
});

test('過去の記録は入力のあるカードだけを新しい順に並べ、今のカードも含める', () => {
  fakeStorage();
  const day = (d, t) => { const c = newCard('ota', ['atago', 'tenno'], holes, ['自分'], d, t); stepStrokes(c, 0, 0, +1, t); return c; };
  const old = day('2026-09-01', 1000);
  const mid = day('2026-09-20', 2000);
  const empty = newCard('ota', ['atago', 'tenno'], holes, ['自分'], '2026-09-25', 2500);
  archiveAndReplace(old, mid);
  archiveAndReplace(mid, empty);           // 入力の無いカードは履歴に残らない
  const cur = day('2026-10-14', 3000);
  archiveAndReplace(empty, cur);
  try {
    const r = listRecords(cur);
    assert.deepEqual(r.map((x) => x.card.date), ['2026-10-14', '2026-09-20', '2026-09-01']);
    assert.deepEqual(r.map((x) => x.current), [true, false, false]);
    assert.equal(listRecords(null).length, 2);
  } finally { delete globalThis.localStorage; }
});

test('過去の記録: 今のカードと同じものが履歴にあっても1件、壊れた記録があってもほかは読める', () => {
  const mem = fakeStorage();
  try {
    const ta = Date.parse('2026-09-01T15:00:00'), tb = Date.parse('2026-10-14T15:00:00');
    const a = newCard('ota', ['atago', 'tenno'], holes, ['自分'], '2026-09-01', ta);
    stepStrokes(a, 0, 0, +1, ta);
    const b = newCard('ota', ['atago', 'tenno'], holes, ['自分'], '2026-10-14', tb);
    stepStrokes(b, 0, 0, +1, tb);
    const broken = { ...a, id: 'x', holes: [null, ...a.holes.slice(1)] };
    mem['golfnavi.scoreHistory'] = JSON.stringify([b, broken, { ...a, updatedAt: 'abc' }]);
    const r = listRecords(b);
    assert.deepEqual(r.map((x) => [x.card.date, x.current]), [['2026-10-14', true], ['2026-09-01', false]]);
  } finally { delete globalThis.localStorage; }
});

test('過去の記録を1件削除できる。見つからない・保存できないときは何も変えない', () => {
  const mem = fakeStorage();
  try {
    const mk = (d) => { const t = Date.parse(`${d}T15:00:00`); const c = newCard('ota', ['atago', 'tenno'], holes, ['自分'], d, t); stepStrokes(c, 0, 0, +1, t); return c; };
    const a = mk('2026-09-01'), b = mk('2026-09-20');
    mem['golfnavi.scoreHistory'] = JSON.stringify([b, a]);
    assert.equal(deleteRecord('なし'), false);
    assert.equal(JSON.parse(mem['golfnavi.scoreHistory']).length, 2);
    assert.equal(deleteRecord(a.id, a.updatedAt), true);
    assert.deepEqual(listRecords(null).map((x) => x.card.id), [b.id]);
    mem['golfnavi.scoreHistory'] = '{壊れた';   // 読めない履歴は上書きしない
    assert.equal(deleteRecord(b.id, b.updatedAt), false);
    assert.equal(mem['golfnavi.scoreHistory'], '{壊れた');
  } finally { delete globalThis.localStorage; }
  const mem2 = fakeStorage({ failKey: 'golfnavi.scoreHistory' });
  try {
    const c = newCard('ota', ['atago', 'tenno'], holes, ['自分'], '2026-09-01', 1);
    stepStrokes(c, 0, 0, +1, 1);
    mem2['golfnavi.scoreHistory'] = JSON.stringify([c]);
    assert.equal(deleteRecord(c.id, c.updatedAt), false);     // 保存できなければ false、記録は残る
    assert.equal(JSON.parse(mem2['golfnavi.scoreHistory']).length, 1);
  } finally { delete globalThis.localStorage; }
});

test('記録の削除: 壊れた記録は巻き込まず、同じ id が2件あっても表示していた方だけ消す', () => {
  const mem = fakeStorage();
  try {
    const mk = (t) => { const c = newCard('ota', ['atago', 'tenno'], holes, ['自分'], '2026-09-01', 1); stepStrokes(c, 0, 0, +1, t); return c; };
    const older = mk(1), newer = mk(99);          // 同じ id（2026-09-01-1）で中身の違う2件
    const broken = { id: 'x', holes: [null] };
    mem['golfnavi.scoreHistory'] = JSON.stringify([newer, broken, older]);
    assert.equal(older.id, newer.id);
    assert.equal(deleteRecord(older.id, older.updatedAt), true);
    const left = JSON.parse(mem['golfnavi.scoreHistory']);
    assert.deepEqual(left.map((c) => c.updatedAt ?? 'broken'), [99, 'broken']);
  } finally { delete globalThis.localStorage; }
});

test('OB の数は自分（1人目）だけに入り、合計に数える', () => {
  const c = newCard('ota', ['atago', 'tenno'], holes, ['自分', '太郎']);
  assert.equal(OB_PLAYER, 0);
  assert.equal(stepOb(c, 0, +1).ob, 1);          // 未入力から ＋ で 1
  stepOb(c, 0, +1);
  assert.equal(c.holes[0].s[0].ob, 2);
  assert.equal(c.holes[0].s[1].ob, undefined);   // 太郎の欄には入らない
  const empty = newCard('ota', ['atago', 'tenno'], holes, ['自分']);
  assert.equal(stepOb(empty, 1, -1).ob, undefined); // 未入力から − は何もしない
  assert.ok(!hasEntries(empty));                     // 入力ありにならない（履歴に残らない）
  stepOb(c, 1, +1); stepOb(c, 1, -1);
  assert.equal(c.holes[1].s[0].ob, 0);              // 入れてから − で 0
  for (let k = 0; k < 15; k++) stepOb(c, 2, +1);
  assert.equal(c.holes[2].s[0].ob, 9);           // 上限 9
  assert.equal(totals(c, 0).ob, 11);
  assert.equal(totals(c, 1).ob, 0);
  assert.ok(hasEntries(c, 0));                   // OB だけでも入力ありとみなす（履歴に残る）
  assert.ok(!hasEntries(c, 1));
  clearHole(c, 0, 0);
  assert.equal(totals(c, 0).ob, 9);
});

test('読み込み時、OB は自分の欄の整数だけ残す', () => {
  const c = migrateCard({ id: 'x', date: '2026-10-14', courseId: 'ota', nines: ['a'],
    players: [{ name: '自分' }, { name: '太郎' }],
    holes: [{ nine: '愛宕', no: 1, par: 4, s: [{ strokes: 5, putts: 2, ob: 1 }, { strokes: 4, putts: 2, ob: 3 }] },
            { nine: '愛宕', no: 2, par: 3, s: [{ strokes: 3, putts: 1, ob: 'abc' }, { strokes: 3, putts: 1 }] },
            { nine: '愛宕', no: 3, par: 4, s: [{ strokes: 4, putts: 2, ob: 50 }, { strokes: 4, putts: 2 }] }] });
  assert.equal(c.holes[0].s[0].ob, 1);
  assert.equal(c.holes[0].s[1].ob, undefined);
  assert.equal(c.holes[1].s[0].ob, undefined);
  assert.equal(c.holes[2].s[0].ob, undefined);   // 範囲外（0〜9 以外）も捨てる
  assert.equal(totals(c, 0).ob, 1);
});
