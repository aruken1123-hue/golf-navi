// コース登録画面: 航空写真をタップしてティー・グリーン・ハザードを登録する
/* global L */
import { getElevation } from './elev.js';
import { centroid, distanceM, transformPoints } from './geo.js';
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

// 最後に開いていたコース・ハーフ・ホール（閉じて開き直しても、そこから続けられるように）
const EDITOR_POS_KEY = 'golfnavi.editorPos';
function loadEditorPos() {
  try { const p = JSON.parse(localStorage.getItem(EDITOR_POS_KEY)); return p && typeof p.courseId === 'string' ? p : null; } catch { return null; }
}
function saveEditorPos() {
  try { localStorage.setItem(EDITOR_POS_KEY, JSON.stringify({ courseId: state.course.id, nineIdx: state.nineIdx, holeIdx: state.holeIdx })); } catch { /* 覚えられなくても編集はできる */ }
}

async function init() {
  const courses = await listCourses();
  for (const c of courses) $('selCourse').add(new Option(c.name, c.id));
  if (!courses.length) return;
  const pos = loadEditorPos();
  if (pos && courses.some((c) => c.id === pos.courseId)) await openCourse(pos.courseId, pos);
  else await openCourse(courses[0].id);
}

async function openCourse(id, pos = null) {
  adjCancel(); // 調整中なら元に戻してから開く
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
  // 覚えていたホールが今のコースにあれば、そのホールを開いて寄せる
  const n = pos && state.course.nines[pos.nineIdx], h = n && n.holes[pos.holeIdx];
  if (h) { selectHole(pos.nineIdx, pos.holeIdx, false); showSaveStatus(); return; }
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
  adjCancel(); // 調整中に別のホールへ移ったら、元の位置に戻す
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
  saveEditorPos();
}

/** 前・次のホールへ（9番の次は次のハーフの1番、最後の次は最初へ） */
function stepHole(d) {
  if (state.poly.length && !confirm('描きかけの形があります。捨てて移りますか？')) return;
  const list = state.course.nines.flatMap((n, ni) => n.holes.map((_, hi) => [ni, hi]));
  const i = list.findIndex(([ni, hi]) => ni === state.nineIdx && hi === state.holeIdx);
  const [ni, hi] = list[(i + d + list.length) % list.length];
  selectHole(ni, hi);
}
$('btnPrevHole').onclick = () => stepHole(-1);
$('btnNextHole').onclick = () => stepHole(1);

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
  fetchElev(p, hole()); // 標高が届く前にホールを切り替えても、元のホールに記録する
  return p;
}

// 点ごとの、いちばん新しい標高の問い合わせ（後から動かした点に、古い場所の標高が書かれないように）
const elevReq = new WeakMap();
/** 点 p の今の場所の標高を取って p[2] に書く。取れなければ前の値のまま */
function fetchElev(p, h) {
  const id = {};
  elevReq.set(p, id);
  getElevation(p[0], p[1]).then((r) => {
    if (elevReq.get(p) !== id || r.elev == null) return;
    p[2] = r.elev;
    h.elevSource = r.source;
    changed(false);
  });
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
  if (adj) { if (!adj.vertex) moveTo(ll); return; } // 調整中は、タップした場所へ中心を動かす（点を動かすときは何もしない）
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
  if (mode) adjCancel();
  state.mode = state.mode === mode ? null : mode;
  state.lastHazard = null;
  cancelPoly();
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('hint').textContent = state.mode ? hintFor(state.mode) : '上のボタンを選んでから、地図をタップしてください。';
  $('polyBar').classList.toggle('hidden', !['gpoly', 'hpoly', 'hline'].includes(state.mode));
}
document.querySelectorAll('.tools button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

// ---------- 表示と保存 ----------

/** 地図の図形をタップしたとき: 登録の道具を選んでいる・調整中なら、ふつうの地図のタップとして扱う。そうでなければ修正画面 */
function onFeatureTap(item, ll) {
  if (state.mode || adj) { onMapTap(ll); return; }
  openEdit(describe(item));
}
const drawOpts = () => ({ requireCenter: false, onSelect: onFeatureTap });

function redraw(fit) {
  holeLayer.clearLayers();
  const bounds = drawHole(holeLayer, hole(), state.greenName, drawOpts());
  if (fit && bounds) map.fitBounds(bounds.pad(0.3), { maxZoom: 18 });
  renderItems();
}

function renderItems() {
  const h = hole();
  const ul = $('items');
  ul.innerHTML = '';
  const add = (d) => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = d.text;
    li.append(s);
    if (d.kind) {
      // 行をタップすると修正画面
      li.className = 'item';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      const c = document.createElement('span');
      c.className = 'chev';
      c.textContent = '›';
      li.append(c);
      li.onclick = () => openEdit(d);
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(d); } };
    }
    ul.append(li);
  };
  for (const t of h.tees || []) add(describe({ kind: 'tee', tee: t }));
  for (const g of h.greens) {
    for (const part of ['center', 'front', 'back', 'polygon']) if (g[part]) add(describe({ kind: 'green', green: g, part }));
  }
  for (const z of h.hazards || []) add(describe({ kind: 'hazard', hazard: z }));
  if (!ul.children.length) add({ text: 'まだ何も登録されていません' });
}

