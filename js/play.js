// プレー画面: 現在地からグリーン・ハザードまでの距離と高低差を出す
/* global L */
import { distanceM, toYards, greenDistances, hazardsAhead, elevationDiff, distanceToBbox, bearingDeg } from './geo.js';
import { getElevation } from './elev.js';
import { createMap, drawOutline, drawHole, prefetchCourseTiles, HAZARD_TYPES } from './mapbase.js';
import {
  listCourses, loadCourse, loadRound, saveRound, roundHoles, greenNames, pickGreen, usableGreens, isHoleRegistered,
  discardCourseLocal,
} from './store.js';
import { setupPWA, toast } from './pwa.js';
import { decideAutoHole, newTracker, markManual, AUTO_HOLE } from './autohole.js';
import { APP_VERSION } from './version.js';

const POOR_ACCURACY_M = 20; // これより誤差が大きいと数字を灰色にする
const ELEV_REFRESH_M = 5;   // これ以上動いたら現在地の標高を取り直す
const ELEV_RESET_M = 30;    // これ以上一気に動いたら、前の地点の標高は使わない
const STALE_MS = 15000;     // これより古い GPS の位置は「古い」として灰色にする
const OFFSITE_M = 500;      // コースの範囲からこれ以上離れていたら下見モード（ティー基準）にする

const $ = (id) => document.getElementById(id);
const yd = (m) => (m == null ? '---' : String(Math.round(toYards(m))));

const state = {
  course: null,
  holes: [],      // roundHoles() の結果
  idx: 0,
  pos: null,      // { ll:[lat,lng], acc, manual, time }
  posElev: null,  // { ll, elev, source }
  manualMode: false,
  measure: null,  // [lat,lng]
  gpsError: null,  // 位置情報のエラー（null = エラーなし／取得中）
  previewForced: false, // 「下見」ボタンで、現在地に関係なくティー基準にする
  autoHole: true,  // GPS でホールを自動で切り替える（ラウンド設定で変えられる）
  autoTracker: newTracker(), // 自動切り替えの判定に使う状態
  greenName: null, // ラウンドで使うグリーン（例: ベント）
  holeGreen: {},   // ホールごとに切り替えたグリーン { ラウンド内の番号: 名前 }
};

const map = createMap($('map'), { rotate: true });
map.setView([36.36, 139.332], 15);
const holeLayer = L.layerGroup().addTo(map);
const posLayer = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);
let outlineLayer = null;
let holeBounds = null;

// ---------- ラウンド設定 ----------

async function openSetup() {
  $('setupSheet').classList.remove('hidden');
  const courses = await listCourses();
  const sel = $('selCourse');
  sel.innerHTML = '';
  for (const c of courses) sel.add(new Option(c.name, c.id));
  const round = loadRound();
  if (round && courses.some((c) => c.id === round.courseId)) sel.value = round.courseId;
  await fillNines();
}

async function fillNines() {
  const id = $('selCourse').value;
  if (!id) return;
  let course;
  try { course = await loadCourse(id); } catch (e) { $('dataStatus').textContent = e.message; return; }
  const round = loadRound();
  for (const [selId, fallback] of [['selOut', 0], ['selIn', 1]]) {
    const sel = $(selId);
    sel.innerHTML = '';
    for (const n of course.nines) sel.add(new Option(n.name, n.id));
    const saved = round && round.courseId === id ? round.nines[fallback] : null;
    const valid = saved && course.nines.some((n) => n.id === saved);
    sel.value = valid ? saved : course.nines[Math.min(fallback, course.nines.length - 1)].id;
  }
  const gsel = $('selGreen');
  // 2グリーンのホールが1つも無いコースでは選ぶ意味がないので隠す
  const hasTwo = course.nines.some((n) => n.holes.some((h) => usableGreens(h).length >= 2));
  gsel.classList.toggle('hidden', !hasTwo);
  $('lblGreen').classList.toggle('hidden', !hasTwo);
  gsel.innerHTML = '';
  for (const name of greenNames(course)) gsel.add(new Option(`${name}グリーン`, name));
  const savedGreen = round && round.courseId === id ? round.green : null;
  if (savedGreen && greenNames(course).includes(savedGreen)) gsel.value = savedGreen;
  const registered = course.nines.flatMap((n) => n.holes).filter(isHoleRegistered).length;
  const total = course.nines.reduce((s, n) => s + n.holes.length, 0);
  $('dataStatus').textContent = `登録済み ${registered} / ${total} ホール` + (course.__local ? '（この端末で編集したデータ）' : '')
    + (course.__publishedNewer ? `。公開版のほうが新しい（${course.__publishedNewer}）ので、使うなら登録画面の「端末内の編集を捨てる」を押してください` : '');
}

