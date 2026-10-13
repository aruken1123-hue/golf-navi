// GPS でホールを自動で切り替える判定（画面に依存しない）
// 切り替え先は「次のホール」だけ。ティー同士や、グリーンと別のナインのティーが近いコースでも、
// 済んだホールや関係ないホールに飛ばないようにするため
import { distanceM } from './geo.js';

export const AUTO_HOLE = {
  TEE_RADIUS_M: 30,     // 次のホールのティーからこの距離以内に入ったら、そのホールに来たとみなす
  DWELL_MS: 8000,       // この時間とどまってから切り替える
  MAX_ACC_M: 30,        // GPS 誤差がこれより大きい位置では判定しない
  MANUAL_RELEASE_M: 60, // 手でホールを選んだ地点からこれ以上動くまで自動切り替えを止める
};

export function newTracker() {
  return { candidate: -1, since: 0, manualAt: null, manualPending: false };
}

/** ホールのティー（どのティーでも）までの最短距離 [m]。ティーが無ければ Infinity */
export function nearestTeeDistance(pos, hole) {
  return Math.min(Infinity, ...(hole?.tees || []).map((t) => distanceM(pos, t.pos)));
}

/** 手でホールを選んだことを記録する。位置が使えないときは、次に届いた良い位置を基準にする */
export function markManual(tracker, goodPos) {
  tracker.candidate = -1;
  tracker.manualAt = goodPos || null;
  tracker.manualPending = !goodPos;
}

/**
 * 切り替えるべきか判定する。tracker は呼び出し側が持ち回る状態（newTracker()）
 * holes: roundHoles() の結果（[{ hole }]）、idx: 今のホール、currentGreen: 今のグリーン中心
 * 戻り値: 切り替え先の番号、または -1
 */
export function decideAutoHole({ pos, acc, now, holes, idx, currentGreen, tracker }) {
  if (!pos || !(acc <= AUTO_HOLE.MAX_ACC_M)) { tracker.candidate = -1; return -1; }
  // 手で選んだ直後は、その地点から離れるまで何もしない
  if (tracker.manualPending) { tracker.manualAt = pos; tracker.manualPending = false; }
  if (tracker.manualAt) {
    if (distanceM(pos, tracker.manualAt) < AUTO_HOLE.MANUAL_RELEASE_M) { tracker.candidate = -1; return -1; }
    tracker.manualAt = null;
  }
  const next = idx + 1;
  if (next >= holes.length) { tracker.candidate = -1; return -1; }
  const dTee = nearestTeeDistance(pos, holes[next].hole);
  // 次のティーの近くにいない、またはまだ今のグリーンのほうが近い（パット中・グリーン周り）
  const onGreen = currentGreen && distanceM(pos, currentGreen) <= dTee;
  if (dTee > AUTO_HOLE.TEE_RADIUS_M || onGreen) { tracker.candidate = -1; return -1; }
  if (tracker.candidate !== next) { tracker.candidate = next; tracker.since = now; return -1; }
  if (now - tracker.since < AUTO_HOLE.DWELL_MS) return -1;
  tracker.candidate = -1;
  return next;
}
