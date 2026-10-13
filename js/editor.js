// コース登録画面: 航空写真をタップしてティー・グリーン・ハザードを登録する
/* global L */
import { getElevation } from './elev.js';
import { centroid } from './geo.js';
import { createMap, drawOutline, drawHole, HAZARD_TYPES } from './mapbase.js';
import {
  listCourses, loadCourse, saveCourseLocal, discardCourseLocal, downloadCourse, validateCourse,
  greenNames, isHoleRegistered,
} from './store.js';
import { setupPWA, toast } from './pwa.js';

const $ = (id) => document.getElementById(id);
const HINTS = {
  tee: 'ティーの位置をタップ（同じ種類のティーは置き換え）',
  gcenter: '{G}グリーンの中央をタップ',
  gfront: '{G}グリーンの手前の端をタップ',
  gback: '{G}グリーンの奥の端をタップ',
  gpoly: '{G}グリーンの縁を順にタップし、「形を確定」（3点以上）',
  hpoint: 'ハザードをタップ。1回目=手前（または代表点）、続けてもう1回=奥',
  hpoly: 'ハザードの縁を順にタップし、「形を確定」（3点以上）',
  pickWater: '青い点線の池をタップすると、このホールの池ハザードに追加します',
  hline: 'OBの杭などの線を順にタップし、「形を確定」（2点以上）。種類は右の欄で選べます',
};

// 名前に $ などが含まれても置換の記号として解釈されないよう、関数で差し込む
const hintFor = (mode) => HINTS[mode].replace('{G}', () => state.greenName);

const state = { course: null, nineIdx: 0, holeIdx: 0, mode: null, poly: [], lastHazard: null, greenName: null };

const map = createMap($('map'));
map.setView([36.36, 139.332], 16);
const holeLayer = L.layerGroup().addTo(map);
const refLayer = L.layerGroup().addTo(map);
const draftLayer = L.layerGroup().addTo(map);
let outlineLayer = null;

for (const [k, v] of Object.entries(HAZARD_TYPES)) $('selHzType').add(new Option(v.label, k));

// ---------- 読み込み ----------

async function init() {
  const courses = await listCourses();
  for (const c of courses) $('selCourse').add(new Option(c.name, c.id));
  if (courses.length) await openCourse(courses[0].id);
}

async function openCourse(id) {
  try {
    state.course = await loadCourse(id);
  } catch (e) { toast(e.message); return; }
  $('selCourse').value = id;
  $('selNine').innerHTML = '';
  state.course.nines.forEach((n, i) => $('selNine').add(new Option(n.name, i)));
  if (outlineLayer) outlineLayer.remove();
  outlineLayer = drawOutline(map, state.course);
  drawReference();
  fillGreenSelects();
  selectHole(0, 0, true);
  if (state.course.bbox) {
    const b = state.course.bbox;
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]]);
  }
  showSaveStatus();
}

function hole() { return state.course.nines[state.nineIdx].holes[state.holeIdx]; }

const holeLabel = (h) => `${h.no}番${isHoleRegistered(h) ? ' ✓' : ''}${h.greens.filter((g) => g.center).length >= 2 ? '（2G）' : ''}`;

// ---------- 2グリーン ----------

function fillGreenSelects() {
  const names = greenNames(state.course);
  if (!names.includes(state.greenName)) state.greenName = names[0];
  $('selEdGreen').innerHTML = '';
  for (const n of names) $('selEdGreen').add(new Option(`${n}グリーン`, n));
  $('selEdGreen').value = state.greenName;
  const keep = $('selHzGreen').value;
  $('selHzGreen').innerHTML = '';
  $('selHzGreen').add(new Option('どのグリーンでも', ''));
  for (const n of names) $('selHzGreen').add(new Option(`${n}グリーン用`, n));
  $('selHzGreen').value = names.includes(keep) ? keep : '';
}

/** ハザードに「どのグリーン用か」を付ける（どのグリーンでも使うものには付けない） */
function withGreen(hz) {
  const g = $('selHzGreen').value;
  if (g) hz.green = g;
  return hz;
}

$('selEdGreen').onchange = () => {
  state.greenName = $('selEdGreen').value;
  cancelPoly();
  if (state.mode) $('hint').textContent = hintFor(state.mode);
  redraw(false);
};