async function startRound(courseId, nineIds, idx = 0, green = null, holeGreen = {}) {
  state.course = await loadCourse(courseId);
  // 端末内に古いコースデータが残っていると、新しい公開データ（グリーン・ハザード等）が使われない
  if (state.course.__publishedNewer && confirm(
    'コースデータが新しくなっています。\n'
    + 'この端末には、以前に登録画面で編集した古いデータが残っていて、そちらが使われています。\n\n'
    + '古いデータを捨てて、新しいデータを使いますか？')) {
    discardCourseLocal(courseId);
    state.course = await loadCourse(courseId);
  }
  state.holes = roundHoles(state.course, nineIds);
  if (state.holes.length === 0) throw new Error('ホールがありません');
  state.greenName = green && greenNames(state.course).includes(green) ? green : greenNames(state.course)[0];
  state.autoTracker = newTracker(); // 前のラウンドの判定状態を持ち越さない
  state.holeGreen = holeGreen || {};
  if (outlineLayer) outlineLayer.remove();
  outlineLayer = drawOutline(map, state.course);
  saveRound({ courseId, nines: nineIds, idx, green: state.greenName, holeGreen: state.holeGreen });
  showHole(Math.min(idx, state.holes.length - 1));
}

// ---------- ホール表示 ----------

function currentHole() { return state.holes[state.idx]?.hole; }

/** このホールで使うグリーンの名前（ホールごとの切り替え > ラウンドの設定） */
function activeGreenName() { return state.holeGreen[state.idx] ?? state.greenName; }

function showHole(i) {
  state.idx = (i + state.holes.length) % state.holes.length;
  const round = loadRound();
  if (round) saveRound({ ...round, idx: state.idx });
  const { nine, hole } = state.holes[state.idx];
  $('holeTitle').innerHTML = '';
  $('holeTitle').append(`${nine.name} ${hole.no}番`);
  const small = document.createElement('small');
  small.textContent = `${state.idx + 1}H` + (hole.par ? ` ・ Par ${hole.par}` : '') + (hole.hdcp ? ` ・ HC ${hole.hdcp}` : '');
  $('holeTitle').append(small);

  drawCurrentHole();
  clearMeasure();
  fitHole();
  // ティーの標高が未登録なら標高タイルから補う（下見モードの高低差に使う）
  const tee = regularTee(hole);
  if (tee && tee.pos[2] == null && tee.__elev === undefined) {
    tee.__elev = null;
    getElevation(tee.pos[0], tee.pos[1]).then((r) => { tee.__elev = r.elev ?? undefined; render(); });
  }
  // グリーンの標高が未登録なら標高タイルから補う
  for (const g of usableGreens(hole)) {
    if (g.center[2] != null || g.__elev !== undefined) continue;
    g.__elev = null;
    getElevation(g.center[0], g.center[1]).then((r) => {
      g.__elev = r.elev ?? undefined; // 取れなければ次にホールを開いたとき取り直す
      render();
    });
  }
  render();
}

function drawCurrentHole() {
  holeLayer.clearLayers();
  holeBounds = drawHole(holeLayer, currentHole(), activeGreenName());
}

/** 2グリーンのホールで、使うグリーンを次に切り替える（このホールだけ） */
function switchGreen() {
  const gs = usableGreens(currentHole());
  if (gs.length < 2) return;
  const cur = pickGreen(currentHole(), activeGreenName());
  const next = gs[(gs.indexOf(cur) + 1) % gs.length];
  state.holeGreen[state.idx] = next.name;
  const round = loadRound();
  if (round) saveRound({ ...round, holeGreen: state.holeGreen });
  drawCurrentHole();
  render();
}

/**
 * ホール全体を表示する。ティーとグリーンがあれば、グリーンが上になるよう地図を回し、
 * ホールの向きに沿った縦・横の広がりから拡大率を決める（回した地図では fitBounds が合わないため）
 */