// ---------- 項目の修正画面 ----------

const TEE_NAMES = ['レギュラー', 'バック', 'フロント', 'レディース'];
const elevText = (p) => (p && p[2] != null ? `（標高 ${p[2]}m）` : '（標高 取得中/なし）');

/**
 * 項目（ティー・グリーンの各部・ハザード）の説明。一覧と修正画面で使う。
 * points: 位置の調整で動かす点、vertices: 1つずつ動かせる点（2点以上のときだけ）、del: 削除、fields: 修正できる欄
 */
function describe(item) {
  const h = hole();
  if (item.kind === 'tee') {
    const t = item.tee;
    return {
      item, kind: 'tee', label: `ティー ${t.name}`, text: `ティー ${t.name} ${elevText(t.pos)}`,
      points: () => [t.pos], vertices: null,
      del: () => { h.tees = h.tees.filter((x) => x !== t); },
      fields: (box) => {
        box.append(field('ティーの種類', select(TEE_NAMES.map((n) => [n, n]), t.name, (v) => {
          const other = (h.tees || []).find((x) => x !== t && x.name === v);
          if (other && !confirm(`${v}ティーはもう登録されています。置き換えますか？`)) return false;
          if (other) h.tees = h.tees.filter((x) => x !== other);
          t.name = v;
          return true;
        })));
      },
    };
  }
  if (item.kind === 'green') {
    const g = item.green, part = item.part;
    const n = `${g.name}グリーン`;
    const PART = { center: '中央', front: '前', back: '奥', polygon: 'の形' };
    return {
      item, kind: 'green',
      label: `${n}${part === 'polygon' ? 'の形' : ` ${PART[part]}`}`,
      text: part === 'polygon' ? `${n} の形（${g.polygon.length}点）` : `${n} ${PART[part]}${part === 'center' ? ` ${elevText(g.center)}` : ''}`,
      info: part === 'polygon' ? '「位置を調整」で形を動かすと、中央・前・奥も一緒に動きます。「点を1つずつ動かす」は形の点だけを動かします。' : '',
      // 形を動かすときは、中央・前・奥も一緒に動かす（形とずれないように）
      points: () => (part === 'polygon' ? greenPoints(g) : [g[part]]),
      vertices: part === 'polygon' ? () => g.polygon : null,
      del: () => { g[part] = null; },
      fields: null,
    };
  }
  const z = item.hazard;
  const kind = z.line ? `線 ${z.line.length}点` : z.polygon ? `形 ${z.polygon.length}点` : `${z.points.length === 2 ? '手前・奥' : '1点'}`;
  const target = z.green ? `・${z.green}グリーン用` : '';
  return {
    item, kind: 'hazard', label: `${HAZARD_TYPES[z.type]?.label || z.type}: ${z.label}`,
    text: `${HAZARD_TYPES[z.type]?.label || z.type}: ${z.label}（${kind}${target}）`,
    points: () => hazardPoints(z),
    vertices: () => hazardPoints(z),
    del: () => { h.hazards = h.hazards.filter((x) => x !== z); },
    fields: (box) => {
      box.append(
        field('種類', select(Object.entries(HAZARD_TYPES).map(([k, v]) => [k, v.label]), z.type, (v) => {
          // 名前が種類の名前のままなら、新しい種類の名前に変える
          if (z.label === (HAZARD_TYPES[z.type]?.label || '')) z.label = HAZARD_TYPES[v].label;
          z.type = v;
          return true;
        })),
        field('名前', textInput(() => z.label, (v) => { z.label = v || HAZARD_TYPES[z.type]?.label || 'ハザード'; })),
        field('どのグリーン用か', select([['', 'どのグリーンでも'], ...greenNames(state.course).map((gn) => [gn, `${gn}グリーン用`])], z.green || '', (v) => {
          if (v) z.green = v; else delete z.green;
          return true;
        })),
      );
    },
  };
}