// 呼び名の変更（例: A・B → ベント・高麗）。並び順で対応させ、登録済みのグリーンとハザードも付け替える
$('btnGreenNames').onclick = () => {
  const old = greenNames(state.course);
  const input = prompt('グリーンの呼び名を「、」区切りで入力してください（例: ベント、高麗 / A、B / 左、右）', old.join('、'));
  if (input == null) return;
  const raw = input.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
  const names = [...new Set(raw)];
  if (names.length === 0) { toast('名前を1つ以上入れてください'); return; }
  if (names.length !== raw.length) { toast('同じ名前が2回入っています'); return; }
  // 減らすと、付け替えられなかったグリーンが新しい名前と重なったり選べなくなったりするので認めない
  if (names.length < old.length) { toast(`呼び名は${old.length}個以上入れてください（今: ${old.join('、')}）`); return; }
  const rename = new Map(old.slice(0, names.length).map((o, i) => [o, names[i]]));
  for (const n of state.course.nines) {
    for (const h of n.holes) {
      for (const g of h.greens) if (rename.has(g.name)) g.name = rename.get(g.name);
      for (const z of h.hazards) if (z.green && rename.has(z.green)) z.green = rename.get(z.green);
    }
  }
  state.course.greenNames = names;
  state.greenName = rename.get(state.greenName) || names[0];
  fillGreenSelects();
  changed();
};

function selectHole(nineIdx, holeIdx, keepView) {
  state.nineIdx = nineIdx;
  state.holeIdx = holeIdx;
  $('selNine').value = nineIdx;
  $('selHole').innerHTML = '';
  state.course.nines[nineIdx].holes.forEach((h, i) => $('selHole').add(new Option(holeLabel(h), i)));
  $('selHole').value = holeIdx;
  $('selHzGreen').value = ''; // 前のホールの「○○グリーン用」を引き継がない
  $('selPar').value = hole().par ?? '';
  $('inpHdcp').value = hole().hdcp ?? '';
  cancelPoly();
  redraw(keepView ? false : true);
}

// OSM 由来の池（参考表示。選ぶとハザードになる）
function drawReference() {
  refLayer.clearLayers();
  for (const w of state.course.reference?.water || []) {
    const poly = L.polygon(w.polygon, { color: '#1f5fd6', weight: 2, dashArray: '4 4', fillOpacity: 0.05 }).addTo(refLayer);
    poly.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.mode !== 'pickWater') { onMapTap([e.latlng.lat, e.latlng.lng]); return; }
      const label = $('inpHzLabel').value.trim() || w.label || '池';
      const h = hole();
      if (h.hazards.some((z) => z.osmId === w.osmId)) { toast('この池はもう追加済みです'); return; }
      h.hazards.push(withGreen({ type: $('selHzType').value === 'lateral_water' ? 'lateral_water' : 'water', label, points: [], polygon: w.polygon.map((p) => [p[0], p[1]]), osmId: w.osmId }));
      changed();
      toast(`「${label}」を追加しました`);
    });
  }
}

// ---------- タップで登録 ----------