function fitHole() {
  const hole = currentHole();
  const tee = hole && regularTee(hole);
  const green = hole && pickGreen(hole, activeGreenName());
  const canRotate = typeof map.setBearing === 'function';
  if (!tee || !green) {
    if (canRotate) map.setBearing(0);
    if (holeBounds) map.fitBounds(holeBounds.pad(0.06), { padding: [12, 12] });
    else if (state.course?.bbox) {
      const b = state.course.bbox;
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]]);
    }
    return;
  }
  const brg = canRotate ? bearingDeg(tee.pos, green.center) : 0;
  if (canRotate) map.setBearing(360 - brg); // 反時計回りに回してホールの向きを真上にする
  // ティーを原点にした東・北 [m] → ホール方向（前）と横の成分
  const o = tee.pos, k = Math.PI / 180, R = 6371008.8;
  const toXY = (p) => [(p[1] - o[1]) * k * R * Math.cos(o[0] * k), (p[0] - o[0]) * k * R];
  const fromXY = ([x, y]) => [o[0] + y / (k * R), o[1] + x / (k * R * Math.cos(o[0] * k))];
  const ux = Math.sin(brg * k), uy = Math.cos(brg * k); // 前方向
  const pts = [tee.pos, ...usableGreens(hole).map((g) => g.center)];
  for (const z of hole.hazards || []) if (!z.line) pts.push(...(z.polygon || z.points || []));
  let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const p of pts) {
    const [x, y] = toXY(p);
    const along = x * ux + y * uy, across = x * uy - y * ux;
    a0 = Math.min(a0, along); a1 = Math.max(a1, along); c0 = Math.min(c0, across); c1 = Math.max(c1, across);
  }
  const am = (a0 + a1) / 2, cm = (c0 + c1) / 2;
  const center = fromXY([am * ux + cm * uy, am * uy - cm * ux]);
  const size = map.getSize();
  const PAD = 28; // 画面の端からの余白 [px]
  const mPerPxZ0 = 156543.03392 * Math.cos(center[0] * k);
  const zH = Math.log2(mPerPxZ0 * Math.max(size.y - 2 * PAD, 50) / Math.max(a1 - a0 + 20, 40));
  const zW = Math.log2(mPerPxZ0 * Math.max(size.x - 2 * PAD, 50) / Math.max(c1 - c0 + 20, 40));
  const zoom = canRotate ? Math.min(zH, zW) : Math.min(zH, zW) - 0.5;
  map.setView(center, Math.min(Math.floor(zoom * 4) / 4, 19), { animate: false });
}

// ---------- 現在地 ----------

function setPosition(ll, acc, manual, time = Date.now()) {
  state.pos = { ll, acc, manual, time };
  const moved = state.posElev ? distanceM(state.posElev.ll, ll) : Infinity;
  // コースの外では現在地の標高は使わない（下見モードはティーの標高を使う）ので取りに行かない
  if (moved >= ELEV_REFRESH_M && (manual || !isOffsite(state.pos))) {
    const asked = ll;
    // 近くなら新しい標高が届くまで前の値を使い、大きく動いたら「取得中」にする
    const keep = moved < ELEV_RESET_M;
    state.posElev = { ll, elev: keep ? state.posElev.elev : null, source: keep ? state.posElev.source : null };
    getElevation(ll[0], ll[1]).then((r) => {
      if (state.posElev && state.posElev.ll === asked) { state.posElev.elev = r.elev; state.posElev.source = r.source; render(); }
    });
  }
  render();
}

let watchId = null;
function startGPS() {
  if (!('geolocation' in navigator)) { $('gpsStatus').textContent = 'この端末はGPSに対応していません'; return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.gpsError = null;
      if (state.manualMode) return; // 指定中は無視。解除後は GPS が届いた時点で置き換わる
      setPosition([p.coords.latitude, p.coords.longitude], p.coords.accuracy, false, p.timestamp || Date.now());
      checkAutoHole();
    },
    (err) => {
      state.gpsError = err.code;
      const msg = { 1: '位置情報が許可されていません（設定で許可してください）', 2: '現在地を取れません', 3: '現在地の取得に時間がかかっています' }[err.code] || err.message;
      $('gpsStatus').innerHTML = '';
      const s = document.createElement('span');
      s.className = 'bad';
      s.textContent = msg;
      $('gpsStatus').append(s);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
}

// 画面を消さない（プレー中に毎回ロック解除しなくて済むように）
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    $('wakeStatus').textContent = '画面ON固定';
    wakeLock.addEventListener('release', () => { $('wakeStatus').textContent = ''; });
  } catch { $('wakeStatus').textContent = ''; }
}
// スリープから戻ったら画面ON固定と GPS の監視をやり直す（止まったままの位置を使わないように）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  startGPS();
  render();
});
// 位置が古くなったことを画面に出すため、定期的に描き直す
// 端末が止まっていると位置が届かないことがあるので、自動切り替えの判定も定期的に行う
setInterval(() => { if (state.pos && !state.pos.manual) { render(); checkAutoHole(); } }, 5000);