/** 修正画面の欄（見出し付き） */
function field(label, control) {
  const l = document.createElement('label');
  l.className = 'edit-field';
  const s = document.createElement('span');
  s.textContent = label;
  l.append(s, control);
  return l;
}
/** 選ぶ欄。onPick が false を返したら元に戻す。変えたらすぐ保存する */
function select(options, value, onPick) {
  const sel = document.createElement('select');
  for (const [v, t] of options) sel.add(new Option(t, v));
  if (!options.some(([v]) => v === value)) sel.add(new Option(value, value)); // 一覧に無い値（読み込んだファイルの名前など）も出す
  sel.value = value;
  sel.onchange = () => {
    if (onPick(sel.value) === false) { sel.value = value; return; }
    value = sel.value;
    afterEdit();
  };
  return sel;
}
/** 文字の欄（入力を確定したら保存）。get は保存後の値（空にしたときの置き換えを欄に出すため） */
function textInput(get, onSet) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.maxLength = 30;
  inp.value = get();
  inp.onchange = () => { onSet(inp.value.trim()); inp.value = get(); afterEdit(); };
  return inp;
}

let editing = null; // 修正画面で開いている項目
let editOpenedAt = 0;
/** 調整中に、もう動かしたか */
const adjDirty = () => !!adj && (adj.vertex ? adj.points.some((p, i) => p[0] !== adj.orig[i][0] || p[1] !== adj.orig[i][1]) : !!(adj.dx || adj.dy || adj.rot));
function openEdit(d) {
  if (!d?.kind) return;
  // 描きかけの形・動かしかけの位置があれば、捨ててよいか確かめる（一覧の行は誤って触りやすいため）
  if (state.poly.length && !confirm('描きかけの形があります。捨てて修正画面を開きますか？')) return;
  if (adjDirty() && !confirm('調整中の位置の変更を捨てて、修正画面を開きますか？')) return;
  adjCancel();
  setMode(null);
  editing = d;
  $('editTitle').textContent = d.label;
  $('editInfo').textContent = d.info || '';
  $('editInfo').classList.toggle('hidden', !d.info);
  const box = $('editFields');
  box.innerHTML = '';
  d.fields?.(box);
  $('editVertex').classList.toggle('hidden', !(d.vertices && d.vertices().length >= 2));
  $('editSheet').classList.remove('hidden');
  editOpenedAt = Date.now();
  // 開いている間は、後ろの画面をキーボードでも操作できないようにする（別のホールに移ってしまわないように）
  for (const el of document.querySelectorAll('.ed-bar, .map-wrap, .ed-panel')) el.inert = true;
}
function closeEdit() {
  editing = null;
  $('editSheet').classList.add('hidden');
  for (const el of document.querySelectorAll('.ed-bar, .map-wrap, .ed-panel')) el.inert = false;
}
/** 修正画面で値を変えたあと: 保存して、見出しを今の値で作り直す（種類・名前を変えたとき） */
function afterEdit() {
  changed();
  if (!editing) return;
  editing = describe(editing.item);
  $('editTitle').textContent = editing.label;
  // 欄も今の値で作り直す（種類を変えると名前も変わることがあるため）
  const box = $('editFields');
  box.innerHTML = '';
  editing.fields?.(box);
}
$('editClose').onclick = closeEdit;
// 外側をタップしても閉じる（開いた直後の2回目のタップでは閉じない）
$('editSheet').onclick = (e) => { if (e.target === $('editSheet') && Date.now() - editOpenedAt > 500) closeEdit(); };
$('editAdjust').onclick = () => { const d = editing; closeEdit(); startAdjust(d.label, d.points()); };
$('editVertex').onclick = () => { const d = editing; closeEdit(); startAdjust(d.label, d.vertices(), { vertex: true }); };
$('editDelete').onclick = () => {
  const d = editing;
  if (!d || !confirm(`「${d.label}」を削除しますか？`)) return;
  closeEdit();
  adjCancel();
  d.del();
  changed();
  toast(`削除しました（${d.label}）`);
};