/** 点を [緯度, 経度, 標高] にする。標高は後から非同期で埋める */
function pointWithElev(ll) {
  const p = [round6(ll[0]), round6(ll[1])];
  const h = hole(); // 標高が届く前にホールを切り替えても、元のホールに記録する
  getElevation(p[0], p[1]).then((r) => {
    if (r.elev != null) {
      p[2] = r.elev;
      h.elevSource = r.source;
      changed(false);
    }
  });
  return p;
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** 選んでいる呼び名のグリーンを返す（無ければ作る） */
function ensureGreen() {
  const h = hole();
  let g = h.greens.find((x) => x.name === state.greenName);
  if (!g) {
    g = { name: state.greenName, center: null, front: null, back: null, polygon: null };
    h.greens.push(g);
    const order = greenNames(state.course);
    h.greens.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  return g;
}

function onMapTap(ll) {
  const h = hole();
  switch (state.mode) {
    case 'tee': {
      const name = $('selTee').value;
      h.tees = (h.tees || []).filter((t) => t.name !== name);
      h.tees.push({ name, pos: pointWithElev(ll) });
      break;
    }
    case 'gcenter': ensureGreen().center = pointWithElev(ll); break;
    case 'gfront': ensureGreen().front = pointWithElev(ll); break;
    case 'gback': ensureGreen().back = pointWithElev(ll); break;
    case 'hpoint': {
      // 直前に置いた1点のハザードがあれば、2回目のタップは「奥」
      const last = state.lastHazard;
      if (last && h.hazards.includes(last) && last.points.length === 1) {
        last.points.push([round6(ll[0]), round6(ll[1])]);
        state.lastHazard = null;
        $('hint').textContent = '奥を登録しました。次のハザードをタップできます';
      } else {
        const type = $('selHzType').value;
        const hz = withGreen({ type, label: $('inpHzLabel').value.trim() || HAZARD_TYPES[type].label, points: [[round6(ll[0]), round6(ll[1])]], polygon: null });
        h.hazards.push(hz);
        state.lastHazard = hz;
        $('hint').textContent = '手前を登録しました。奥もあればもう1回タップ（無ければ別のボタンへ）';
      }
      break;
    }
    case 'gpoly':
    case 'hpoly':
    case 'hline':
      state.poly.push([round6(ll[0]), round6(ll[1])]);
      drawDraft();
      return;
    default:
      $('hint').textContent = 'まず上のボタンで、何を登録するか選んでください';
      return;
  }
  changed();
}

map.on('click', (e) => onMapTap([e.latlng.lat, e.latlng.lng]));

function drawDraft() {
  draftLayer.clearLayers();
  if (!state.poly.length) return;
  const pts = state.mode === 'hline' ? state.poly : [...state.poly, state.poly[0]];
  L.polyline(pts, { color: '#ffd60a', weight: 2, dashArray: '4 4' }).addTo(draftLayer);
  for (const p of state.poly) L.circleMarker(p, { radius: 4, color: '#ffd60a' }).addTo(draftLayer);
}

function cancelPoly() {
  state.poly = [];
  draftLayer.clearLayers();
}

$('btnPolyDone').onclick = () => {
  const need = state.mode === 'hline' ? 2 : 3;
  if (state.poly.length < need) { toast(`${need}点以上タップしてください`); return; }
  const h = hole();
  if (state.mode === 'hline') {
    const type = $('selHzType').value;
    h.hazards.push(withGreen({ type, label: $('inpHzLabel').value.trim() || HAZARD_TYPES[type].label, points: [], polygon: null, line: state.poly }));
  } else if (state.mode === 'gpoly') {
    const g = ensureGreen();
    g.polygon = state.poly;
    // 中央が未登録なら、形の重心で代用する
    if (!g.center) g.center = pointWithElev(centroid(state.poly));
  } else {
    const type = $('selHzType').value;
    h.hazards.push(withGreen({ type, label: $('inpHzLabel').value.trim() || HAZARD_TYPES[type].label, points: [], polygon: state.poly }));
  }
  state.poly = [];
  draftLayer.clearLayers();
  changed();
};
$('btnPolyUndo').onclick = () => { state.poly.pop(); drawDraft(); };
$('btnPolyCancel').onclick = cancelPoly;

function setMode(mode) {
  state.mode = state.mode === mode ? null : mode;
  state.lastHazard = null;
  cancelPoly();
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('hint').textContent = state.mode ? hintFor(state.mode) : '上のボタンを選んでから、地図をタップしてください。';
  $('polyBar').classList.toggle('hidden', !['gpoly', 'hpoly', 'hline'].includes(state.mode));
}
document.querySelectorAll('.tools button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

// ---------- 表示と保存 ----------

function redraw(fit) {
  holeLayer.clearLayers();
  const bounds = drawHole(holeLayer, hole(), state.greenName, { requireCenter: false });
  if (fit && bounds) map.fitBounds(bounds.pad(0.3), { maxZoom: 18 });
  renderItems();
}

function renderItems() {
  const h = hole();
  const ul = $('items');
  ul.innerHTML = '';
  const add = (text, onDelete) => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = text;
    li.append(s);
    if (onDelete) {
      const b = document.createElement('button');
      b.textContent = '削除';
      b.onclick = () => { onDelete(); changed(); };
      li.append(b);
    }
    ul.append(li);
  };
  const el = (p) => (p && p[2] != null ? `（標高 ${p[2]}m）` : '（標高 取得中/なし）');
  for (const t of h.tees || []) add(`ティー ${t.name} ${el(t.pos)}`, () => { h.tees = h.tees.filter((x) => x !== t); });
  for (const g of h.greens) {
    const n = `${g.name}グリーン`;
    if (g.center) add(`${n} 中央 ${el(g.center)}`, () => { g.center = null; });
    if (g.front) add(`${n} 前`, () => { g.front = null; });
    if (g.back) add(`${n} 奥`, () => { g.back = null; });
    if (g.polygon) add(`${n} の形（${g.polygon.length}点）`, () => { g.polygon = null; });
  }
  for (const z of h.hazards || []) {
    const kind = z.line ? `線 ${z.line.length}点` : z.polygon ? `形 ${z.polygon.length}点` : `${z.points.length === 2 ? '手前・奥' : '1点'}`;
    const target = z.green ? `・${z.green}グリーン用` : '';
    add(`${HAZARD_TYPES[z.type]?.label || z.type}: ${z.label}（${kind}${target}）`, () => { h.hazards = h.hazards.filter((x) => x !== z); });
  }
  if (!ul.children.length) add('まだ何も登録されていません');
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const ok = saveCourseLocal(state.course);
  state.course.__local = true;
  delete state.course.__publishedNewer; // 保存した時点で端末内のほうが新しい
  showSaveStatus(ok ? null : '端末に保存できませんでした（容量不足の可能性）');
  // ホール一覧の ✓ を更新
  const opt = $('selHole').options[state.holeIdx];
  if (opt) opt.text = holeLabel(hole());
}
function changed(redrawNow = true) {
  // 中身が空になったグリーンは消す
  for (const n of state.course.nines) {
    for (const h of n.holes) h.greens = h.greens.filter((g) => g.center || g.front || g.back || g.polygon);
  }
  if (redrawNow) redraw(false);
  else renderItems();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
// 保存待ちのまま「プレー画面へ」などで離れても、直前の編集を失わない
addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });

function showSaveStatus(error) {
  const total = state.course.nines.reduce((s, n) => s + n.holes.length, 0);
  const done = state.course.nines.flatMap((n) => n.holes).filter(isHoleRegistered).length;
  $('saveStatus').textContent = error
    || `この端末に自動保存しています。登録済み ${done} / ${total} ホール。` +
       (state.course.__local ? '他の端末で使うには「ファイルに書き出す」→ courses/ に置いて公開してください。' : '') +
       (state.course.__publishedNewer ? `【注意】公開版のほうが新しくなっています（${state.course.__publishedNewer}）。公開版を使うなら「端末内の編集を捨てる」を押してください。` : '');
}

// ---------- 上部の選択 ----------

$('selCourse').onchange = () => openCourse($('selCourse').value);
$('selNine').onchange = () => selectHole(Number($('selNine').value), 0);
$('selHole').onchange = () => selectHole(state.nineIdx, Number($('selHole').value));
$('selPar').onchange = () => { hole().par = $('selPar').value ? Number($('selPar').value) : null; changed(false); };
$('inpHdcp').onchange = () => { hole().hdcp = $('inpHdcp').value ? Number($('inpHdcp').value) : null; changed(false); };
$('btnFit').onclick = () => redraw(true);
$('btnMe').onclick = () => navigator.geolocation?.getCurrentPosition(
  (p) => map.setView([p.coords.latitude, p.coords.longitude], 18),
  () => toast('現在地を取れません'),
  { enableHighAccuracy: true, timeout: 15000 },
);

// ---------- ファイル ----------

$('btnExport').onclick = () => downloadCourse(state.course);
$('btnImport').onclick = () => $('fileImport').click();
$('fileImport').onchange = async () => {
  const f = $('fileImport').files[0];
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    // v0.1 で書き出したファイル（呼び名なし）は、同じコースの呼び名で移行する
    const fallbackNames = parsed?.id === state.course?.id ? state.course.greenNames : undefined;
    const c = validateCourse(parsed, { fallbackNames });
    if (!confirm(`「${c.name}」を読み込み、この端末のデータを置き換えます。よろしいですか？`)) return;
    if (!saveCourseLocal(c)) { toast('端末に保存できませんでした（容量不足の可能性）。読み込みを中止しました'); return; }
    if (![...$('selCourse').options].some((o) => o.value === c.id)) $('selCourse').add(new Option(c.name, c.id));
    await openCourse(c.id);
    toast('読み込みました');
  } catch (e) {
    toast(`読み込めません: ${e.message}`);
  } finally {
    $('fileImport').value = '';
  }
};
$('btnDiscard').onclick = async () => {
  if (!confirm('この端末で編集した内容を捨てて、公開されているデータに戻します。書き出していない登録は消えます。よろしいですか？')) return;
  discardCourseLocal(state.course.id);
  await openCourse(state.course.id).catch(() => location.reload());
};

setupPWA();
init();