// ---------- 地図タップ ----------

map.on('click', (e) => {
  const ll = [e.latlng.lat, e.latlng.lng];
  if (state.manualMode) {
    setPosition(ll, 0, true);
    return;
  }
  state.measure = ll;
  render();
});

function clearMeasure() {
  state.measure = null;
  measureLayer.clearLayers();
  $('measureRow').classList.add('hidden');
}

// ---------- 表示更新 ----------

function distLabel(a, b, text) {
  return L.tooltip({ permanent: true, direction: 'center', className: 'dist-label' })
    .setLatLng([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]).setContent(text);
}

/** 現在地がコースの外か（コースの範囲 bbox から OFFSITE_M 以上離れている） */
function isOffsite(pos) {
  const b = state.course?.bbox;
  if (!pos || !b || pos.manual) return false; // 手で指定した位置は常にコース内として扱う
  // 誤差の大きい最初の測位でコース外と誤判定しないよう、誤差分（最大300m）を差し引く
  return distanceToBbox(pos.ll, b) - Math.min(pos.acc || 0, 300) > OFFSITE_M;
}

function isStale(pos) {
  return !!(pos && !pos.manual && Date.now() - pos.time > STALE_MS);
}

/** 基準にするティー（レギュラー優先） */
function regularTee(hole) {
  const tees = hole?.tees || [];
  return tees.find((t) => t.name === 'レギュラー') || tees[0] || null;
}

/**
 * 距離を測る基準点。コース内なら現在地（手で指定した位置を含む）、
 * コースの外にいる・GPS が使えないときはティー（下見モード）
 */
function basePoint(hole) {
  const pos = state.pos;
  if (pos && !isOffsite(pos) && !state.previewForced) {
    return { ll: pos.ll, elev: state.posElev?.elev ?? null, kind: pos.manual ? 'manual' : 'gps' };
  }
  const tee = regularTee(hole);
  if (tee) return { ll: [tee.pos[0], tee.pos[1]], elev: tee.pos[2] ?? tee.__elev ?? null, kind: 'tee', teeName: tee.name || '' };
  return null;
}

