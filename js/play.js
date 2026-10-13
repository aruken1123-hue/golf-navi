// プレー画面: 現在地からグリーン・ハザードまでの距離と高低差を出す
/* global L */
import { distanceM, toYards, greenDistances, hazardsAhead, elevationDiff } from './geo.js';
import { getElevation } from './elev.js';
import { createMap, drawOutline, drawHole, prefetchCourseTiles, HAZARD_TYPES } from './mapbase.js';
import { listCourses, loadCourse, loadRound, saveRound, roundHoles } from './store.js';
import { setupPWA, toast } from './pwa.js';
import { APP_VERSION } from './version.js';

const POOR_ACCURACY_M = 20; // これより誤差が大きいと数字を灰色にする
const ELEV_REFRESH_M = 5;   // これ以上動いたら現在地の標高を取り直す
const ELEV_RESET_M = 30;    // これ以上一気に動いたら、前の地点の標高は使わない
const STALE_MS = 15000;     // これより古い GPS の位置は「古い」として灰色にする

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
};

const map = createMap($('map'));
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
  const registered = course.nines.flatMap((n) => n.holes).filter((h) => h.green?.center).length;
  const total = course.nines.reduce((s, n) => s + n.holes.length, 0);
  $('dataStatus').textContent = `登録済み ${registered} / ${total} ホール` + (course.__local ? '（この端末で編集したデータ）' : '')
    + (course.__publishedNewer ? `。公開版のほうが新しい（${course.__publishedNewer}）ので、使うなら登録画面の「端末内の編集を捨てる」を押してください` : '');
}

async function startRound(courseId, nineIds, idx = 0) {
  state.course = await loadCourse(courseId);
  state.holes = roundHoles(state.course, nineIds);
  if (state.holes.length === 0) throw new Error('ホールがありません');
  if (outlineLayer) outlineLayer.remove();
  outlineLayer = drawOutline(map, state.course);
  saveRound({ courseId, nines: nineIds, idx });
  showHole(Math.min(idx, state.holes.length - 1));
}

// ---------- ホール表示 ----------

function currentHole() { return state.holes[state.idx]?.hole; }

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

  holeLayer.clearLayers();
  holeBounds = drawHole(holeLayer, hole);
  clearMeasure();
  fitHole();
  // グリーンの標高が未登録なら標高タイルから補う
  if (hole.green?.center && hole.green.center[2] == null && hole.__greenElev === undefined) {
    hole.__greenElev = null;
    getElevation(hole.green.center[0], hole.green.center[1]).then((r) => {
      hole.__greenElev = r.elev ?? undefined; // 取れなければ次にホールを開いたとき取り直す
      render();
    });
  }
  render();
}

function fitHole() {
  if (holeBounds) map.fitBounds(holeBounds.pad(0.15));
  else if (state.course?.bbox) {
    const b = state.course.bbox;
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]]);
  }
}

// ---------- 現在地 ----------

