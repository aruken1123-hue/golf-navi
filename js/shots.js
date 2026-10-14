// ショット地点の記録と、番手ごとの飛距離（自分だけ。画面に依存しない計算と保存）
import { distanceM } from './geo.js';

const SHOTS_KEY = 'golfnavi.shots';
export const SHOTS_MAX = 5000; // 1件 150バイトほど。5000件でも 1MB 未満
/** 選べる番手（空 = 番手なし） */
export const CLUBS = ['1W', '3W', '5W', '7W', '3U', '4U', '5U', '6U', '4I', '5I', '6I', '7I', '8I', '9I', 'PW', 'AW', 'SW', 'LW', 'PT'];
/** 飛距離の集計に入れる範囲 [m]。これ外は記録の押し忘れ・押し間違いとみなす */
export const SHOT_MIN_M = 5, SHOT_MAX_M = 400;

/** 同じラウンドの同じホールか（ラウンド＝スコアカードの id と、ラウンドの中の何ホール目か で判定） */
const sameHole = (a, b) => a.round === b.round && a.hole === b.hole;

export function loadShots() {
  try {
    const list = JSON.parse(localStorage.getItem(SHOTS_KEY) || '[]');
    return Array.isArray(list) ? list.filter(isShot) : [];
  } catch { return []; }
}

export function saveShots(list) {
  try { localStorage.setItem(SHOTS_KEY, JSON.stringify(list.slice(-SHOTS_MAX))); return true; } catch { return false; }
}

/** 記録として使える形か（読み込んだファイルの確認にも使う） */
export function isShot(s) {
  return !!s && typeof s === 'object' && typeof s.id === 'string' && s.id.length <= 64
    && typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date)
    && typeof s.courseId === 'string' && s.courseId.length <= 64
    && typeof s.round === 'string' && s.round.length <= 80
    && typeof s.hole === 'string' && s.hole.length <= 64
    && Number.isFinite(s.t)
    && Array.isArray(s.ll) && s.ll.length === 2 && s.ll.every(Number.isFinite)
    && Math.abs(s.ll[0]) <= 90 && Math.abs(s.ll[1]) <= 180
    && (s.club === '' || CLUBS.includes(s.club))
    && (s.acc == null || Number.isFinite(s.acc));
}

/**
 * 地点を1つ記録した新しい一覧を返す。
 * round: ラウンドの区別（スコアカードの id）、hole: ラウンドの中のホール（例 "1:atago-1"）、manual: 地図で手で指定した位置
 */
export function addShot(list, { date, courseId, round, hole, ll, acc = null, club = '', manual = false, t = Date.now() }) {
  const shot = {
    id: `${t}-${Math.random().toString(36).slice(2, 8)}`, t, date, courseId, round, hole,
    ll: [Math.round(ll[0] * 1e6) / 1e6, Math.round(ll[1] * 1e6) / 1e6],
    acc: acc == null ? null : Math.round(acc), club: CLUBS.includes(club) ? club : '',
  };
  if (manual) shot.manual = true;
  return [...list, shot];
}

/** そのホール（その日）の記録を古い順に */
export function holeShots(list, where) {
  return list.filter((s) => sameHole(s, where)).sort((a, b) => a.t - b.t);
}

/** そのホール（その日）の最後の記録を消した新しい一覧を返す（無ければそのまま） */
export function removeLastShot(list, where) {
  const last = holeShots(list, where).at(-1);
  return last ? list.filter((s) => s.id !== last.id) : list;
}

/**
 * 飛距離: 同じホールで続けて記録した2地点の間の直線距離 [m]。番手は打った側（前の地点）のもの。
 * 戻り値: [{ club, m, from, to }]
 */
export function shotDistances(list) {
  const groups = new Map();
  for (const s of list) {
    const k = `${s.round}|${s.hole}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.t - b.t);
    for (let i = 0; i + 1 < g.length; i++) out.push({ club: g[i].club, m: distanceM(g[i].ll, g[i + 1].ll), from: g[i], to: g[i + 1] });
  }
  return out;
}

/**
 * 番手ごとの飛距離 [m]: 回数・平均・最大。番手なしと、範囲外（押し忘れなど）は入れない。
 * 並びは CLUBS の順
 */
export function clubStats(list) {
  const by = new Map();
  for (const d of shotDistances(list)) {
    if (!d.club || d.m < SHOT_MIN_M || d.m > SHOT_MAX_M) continue;
    if (!by.has(d.club)) by.set(d.club, []);
    by.get(d.club).push(d.m);
  }
  return CLUBS.filter((c) => by.has(c)).map((club) => {
    const ms = by.get(club);
    return { club, n: ms.length, avg: ms.reduce((a, b) => a + b, 0) / ms.length, max: Math.max(...ms) };
  });
}

/**
 * バックアップから読み込む。同じ記録（id）は足さない。今ある記録は押し出さない（上限に達したら足さない）。
 * 戻り値: { added, noRoom }（保存できなければ null）
 */
export function importShots(items) {
  if (!Array.isArray(items)) return { added: 0, noRoom: 0 };
  const list = loadShots();
  const have = new Set(list.map((s) => s.id));
  const fresh = items.slice(0, SHOTS_MAX).filter((s) => isShot(s) && !have.has(s.id)).sort((a, b) => b.t - a.t); // 新しい記録から
  let added = 0, noRoom = 0;
  for (const s of fresh) {
    if (have.has(s.id)) continue;
    if (list.length >= SHOTS_MAX) { noRoom++; continue; }
    have.add(s.id);
    const c = { id: s.id, t: s.t, date: s.date, courseId: s.courseId, round: s.round, hole: s.hole, ll: [s.ll[0], s.ll[1]], acc: s.acc ?? null, club: s.club };
    if (s.manual === true) c.manual = true;
    list.push(c);
    added++;
  }
  if (!added) return { added, noRoom };
  list.sort((a, b) => a.t - b.t);
  return saveShots(list) ? { added, noRoom } : null;
}
