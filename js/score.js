// スコアカード（画面に依存しない計算と保存）
const CARD_KEY = 'golfnavi.score';
const HISTORY_KEY = 'golfnavi.scoreHistory';
const HISTORY_MAX = 50;
export const RECENT_MS = 12 * 3600 * 1000; // 最後の入力からこの時間以内なら「同じラウンドの続き」とみなす

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 新しいスコアカード。holes は roundHoles() の結果 */
export function newCard(courseId, nines, holes, date = today(), now = Date.now()) {
  return {
    id: `${date}-${now}`, date, updatedAt: now, courseId, nines: [...nines],
    holes: holes.map(({ nine, hole }) => ({ nine: nine.name, no: hole.no, par: hole.par ?? null, strokes: null, putts: null })),
  };
}

/** 同じコース・同じ前後半・同じホール数か（日付は見ない） */
export function sameSetup(card, courseId, nines, holeCount) {
  return !!card && card.courseId === courseId && card.nines.join() === nines.join() && card.holes.length === holeCount;
}

export const hasEntries = (card) => !!card && card.holes.some((h) => h.strokes != null || h.putts != null);
export const isFull = (card) => !!card && card.holes.every((h) => h.strokes != null);

/** 最後の入力から RECENT_MS 以内か */
export function isRecent(card, now = Date.now()) {
  const t = card?.updatedAt ?? Date.parse(`${card?.date}T00:00:00`);
  return Number.isFinite(t) && now - t < RECENT_MS;
}

/** コースの Par が後から入力・修正されていたら、カードの Par を付け直す */
export function refreshPars(card, holes) {
  card.holes.forEach((h, i) => { if (holes[i]) h.par = holes[i].hole.par ?? null; });
  return card;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 打数を増減する。未入力から ＋ なら Par（無ければ4）、− なら Par−1 から始める */
export function stepStrokes(card, i, delta, now = Date.now()) {
  const h = card.holes[i];
  const base = h.par ?? 4;
  h.strokes = h.strokes == null ? (delta > 0 ? base : base - 1) : clamp(h.strokes + delta, 1, 20);
  if (h.putts != null && h.putts > h.strokes) h.putts = h.strokes; // パット数は打数を超えない
  card.updatedAt = now;
  return h;
}

/** パット数を増減する。未入力から ＋ なら 1、− なら 0。打数を超えない */
export function stepPutts(card, i, delta, now = Date.now()) {
  const h = card.holes[i];
  h.putts = h.putts == null ? (delta > 0 ? 1 : 0) : clamp(h.putts + delta, 0, 10);
  if (h.strokes != null && h.putts > h.strokes) h.putts = h.strokes;
  card.updatedAt = now;
  return h;
}

export function clearHole(card, i, now = Date.now()) {
  card.holes[i].strokes = null;
  card.holes[i].putts = null;
  card.updatedAt = now;
}

/**
 * 範囲 [from, to) の合計。Par との差は、入力済みで Par の分かっているホールだけで出す。
 * parMissing: 入力済みなのに Par が分からず、差の計算から外したホールの数
 */
export function totals(card, from = 0, to = card.holes.length) {
  let strokes = 0, putts = 0, par = 0, parPlayed = 0, strokesWithPar = 0, played = 0, parMissing = 0;
  for (const h of card.holes.slice(from, to)) {
    par += h.par ?? 0;
    if (h.strokes != null) {
      strokes += h.strokes; played++;
      if (h.par != null) { parPlayed += h.par; strokesWithPar += h.strokes; } else parMissing++;
    }
    if (h.putts != null) putts += h.putts;
  }
  const diff = played - parMissing > 0 ? strokesWithPar - parPlayed : null;
  return { strokes, putts, par, played, diff, parMissing };
}

/** Par との差の表示（例: +3, -1, E） */
export function diffText(d) {
  if (d == null) return '';
  return d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`;
}

/** ナイン（OUT/IN）の区切り。ナイン名が変わる位置で分ける: [[開始, 終了), ...] */
export function nineRanges(card) {
  const r = [];
  card.holes.forEach((h, i) => {
    if (i === 0 || h.nine !== card.holes[i - 1].nine) r.push([i, i + 1]);
    else r[r.length - 1][1] = i + 1;
  });
  return r;
}

// ---------- 端末への保存 ----------

const validCard = (c) => !!c && Array.isArray(c.holes) && Array.isArray(c.nines) && typeof c.courseId === 'string';

export function loadCard() {
  try { const c = JSON.parse(localStorage.getItem(CARD_KEY)); return validCard(c) ? c : null; } catch { return null; }
}

export function saveCard(card) {
  try { localStorage.setItem(CARD_KEY, JSON.stringify(card)); return true; } catch { return false; }
}

function loadHistory() {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(h) ? h.filter(validCard) : []; } catch { return []; }
}

function saveHistory(hist) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, HISTORY_MAX))); return true; } catch { return false; }
}

/**
 * 今のカードを履歴に残してから、新しいカードに入れ替える（入力の無いカードは残さない）。
 * 履歴に残せなかったときは入れ替えず null を返す（前のスコアを消さないため）
 */
export function archiveAndReplace(oldCard, card) {
  if (hasEntries(oldCard)) {
    const hist = loadHistory();
    hist.unshift(oldCard);
    if (!saveHistory(hist)) return null;
  }
  return saveCard(card) ? card : null;
}

/**
 * 同じコース・前後半で、最近（RECENT_MS 以内）入力していたカードが履歴にあれば戻す。
 * 今のカードは履歴へ。設定を間違えて入れ替えた後、元に戻したときに使う
 */
export function restoreFromHistory(courseId, nines, holeCount, current, now = Date.now()) {
  const hist = loadHistory();
  const i = hist.findIndex((c) => sameSetup(c, courseId, nines, holeCount) && hasEntries(c) && isRecent(c, now));
  if (i < 0) return null;
  const [card] = hist.splice(i, 1);
  if (hasEntries(current)) hist.unshift(current);
  if (!saveHistory(hist)) return null;
  return saveCard(card) ? card : null;
}