// ---------- 位置の調整（移動・回転） ----------

const greenPoints = (g) => [g.center, g.front, g.back, ...(g.polygon || [])].filter(Boolean);
const hazardPoints = (z) => [...([z.line, z.polygon, z.points].find((a) => a && a.length) || [])];
const holePoints = (h) => [
  ...(h.tees || []).map((t) => t.pos),
  ...h.greens.flatMap(greenPoints),
  ...(h.hazards || []).flatMap(hazardPoints),
  ...(h.line || []),
];
/** 標高を持つ点か（ティー・グリーンの中央・前・奥）。動かしたら標高を取り直す */
const isElevPoint = (h, p) => (h.tees || []).some((t) => t.pos === p) || h.greens.some((g) => g.center === p || g.front === p || g.back === p);

/** 調整中なら、いったん元の位置に戻して fn を実行し、また調整中の位置に戻す（途中の位置を保存・書き出ししない） */
function withAdjustUndone(fn) {
  if (!adj) return fn();
  const now = adj.points.map((p) => [p[0], p[1]]);
  adj.points.forEach((p, i) => { p[0] = adj.orig[i][0]; p[1] = adj.orig[i][1]; });
  try { return fn(); } finally { adj.points.forEach((p, i) => { p[0] = now[i][0]; p[1] = now[i][1]; }); }
}

/** 調整中の状態。points は書き換える点そのもの、orig はその元の座標 */
let adj = null;
const adjLayer = L.layerGroup().addTo(map);

function startAdjust(label, points, { vertex = false } = {}) {
  adjCancel();
  setMode(null);
  // 同じ点が2回入っていても1回だけ動かす
  points = [...new Set(points)].filter((p) => Array.isArray(p) && p.length >= 2);
  if (!points.length) { toast('動かせる点がありません'); return; }
  const orig = points.map((p) => [p[0], p[1]]);
  adj = { label, points, orig, pivot: centroid(orig), dx: 0, dy: 0, rot: 0, holeIdx: state.holeIdx, nineIdx: state.nineIdx, vertex };
  $('adjTitle').textContent = `${vertex ? '点を動かす' : '調整中'}: ${label}`;
  $('adjBar').classList.toggle('vertex', vertex); // 点を動かすときは矢印・回転を隠す
  $('adjRotBox').classList.toggle('off', points.length < 2); // 1点は回しても変わらない
  $('adjBar').classList.remove('hidden');
  $('adjBar').scrollIntoView({ block: 'nearest' });
  applyAdjust();
  // 動かすものが地図の真ん中に来るように寄せる
  if (orig.length === 1) map.setView(orig[0], Math.max(map.getZoom(), 18));
  // 点を1つずつ動かすときは、点どうしが重ならないよう大きく寄せる（写真は少しぼやける）
  else if (vertex) map.fitBounds(L.latLngBounds(orig).pad(0.15), { maxZoom: 20 });
  else map.fitBounds(L.latLngBounds(orig).pad(0.4), { maxZoom: 18 }); // 18 より寄ると写真がぼやける
}

