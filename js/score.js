// スコアカード（画面に依存しない計算と保存）。1〜4人分
const CARD_KEY = 'golfnavi.score';
const HISTORY_KEY = 'golfnavi.scoreHistory';
const NAMES_KEY = 'golfnavi.players';
const HISTORY_MAX = 50;
export const MAX_PLAYERS = 4;
export const RECENT_MS = 12 * 3600 * 1000; // 最後の入力からこの時間以内なら「同じラウンドの続き」とみなす

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyScore = () => ({ strokes: null, putts: null });

/** 人数・名前を整える（空の名前は「自分」「2人目」…、1〜4人） */
export function normalizeNames(names) {
  const list = (names || []).slice(0, MAX_PLAYERS).map((n, i) => String(n ?? '').trim().slice(0, 12) || (i === 0 ? '自分' : `${i + 1}人目`));
  return list.length ? list : ['自分'];
}

/** 新しいスコアカード。holes は roundHoles() の結果 */
export function newCard(courseId, nines, holes, names = ['自分'], date = today(), now = Date.now()) {
  const players = normalizeNames(names).map((name) => ({ name }));
  return {
    id: `${date}-${now}`, date, updatedAt: now, courseId, nines: [...nines], players,
    holes: holes.map(({ nine, hole }) => ({ nine: nine.name, no: hole.no, par: hole.par ?? null, s: players.map(emptyScore) })),
  };
}

/** 同じコース・同じ前後半・同じホール数か（日付・人数は見ない） */
export function sameSetup(card, courseId, nines, holeCount) {
  return !!card && card.courseId === courseId && card.nines.join() === nines.join() && card.holes.length === holeCount;
}

const entered = (sc) => sc && (sc.strokes != null || sc.putts != null);
/** その人（省略時は誰か）が1つでも入力しているか */
export const hasEntries = (card, p) => !!card && card.holes.some((h) => (p == null ? h.s.some(entered) : entered(h.s[p])));
/** 全員・全ホールの打数が入っているか */
export const isFull = (card) => !!card && card.holes.every((h) => h.s.every((sc) => sc.strokes != null));

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

/**
 * 人数・名前を変える。名前は先頭から順に付け替え、増えた人は未入力、減った人の入力は消える。
 * 消える人に入力があるかは willDropEntries で先に確かめる
 */
export function setPlayers(card, names, now = Date.now()) {
  const list = normalizeNames(names);
  card.players = list.map((name) => ({ name }));
  for (const h of card.holes) {
    h.s = list.map((_, i) => h.s[i] || emptyScore());
  }
  card.updatedAt = now;
  return card;
}

/** 人数を減らすと、入力済みの人のスコアが消えるか */
export function willDropEntries(card, newCount) {
  for (let p = newCount; p < card.players.length; p++) if (hasEntries(card, p)) return true;
  return false;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 打数を増減する。未入力から ＋ なら Par（無ければ4）、− なら Par−1 から始める */
export function stepStrokes(card, i, p, delta, now = Date.now()) {
  const h = card.holes[i], sc = h.s[p];
  const base = h.par ?? 4;
  sc.strokes = sc.strokes == null ? (delta > 0 ? base : base - 1) : clamp(sc.strokes + delta, 1, 20);
  if (sc.putts != null && sc.putts > sc.strokes) sc.putts = sc.strokes; // パット数は打数を超えない
  card.updatedAt = now;
  return sc;
}

/** パット数を増減する。未入力から ＋ なら 1、− なら 0。打数を超えない */
export function stepPutts(card, i, p, delta, now = Date.now()) {
  const sc = card.holes[i].s[p];
  sc.putts = sc.putts == null ? (delta > 0 ? 1 : 0) : clamp(sc.putts + delta, 0, 10);
  if (sc.strokes != null && sc.putts > sc.strokes) sc.putts = sc.strokes;
  card.updatedAt = now;
  return sc;
}

/** その人のそのホールの入力を消す */
export function clearHole(card, i, p, now = Date.now()) {
  card.holes[i].s[p] = emptyScore();
  card.updatedAt = now;
}

/**
 * その人の範囲 [from, to) の合計。Par との差は、入力済みで Par の分かっているホールだけで出す。
 * parMissing: 入力済みなのに Par が分からず、差の計算から外したホールの数
 */
export function totals(card, p = 0, from = 0, to = card.holes.length) {
  let strokes = 0, putts = 0, par = 0, parPlayed = 0, strokesWithPar = 0, played = 0, parMissing = 0;
  for (const h of card.holes.slice(from, to)) {
    const sc = h.s[p] || emptyScore();
    par += h.par ?? 0;
    if (sc.strokes != null) {
      strokes += sc.strokes; played++;
      if (h.par != null) { parPlayed += h.par; strokesWithPar += sc.strokes; } else parMissing++;
    }
    if (sc.putts != null) putts += sc.putts;
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

/** 1人用（v0.7.0）のカードを、複数人の形に直す。直せない形なら null */
export function migrateCard(c) {
  if (!c || !Array.isArray(c.holes) || !Array.isArray(c.nines) || typeof c.courseId !== 'string') return null;
  if (!Array.isArray(c.players) || !c.players.length) {
    c.players = [{ name: '自分' }];
    for (const h of c.holes) {
      if (!Array.isArray(h.s)) h.s = [{ strokes: h.strokes ?? null, putts: h.putts ?? null }];
      delete h.strokes; delete h.putts;
    }
  }
  // 壊れたデータでも表示・入力で落ちないよう、人数と列の数・中身をそろえる
  c.players = normalizeNames(c.players.map((x) => x?.name)).map((name) => ({ name }));
  for (const h of c.holes) {
    if (!Array.isArray(h.s)) return null;
    h.s = c.players.map((_, i) => (h.s[i] && typeof h.s[i] === 'object' ? h.s[i] : emptyScore()));
  }
  return c;
}

export function loadCard() {
  try { return migrateCard(JSON.parse(localStorage.getItem(CARD_KEY))); } catch { return null; }
}

export function saveCard(card) {
  try { localStorage.setItem(CARD_KEY, JSON.stringify(card)); return true; } catch { return false; }
}

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(h) ? h.map(migrateCard).filter(Boolean) : [];
  } catch { return []; }
}

function saveHistory(hist) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, HISTORY_MAX))); return true; } catch { return false; }
}

/** 前回入れた人数・名前（ラウンド設定の初期値） */
export function loadNames() {
  try { const n = JSON.parse(localStorage.getItem(NAMES_KEY)); return Array.isArray(n) ? normalizeNames(n) : ['自分']; } catch { return ['自分']; }
}
export function saveNames(names) {
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(normalizeNames(names))); } catch { /* 覚えられなくても使える */ }
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
