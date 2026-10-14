// ショット地点の記録と、番手ごとの飛距離（自分だけ。画面に依存しない計算と保存）
import { distanceM } from './geo.js';

const SHOTS_KEY = 'golfnavi.shots';
export const SHOTS_MAX = 5000; // 1件 150バイトほど。5000件でも 1MB 未満
/** 初めの番手の並び（利用者が「番手の設定」で変えられる） */
export const CLUBS = ['1W', '3W', '5W', '7W', '3U', '4U', '5U', '6U', '4I', '5I', '6I', '7I', '8I', '9I', 'PW', 'AW', 'SW', 'LW', 'PT'];
/** 設定画面で選べる候補（長い番手から短い番手の順。足すときはこの順で近い位置に入る） */
export const CLUB_PRESETS = ['1W', '2W', '3W', '4W', '5W', '7W', '9W', '2U', '3U', '4U', '5U', '6U', '7U', '2I', '3I', '4I', '5I', '6I', '7I', '8I', '9I',
  'PW', '46°', '48°', '50°', 'GW', 'AW', '52°', '54°', 'SW', '56°', '58°', 'LW', '60°', 'PT'];
export const CLUB_NAME_MAX = 8;
export const BAG_MAX = 24;
const BAG_KEY = 'golfnavi.bag';

/**
 * 番手の名前を整える（制御文字・ゼロ幅や向きを変える見えない文字を除き、前後の空白を除いて8文字まで）。空なら ''。
 * 何度かけても同じ結果になる（記録の確かめ isShot でも使うため）。絵文字などは途中で切らない
 */
export function normalizeClubName(name) {
  if (typeof name !== 'string') return '';
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim();
  return Array.from(clean).slice(0, CLUB_NAME_MAX).join('').trim();
}

/** 番手の一覧を整える（空・重複を除き、最大 BAG_MAX 個） */
export function normalizeBag(list) {
  const out = [];
  for (const n of Array.isArray(list) ? list : []) {
    const c = normalizeClubName(n);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, BAG_MAX);
}

/** 自分の番手の並び（設定が無ければ初めの並び） */
export function loadBag() {
  try {
    const b = normalizeBag(JSON.parse(localStorage.getItem(BAG_KEY)));
    return b.length ? b : [...CLUBS];
  } catch { return [...CLUBS]; }
}
/** 番手の並びを自分で設定したことがあるか */
export function hasBagSetting() {
  try { return localStorage.getItem(BAG_KEY) !== null; } catch { return false; }
}
export function saveBag(list) {
  try { localStorage.setItem(BAG_KEY, JSON.stringify(normalizeBag(list))); return true; } catch { return false; }
}
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
    && typeof s.club === 'string' && s.club === normalizeClubName(s.club)
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
    acc: acc == null ? null : Math.round(acc), club: normalizeClubName(club),
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
 * 並びは order（自分の番手の並び）の順。order に無い番手（設定から外したもの）は後ろに名前順
 */
export function clubStats(list, order = CLUBS) {
  const by = new Map();
  for (const d of shotDistances(list)) {
    if (!d.club || d.m < SHOT_MIN_M || d.m > SHOT_MAX_M) continue;
    if (!by.has(d.club)) by.set(d.club, []);
    by.get(d.club).push(d.m);
  }
  const rest = [...by.keys()].filter((c) => !order.includes(c)).sort();
  return [...order.filter((c) => by.has(c)), ...rest].map((club) => {
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