/** 今の移動量・回転を、元の座標から計算し直して点に書き込む（誤差がたまらないように毎回元から） */
function applyAdjust() {
  if (!adj) return;
  if (adj.vertex) { drawVertexHandles(); return; }
  const moved = transformPoints(adj.orig, { dx: adj.dx, dy: adj.dy, rotDeg: adj.rot, pivot: adj.pivot });
  adj.points.forEach((p, i) => { p[0] = round6(moved[i][0]); p[1] = round6(moved[i][1]); });
  redraw(false);
  // つかんで動かせる印（中心の位置）
  adjLayer.clearLayers();
  const at = transformPoints([adj.pivot], { dx: adj.dx, dy: adj.dy, pivot: adj.pivot })[0];
  const handle = L.marker(at, { draggable: true, icon: L.divIcon({ className: '', html: '<div class="adj-handle">✥</div>', iconSize: [0, 0] }) })
    .addTo(adjLayer);
  handle.on('drag', (e) => {
    const ll = e.target.getLatLng();
    moveTo([ll.lat, ll.lng], false);
  });
  handle.on('dragend', () => applyAdjust());
  const dir = (v, pos, neg) => (Math.abs(v) < 0.05 ? '' : `${v > 0 ? pos : neg} ${Math.abs(v).toFixed(1)}m`);
  const parts = [dir(adj.dx, '東', '西'), dir(adj.dy, '北', '南'), adj.rot ? `${adj.rot > 0 ? '右' : '左'}回り ${Math.abs(adj.rot)}°` : ''].filter(Boolean);
  $('adjInfo').textContent = (parts.length ? `元の位置から ${parts.join('・')}` : 'まだ動かしていません')
    + '。矢印・回転のボタン、黄色い印のドラッグ、または地図をタップした場所へ移動できます。';
}