function render() {
  const hole = currentHole();
  const pos = state.pos;
  const green = hole ? pickGreen(hole, activeGreenName()) : null;
  const ref = basePoint(hole);
  const preview = ref?.kind === 'tee';

  // 現在地のマーカーとグリーンへの線（下見モードではティーから線を引く）
  posLayer.clearLayers();
  if (pos && !isOffsite(pos)) {  // 手で指定した位置もここで描く（isOffsite は manual を除く）
    if (pos.acc > 0) L.circle(pos.ll, { radius: pos.acc, color: '#2d8cff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(posLayer);
    L.circleMarker(pos.ll, { radius: 8, color: '#fff', weight: 3, fillColor: pos.manual ? '#ff9f0a' : '#2d8cff', fillOpacity: 1, interactive: false }).addTo(posLayer);
  }
  // 現在地→グリーンの黄色い線（下見中はティー→グリーンのオレンジの線と重なるので引かない）
  if (ref && ref.kind !== 'tee' && green && !state.measure) L.polyline([ref.ll, green.center], { color: '#ffd60a', weight: 2, interactive: false }).addTo(posLayer);

  // 下見モードの案内
  const pv = $('previewNote');
  pv.classList.toggle('hidden', !preview);
  if (preview) {
    let why;
    if (state.previewForced) why = '「下見」ボタンで切り替え中。もう一度押すと現在地に戻ります';
    else if (!pos) why = state.gpsError ? 'GPS が使えないため' : '現在地を取得中のため';
    else if (isStale(pos)) why = 'GPS の更新が止まっていて、最後の位置がコースの外のため';
    else why = `コースから約${(distanceToBbox(pos.ll, state.course.bbox) / 1000).toFixed(1)}km 離れているため`;
    pv.textContent = `下見モード：ティー${ref.teeName ? `（${ref.teeName}）` : ''}からの距離です（${why}）`;
  }
  $('greenRow').classList.toggle('preview', preview);

  // GPS の状態
  const ageSec = pos && !pos.manual ? Math.round((Date.now() - pos.time) / 1000) : 0;
  const stale = ageSec * 1000 > STALE_MS;
  if (pos) {
    $('gpsStatus').innerHTML = '';
    const s = document.createElement('span');
    if (pos.manual) s.textContent = '位置: 手で指定中';
    else if (stale) { s.className = 'bad'; s.textContent = `GPS ${ageSec}秒前の位置（更新が止まっています）`; }
    else if (isOffsite(pos)) s.textContent = 'コースの外にいます';
    else s.textContent = `GPS 誤差 ±${Math.round(pos.acc)}m`;
    $('gpsStatus').append(s);
  }
  const poor = ref?.kind === 'gps' && (pos.acc > POOR_ACCURACY_M || stale);
  $('greenRow').classList.toggle('poor', !!poor);

  // グリーンまでの距離
  if (!hole) return;
  const gs = usableGreens(hole);
  $('greenSwitch').classList.toggle('hidden', gs.length < 2);
  if (gs.length >= 2) {
    const next = gs[(gs.indexOf(green) + 1) % gs.length];
    const b = $('btnGreen');
    b.innerHTML = '';
    const cur = document.createElement('b');
    cur.textContent = `${green.name}グリーン`;
    b.append(cur, ` 使用中　⇄ ${next.name}に切替`);
  }
  const note = $('holeNote');
  if (!green) {
    note.textContent = 'このホールのグリーンはまだ登録されていません。地図をタップすると、その地点までの距離を測れます。'
      + (state.course?.__local ? '（この端末で編集したデータを使っています。メニューから新しいデータに戻せます）' : '');
    note.classList.remove('hidden');
  } else if (!ref) {
    note.textContent = state.previewForced || state.pos
      ? 'このホールはティーが未登録のため、下見の距離を出せません。'
      : '現在地を取得しています…';
    note.classList.remove('hidden');
  } else note.classList.add('hidden');

  const gd = ref && green ? greenDistances(ref.ll, green) : null;
  $('dFront').textContent = yd(gd?.front);
  $('dCenter').innerHTML = '';
  $('dCenter').append(yd(gd?.center));
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = 'y';
  $('dCenter').append(unit);
  $('dBack').textContent = yd(gd?.back);

  // 高低差（現在地 → グリーン中央）
  const greenElev = green ? (green.center[2] ?? green.__elev) : null;
  const diff = elevationDiff(ref?.elev, greenElev);
  const er = $('elevRow');
  er.innerHTML = '';
  if (diff == null) {
    er.textContent = !green ? '' : ref && ref.kind !== 'tee' && ref.elev == null ? '高低差 取得中…' : '高低差 ---';
  } else {
    const span = document.createElement('span');
    const m = Math.round(Math.abs(diff));
    if (m < 1) span.textContent = '高低差 ほぼ平坦';
    else if (diff > 0) { span.className = 'up'; span.textContent = `↑ ${m}m 打ち上げ`; }
    else { span.className = 'down'; span.textContent = `↓ ${m}m 打ち下ろし`; }
    er.append(span);
  }

  // ハザード（現在地より前にあるものだけ、近い順）
  const list = $('hazardList');
  list.innerHTML = '';
  if (ref && green) {
    for (const { hazard, dist } of hazardsAhead(ref.ll, hole.hazards || [], green.center, green.name)) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = (HAZARD_TYPES[hazard.type] || HAZARD_TYPES.other).color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = hazard.label || (HAZARD_TYPES[hazard.type] || HAZARD_TYPES.other).label;
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = dist.carry != null ? `${yd(dist.reach)} / 越え ${yd(dist.carry)}` : `${yd(dist.reach)}`;
      const u = document.createElement('small');
      u.textContent = ' y';
      d.append(u);
      li.append(dot, name, d);
      list.append(li);
    }
  }

  // タップ地点の計測（現在地→タップ地点→グリーン）
  measureLayer.clearLayers();
  if (state.measure) {
    const m = state.measure;
    L.circleMarker(m, { radius: 7, color: '#000', weight: 2, fillColor: '#ffd60a', fillOpacity: 1, interactive: false }).addTo(measureLayer);
    const parts = [];
    if (ref) {
      L.polyline([ref.ll, m], { color: '#ffd60a', weight: 3, interactive: false }).addTo(measureLayer);
      distLabel(ref.ll, m, `${yd(distanceM(ref.ll, m))}y`).addTo(measureLayer);
      parts.push(`${ref.kind === 'tee' ? 'ティー' : '現在地'}から ${yd(distanceM(ref.ll, m))}y`);
    }
    if (green) {
      L.polyline([m, green.center], { color: '#ffd60a', weight: 3, dashArray: '6 6', interactive: false }).addTo(measureLayer);
      distLabel(m, green.center, `${yd(distanceM(m, green.center))}y`).addTo(measureLayer);
      parts.push(`グリーンまで ${yd(distanceM(m, green.center))}y`);
    }
    const waiting = !ref && state.pos ? 'ティーが未登録です' : '現在地を待っています';
    $('measureText').textContent = '📍 タップ地点: ' + (parts.join(' ・ ') || waiting);
    $('measureRow').classList.remove('hidden');
  }
}

// ---------- ボタン ----------

// 地図を大きく（パネルを畳む）。選んだ状態は端末に覚えておく
function setCompact(on) {
  document.body.classList.toggle('compact', on);
  $('btnPanel').textContent = on ? '▲ 詳細を表示' : '▼ 地図を大きく';
  $('btnPanel').setAttribute('aria-expanded', String(!on));
  try { localStorage.setItem('golfnavi.compact', on ? '1' : '0'); } catch { /* 保存できなくても切り替えは効く */ }
}
$('btnPanel').onclick = () => {
  setCompact(!document.body.classList.contains('compact'));
  // 枠の大きさが変わったので、ホール全体が収まるように合わせ直す
  map.invalidateSize();
  fitHole();
};
try { setCompact(localStorage.getItem('golfnavi.compact') === '1'); } catch { setCompact(false); }

// ---------- GPS でホールを自動で切り替える ----------

function checkAutoHole() {
  const pos = state.pos;
  if (!state.autoHole || !state.holes.length || !pos || pos.manual || state.previewForced || isOffsite(pos) || isStale(pos)) {
    state.autoTracker.candidate = -1; // 判定しない間はとどまった時間を数えない
    return;
  }
  const green = pickGreen(currentHole(), activeGreenName());
  const i = decideAutoHole({
    pos: pos.ll, acc: pos.acc, now: Date.now(), holes: state.holes, idx: state.idx,
    currentGreen: green?.center ?? null, tracker: state.autoTracker,
  });
  if (i < 0) return;
  showHole(i);
  const { nine, hole } = state.holes[i];
  toast(`${nine.name} ${hole.no}番に切り替えました（GPS）`);
}

/** 手でホールを変えたとき: その地点から離れるまで自動切り替えを止める */
function showHoleByHand(i) {
  // 位置が使える（GPS・精度良し・新しい）ならその地点を、使えなければ次に届いた良い位置を基準にする
  const p = state.pos;
  const good = p && !p.manual && !isStale(p) && p.acc <= AUTO_HOLE.MAX_ACC_M ? p.ll : null;
  markManual(state.autoTracker, good);
  showHole(i);
}

try { state.autoHole = localStorage.getItem('golfnavi.autoHole') !== '0'; } catch { /* 既定はオン */ }
$('chkAutoHole').checked = state.autoHole;
$('chkAutoHole').onchange = () => {
  state.autoHole = $('chkAutoHole').checked;
  try { localStorage.setItem('golfnavi.autoHole', state.autoHole ? '1' : '0'); } catch { /* 保存できなくても今回は効く */ }
};

$('btnPrev').onclick = () => state.holes.length && showHoleByHand(state.idx - 1);
$('btnNext').onclick = () => state.holes.length && showHoleByHand(state.idx + 1);
$('btnMenu').onclick = openSetup;
$('btnFit').onclick = fitHole;
$('btnMe').onclick = () => {
  if (!state.pos) { toast('現在地をまだ取れていません'); return; }
  if (isOffsite(state.pos)) { toast('コースの外にいるため、現在地へは移動しません'); return; }  // 手で指定した位置は対象外
  map.setView(state.pos.ll, Math.max(map.getZoom(), 17));
};

// ---------- ホール一覧（下見用） ----------

function openHoleList() {
  if (!state.holes.length) { openSetup(); return; }
  const ul = $('holeList');
  ul.innerHTML = '';
  state.holes.forEach(({ nine, hole }, i) => {
    const li = document.createElement('li');
    if (i === state.idx) li.className = 'cur';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = `${i + 1}H`;
    const name = document.createElement('span'); name.className = 'name';
    name.textContent = `${nine.name} ${hole.no}番` + (hole.par ? `  Par${hole.par}` : '');
    const y = document.createElement('span'); y.className = 'y';
    const g = pickGreen(hole, state.holeGreen[i] ?? state.greenName);
    const t = regularTee(hole);
    y.textContent = !g ? '未登録' : t ? `${yd(distanceM(t.pos, g.center))}y` : 'ティー未登録';
    li.append(n, name, y);
    li.onclick = () => { $('holesSheet').classList.add('hidden'); showHoleByHand(i); };
    ul.append(li);
  });
  $('holesSheet').classList.remove('hidden');
}
$('holeTitle').onclick = openHoleList;
$('holeTitle').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHoleList(); } };
$('btnCloseHoles').onclick = () => $('holesSheet').classList.add('hidden');
$('btnGreen').onclick = switchGreen;
$('btnMeasureClear').onclick = () => { clearMeasure(); render(); };
$('btnPreview').onclick = () => {
  state.previewForced = !state.previewForced;
  $('btnPreview').classList.toggle('on', state.previewForced);
  $('btnPreview').textContent = state.previewForced ? '下見中' : '下見';
  if (state.previewForced && state.manualMode) $('btnManual').click(); // 手で指定中なら解除
  clearMeasure();
  fitHole();
  render();
};
$('btnManual').onclick = () => {
  state.manualMode = !state.manualMode;
  $('btnManual').classList.toggle('on', state.manualMode);
  $('btnManual').textContent = state.manualMode ? '指定中' : '位置指定';
  if (state.manualMode) toast('地図をタップした場所を現在地として計算します');
};
$('selCourse').onchange = fillNines;
$('btnCloseSetup').onclick = () => $('setupSheet').classList.add('hidden');
$('btnEditor').onclick = () => { location.href = 'editor.html'; };
$('btnStart').onclick = async () => {
  try {
    // 同じコース・同じ前後半ならホールはそのまま（グリーンだけ変えたいとき1番に戻らないように）。
    // ホールごとの切り替えは消して、設定のグリーンに揃える
    const courseId = $('selCourse').value;
    const nines = [$('selOut').value, $('selIn').value];
    const r = loadRound();
    const same = r && r.courseId === courseId && r.nines?.join() === nines.join();
    await startRound(courseId, nines, same ? r.idx || 0 : 0, $('selGreen').value, {});
    $('setupSheet').classList.add('hidden');
    keepAwake();
  } catch (e) { toast(e.message); }
};
$('btnPrefetch').onclick = async () => {
  const course = await loadCourse($('selCourse').value).catch(() => null);
  if (!course?.bbox) { $('prefetchStatus').textContent = 'コースの範囲（bbox）がありません'; return; }
  if (!('caches' in window)) { $('prefetchStatus').textContent = 'このブラウザでは保存できません'; return; }
  $('btnPrefetch').disabled = true;
  try {
    // ブラウザが容量不足のときに保存データを勝手に消さないよう頼む
    await navigator.storage?.persist?.();
    const r = await prefetchCourseTiles(course.bbox, (done, total) => {
      $('prefetchStatus').textContent = `保存中… ${done} / ${total}`;
    });
    $('prefetchStatus').textContent = r.failed ? `保存しました（${r.failed} 枚失敗。もう一度押すと失敗分だけ取り直します）` : `保存しました（${r.total} 枚）`;
  } catch (e) {
    $('prefetchStatus').textContent = `保存できませんでした: ${e.message}`;
  } finally {
    $('btnPrefetch').disabled = false;
  }
};

// ---------- 起動 ----------

$('verStatus').textContent = `v${APP_VERSION}`;
setupPWA();
startGPS();
keepAwake();
const round = loadRound();
if (round) {
  startRound(round.courseId, round.nines, round.idx || 0, round.green, round.holeGreen).catch((e) => { toast(e.message); openSetup(); });
} else {
  openSetup();
}