function setPosition(ll, acc, manual, time = Date.now()) {
  state.pos = { ll, acc, manual, time };
  const moved = state.posElev ? distanceM(state.posElev.ll, ll) : Infinity;
  if (moved >= ELEV_REFRESH_M) {
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
      if (state.manualMode) return; // 指定中は無視。解除後は GPS が届いた時点で置き換わる
      setPosition([p.coords.latitude, p.coords.longitude], p.coords.accuracy, false, p.timestamp || Date.now());
    },
    (err) => {
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
setInterval(() => { if (state.pos && !state.pos.manual) render(); }, 5000);

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

function render() {
  const hole = currentHole();
  const pos = state.pos;
  const green = hole?.green?.center ? hole.green : null;

  // 現在地のマーカーとグリーンへの線
  posLayer.clearLayers();
  if (pos) {
    if (pos.acc > 0) L.circle(pos.ll, { radius: pos.acc, color: '#2d8cff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(posLayer);
    L.circleMarker(pos.ll, { radius: 8, color: '#fff', weight: 3, fillColor: pos.manual ? '#ff9f0a' : '#2d8cff', fillOpacity: 1, interactive: false }).addTo(posLayer);
    if (green && !state.measure) L.polyline([pos.ll, green.center], { color: '#ffd60a', weight: 2, interactive: false }).addTo(posLayer);
  }

  // GPS の状態
  const ageSec = pos && !pos.manual ? Math.round((Date.now() - pos.time) / 1000) : 0;
  const stale = ageSec * 1000 > STALE_MS;
  if (pos) {
    $('gpsStatus').innerHTML = '';
    const s = document.createElement('span');
    if (pos.manual) s.textContent = '位置: 手で指定中';
    else if (stale) { s.className = 'bad'; s.textContent = `GPS ${ageSec}秒前の位置（更新が止まっています）`; }
    else s.textContent = `GPS 誤差 ±${Math.round(pos.acc)}m`;
    $('gpsStatus').append(s);
  }
  const poor = pos && !pos.manual && (pos.acc > POOR_ACCURACY_M || stale);
  $('greenRow').classList.toggle('poor', !!poor);

  // グリーンまでの距離
  if (!hole) return;
  const note = $('holeNote');
  if (!green) {
    note.textContent = 'このホールはまだ登録されていません。地図をタップすると、その地点までの距離を測れます。';
    note.classList.remove('hidden');
  } else note.classList.add('hidden');

  const gd = pos && green ? greenDistances(pos.ll, green) : null;
  $('dFront').textContent = yd(gd?.front);
  $('dCenter').innerHTML = '';
  $('dCenter').append(yd(gd?.center));
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = 'y';
  $('dCenter').append(unit);
  $('dBack').textContent = yd(gd?.back);

  // 高低差（現在地 → グリーン中央）
  const greenElev = green ? (green.center[2] ?? hole.__greenElev) : null;
  const diff = elevationDiff(state.posElev?.elev, greenElev);
  const er = $('elevRow');
  er.innerHTML = '';
  if (diff == null) {
    er.textContent = !green ? '' : pos && state.posElev?.elev == null ? '高低差 取得中…' : '高低差 ---';
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
  if (pos && green) {
    for (const { hazard, dist } of hazardsAhead(pos.ll, hole.hazards || [], green.center)) {
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
    if (pos) {
      L.polyline([pos.ll, m], { color: '#ffd60a', weight: 3, interactive: false }).addTo(measureLayer);
      distLabel(pos.ll, m, `${yd(distanceM(pos.ll, m))}y`).addTo(measureLayer);
      parts.push(`現在地から ${yd(distanceM(pos.ll, m))}y`);
    }
    if (green) {
      L.polyline([m, green.center], { color: '#ffd60a', weight: 3, dashArray: '6 6', interactive: false }).addTo(measureLayer);
      distLabel(m, green.center, `${yd(distanceM(m, green.center))}y`).addTo(measureLayer);
      parts.push(`グリーンまで ${yd(distanceM(m, green.center))}y`);
    }
    $('measureText').textContent = '📍 タップ地点: ' + (parts.join(' ・ ') || '現在地を待っています');
    $('measureRow').classList.remove('hidden');
  }
}

// ---------- ボタン ----------

$('btnPrev').onclick = () => state.holes.length && showHole(state.idx - 1);
$('btnNext').onclick = () => state.holes.length && showHole(state.idx + 1);
$('btnMenu').onclick = openSetup;
$('btnFit').onclick = fitHole;
$('btnMe').onclick = () => state.pos && map.setView(state.pos.ll, Math.max(map.getZoom(), 17));
$('btnMeasureClear').onclick = () => { clearMeasure(); render(); };
$('btnManual').onclick = () => {
  state.manualMode = !state.manualMode;
  $('btnManual').classList.toggle('on', state.manualMode);
  $('btnManual').textContent = state.manualMode ? '指定中（タップで移動）' : '位置を手で指定';
  if (state.manualMode) toast('地図をタップした場所を現在地として計算します');
};
$('selCourse').onchange = fillNines;
$('btnCloseSetup').onclick = () => $('setupSheet').classList.add('hidden');
$('btnEditor').onclick = () => { location.href = 'editor.html'; };
$('btnStart').onclick = async () => {
  try {
    await startRound($('selCourse').value, [$('selOut').value, $('selIn').value], 0);
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
  startRound(round.courseId, round.nines, round.idx || 0).catch((e) => { toast(e.message); openSetup(); });
} else {
  openSetup();
}