/** 点を1つずつ動かすときの印。ドラッグした点だけを書き換える */
function drawVertexHandles() {
  redraw(false);
  adjLayer.clearLayers();
  adj.points.forEach((p, i) => {
    const m = L.marker([p[0], p[1]], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="vx-handle"></div>', iconSize: [0, 0] }) }).addTo(adjLayer);
    m.bindTooltip(String(i + 1), { direction: 'top', offset: [0, -8] });
    m.on('drag', (e) => {
      const ll = e.target.getLatLng();
      p[0] = round6(ll.lat); p[1] = round6(ll.lng);
      holeLayer.clearLayers();
      drawHole(holeLayer, hole(), state.greenName, drawOpts());
    });
    m.on('dragend', () => drawVertexHandles());
  });
  const n = adj.points.filter((p, i) => p[0] !== adj.orig[i][0] || p[1] !== adj.orig[i][1]).length;
  $('adjInfo').textContent = `${n ? `${n}点を動かしました。` : ''}白い四角の点をドラッグして形を直します（${adj.points.length}点）。`;
}

/** 中心が ll に来るように動かす。redrawAll=false はドラッグ中（印は描き直さない） */
function moveTo(ll, redrawAll = true) {
  if (!adj || adj.vertex) return;
  const d = distanceM(adj.pivot, ll);
  const b = Math.atan2(
    (ll[1] - adj.pivot[1]) * Math.cos(adj.pivot[0] * Math.PI / 180),
    ll[0] - adj.pivot[0],
  );
  adj.dx = d * Math.sin(b);
  adj.dy = d * Math.cos(b);
  if (redrawAll) { applyAdjust(); return; }
  const moved = transformPoints(adj.orig, { dx: adj.dx, dy: adj.dy, rotDeg: adj.rot, pivot: adj.pivot });
  adj.points.forEach((p, i) => { p[0] = round6(moved[i][0]); p[1] = round6(moved[i][1]); });
  holeLayer.clearLayers();
  drawHole(holeLayer, hole(), state.greenName, drawOpts());
}

for (const b of document.querySelectorAll('#adjBar [data-move]')) {
  b.onclick = () => {
    if (!adj) return;
    const [ex, ny] = b.dataset.move.split(',').map(Number);
    const step = Number($('adjStep').value);
    adj.dx += ex * step;
    adj.dy += ny * step;
    applyAdjust();
  };
}
for (const b of document.querySelectorAll('#adjBar [data-rot]')) {
  b.onclick = () => {
    if (!adj) return;
    adj.rot = ((adj.rot + Number(b.dataset.rot) * Number($('adjRotStep').value)) + 540) % 360 - 180; // -180〜180 に収める
    applyAdjust();
  };
}

/** 調整を終える。keep=false なら元の位置に戻す */
function finishAdjust(keep) {
  if (!adj) return;
  const a = adj;
  adj = null;
  adjLayer.clearLayers();
  $('adjBar').classList.add('hidden');
  if (!keep) {
    a.points.forEach((p, i) => { p[0] = a.orig[i][0]; p[1] = a.orig[i][1]; });
    redraw(false);
    return;
  }
  const movedM = a.vertex ? (a.points.some((p, i) => p[0] !== a.orig[i][0] || p[1] !== a.orig[i][1]) ? 1 : 0) : Math.hypot(a.dx, a.dy);
  if (movedM < 0.05 && !a.rot) {
    // ほとんど動かしていなければ、元の値のままにする（丸めで数 cm ずれないように）
    a.points.forEach((p, i) => { p[0] = a.orig[i][0]; p[1] = a.orig[i][1]; });
    redraw(false);
    return;
  }
  // 標高を持つ点（ティー・グリーンの中央など）は、新しい場所の標高を取り直す（取れるまでは前の値のまま）
  const h = state.course.nines[a.nineIdx].holes[a.holeIdx];
  for (const p of a.points) if (isElevPoint(h, p)) fetchElev(p, h);
  changed();
  toast(`${a.vertex ? '形を直しました' : '位置を調整しました'}（${a.label}）`);
}
function adjCancel() { finishAdjust(false); }

$('adjDone').onclick = () => finishAdjust(true);
$('adjCancel').onclick = adjCancel;
$('adjReset').onclick = () => {
  if (!adj) return;
  if (adj.vertex) adj.points.forEach((p, i) => { p[0] = adj.orig[i][0]; p[1] = adj.orig[i][1]; });
  adj.dx = 0; adj.dy = 0; adj.rot = 0;
  applyAdjust();
};
$('btnAdjHole').onclick = () => startAdjust(`${state.course.nines[state.nineIdx].name} ${hole().no}番 全体`, holePoints(hole()));
// パソコンでは矢印キーでも動かせる（Shift で 5倍）。[ ] で回す
window.addEventListener('keydown', (e) => {
  if (!adj || adj.vertex || e.altKey || e.ctrlKey || e.metaKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const k = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  const step = Number($('adjStep').value) * (e.shiftKey ? 5 : 1);
  if (k) { adj.dx += k[0] * step; adj.dy += k[1] * step; }
  else if (e.key === '[' || e.key === ']') {
    if (adj.points.length < 2) return;
    adj.rot = ((adj.rot + (e.key === ']' ? 1 : -1) * Number($('adjRotStep').value)) + 540) % 360 - 180;
  } else return;
  e.preventDefault();
  e.stopImmediatePropagation(); // 地図のスクロールと二重に効かないように
  applyAdjust();
}, true);

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // 調整中（まだ確定していない）の途中の位置は保存しない
  const ok = withAdjustUndone(() => saveCourseLocal(state.course));
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

$('btnExport').onclick = () => withAdjustUndone(() => downloadCourse(state.course)); // 調整中の途中の位置は書き出さない
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

// ---------- 現地で GPS を使って記録する ----------

const REC_MIN_STEP_M = 2.5; // 自動で点を足す間隔
const REC_MAX_ACC_M = 12;   // 自動で足すのは誤差がこれ以下のときだけ
const rec = { on: false, watchId: null, pts: [], pos: null, acc: null, wake: null };
const recLayer = L.layerGroup().addTo(map);

function recDraw() {
  recLayer.clearLayers();
  const closed = $('recKind').value !== 'line';
  if (rec.pts.length >= 2) L.polyline(closed ? [...rec.pts, rec.pts[0]] : rec.pts, { color: '#ffd60a', weight: 3 }).addTo(recLayer);
  for (const p of rec.pts) L.circleMarker(p, { radius: 3, color: '#ffd60a', weight: 2 }).addTo(recLayer);
  if (rec.pos) {
    if (rec.acc) L.circle(rec.pos, { radius: rec.acc, color: '#2d8cff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(recLayer);
    L.circleMarker(rec.pos, { radius: 7, color: '#fff', weight: 3, fillColor: '#2d8cff', fillOpacity: 1, interactive: false }).addTo(recLayer);
  }
  $('recStatus').textContent = rec.on
    ? `記録中: ${rec.pts.length}点　GPS 誤差 ${rec.acc != null ? `±${Math.round(rec.acc)}m` : '取得中…'}`
      + (rec.acc != null && rec.acc > REC_MAX_ACC_M ? '（誤差が大きいので自動では点を足しません）' : '')
    : `${rec.pts.length}点`;
}

function recAdd(pos) {
  rec.pts.push([round6(pos[0]), round6(pos[1])]);
  recDraw();
}

function recStop() {
  if (rec.watchId !== null) navigator.geolocation.clearWatch(rec.watchId);
  rec.watchId = null;
  rec.on = false;
  rec.wake?.release?.().catch?.(() => {});
  rec.wake = null;
  $('recStart').textContent = '記録再開';
}

$('btnRec').onclick = () => {
  adjCancel();
  setMode(null);
  $('gpsRec').classList.toggle('hidden');
  if ($('gpsRec').classList.contains('hidden')) { recStop(); rec.pts = []; recLayer.clearLayers(); }
};
$('recKind').onchange = () => {
  // 線は OB を、形はバンカーを初期値にする
  $('selHzType').value = $('recKind').value === 'line' ? 'ob' : $('recKind').value === 'area' ? 'bunker' : $('selHzType').value;
  recDraw();
};
$('recStart').onclick = async () => {
  if (rec.on) { recStop(); recDraw(); return; }
  if (!('geolocation' in navigator)) { toast('この端末は GPS に対応していません'); return; }
  rec.on = true;
  $('recStart').textContent = '一時停止';
  try { rec.wake = await navigator.wakeLock?.request('screen'); } catch { /* 画面ON固定できなくても記録はできる */ }
  rec.watchId = navigator.geolocation.watchPosition((p) => {
    rec.pos = [p.coords.latitude, p.coords.longitude];
    rec.acc = p.coords.accuracy;
    const last = rec.pts[rec.pts.length - 1];
    if ($('recAuto').checked && rec.acc <= REC_MAX_ACC_M && (!last || distanceM(last, rec.pos) >= REC_MIN_STEP_M)) recAdd(rec.pos);
    else recDraw();
    if (!map.getBounds().contains(rec.pos)) map.panTo(rec.pos);
  }, (err) => {
    toast(err.code === 1 ? '位置情報が許可されていません' : '現在地を取れません');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  recDraw();
};
$('recPoint').onclick = () => {
  if (!rec.pos) { toast('まだ現在地を取れていません。「記録開始」を押して少し待ってください'); return; }
  if (rec.acc > 25) { toast(`GPS の誤差が大きいため（±${Math.round(rec.acc)}m）追加しませんでした`); return; }
  recAdd(rec.pos);
};
$('recUndo').onclick = () => { rec.pts.pop(); recDraw(); };
$('recCancel').onclick = () => {
  if (rec.pts.length && !confirm('記録した点を捨てますか？')) return;
  recStop(); rec.pts = []; recDraw();
  $('recStart').textContent = '記録開始';
};
$('recDone').onclick = () => {
  const kind = $('recKind').value;
  const need = kind === 'line' ? 2 : 3;
  if (rec.pts.length < need) { toast(`${need}点以上必要です（今 ${rec.pts.length}点）`); return; }
  const h = hole();
  const pts = rec.pts.map((p) => [p[0], p[1]]);
  const type = $('selHzType').value;
  const label = $('inpHzLabel').value.trim() || HAZARD_TYPES[type].label;
  if (kind === 'green') {
    const g = ensureGreen();
    g.polygon = pts;
    if (!g.center) g.center = pointWithElev(centroid(pts));
    toast(`${state.greenName}グリーンの形を登録しました（${pts.length}点）`);
  } else if (kind === 'area') {
    h.hazards.push(withGreen({ type, label, points: [], polygon: pts }));
    toast(`「${label}」を登録しました（${pts.length}点）`);
  } else {
    h.hazards.push(withGreen({ type, label, points: [], polygon: null, line: pts }));
    toast(`「${label}」の線を登録しました（${pts.length}点）`);
  }
  recStop(); rec.pts = []; recDraw();
  $('recStart').textContent = '記録開始';
  changed();
};

setupPWA();
init();
