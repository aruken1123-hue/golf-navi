// コースデータの読み込み・端末内保存・書き出し

const LOCAL_PREFIX = 'golfnavi.course.';
const ROUND_KEY = 'golfnavi.round';

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** 配信されているコース一覧（courses/index.json）に、端末内だけのコースを足して返す */
export async function listCourses() {
  let list = [];
  try {
    const res = await fetch('courses/index.json', { cache: 'no-cache' });
    if (res.ok) list = (await res.json()).courses || [];
  } catch { /* オフラインで未保存 */ }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith(LOCAL_PREFIX)) continue;
    const c = readLocal(key);
    if (c && !list.some((x) => x.id === c.id)) list.push({ id: c.id, name: c.name, file: null });
  }
  return list;
}

/**
 * コースを読む。端末内で編集したものがあればそれを優先する。
 * 戻り値の course.__local が true なら端末内データ。
 */
export async function loadCourse(id) {
  const local = readLocal(LOCAL_PREFIX + id);
  let published = null;
  try {
    const res = await fetch(`courses/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
    if (res.ok) published = validateCourse(await res.json());
    else if (!local) throw new Error(`コース ${id} を読めません（${res.status}）`);
  } catch (e) {
    if (!local) throw e;
  }
  if (!local) return published;
  // 2グリーン対応前（v0.1）に保存したデータは、公開版の呼び名（例: ベント）で移行する
  const course = Object.assign(validateCourse(local, { fallbackNames: published?.greenNames }), { __local: true });
  // 公開版のほうが新しい版（revision）なら知らせる（端末内データが優先されて気づけないため）。
  // 端末内データはもとにした公開版の revision を持ち続ける。古い端末内データは revision 無し＝0
  if (published && (published.revision || 0) > (course.revision || 0)) {
    course.__publishedNewer = published.updated || `版${published.revision}`;
  }
  return course;
}

// 画面の都合で付けた一時的な項目（__local, グリーンの __elev など、__ で始まるもの）を除いた複製
function cleanCopy(course) {
  return JSON.parse(JSON.stringify(course, (k, v) => (k.startsWith('__') ? undefined : v)));
}
/** ファイルに書く形のコース（画面の都合で付けた項目を除いた複製） */
export const courseData = cleanCopy;

export function saveCourseLocal(course) {
  const data = cleanCopy(course);
  data.updated = new Date().toISOString().slice(0, 10);
  return writeLocal(LOCAL_PREFIX + data.id, data);
}

export function discardCourseLocal(id) {
  localStorage.removeItem(LOCAL_PREFIX + id);
}

export function hasLocalCourse(id) {
  return localStorage.getItem(LOCAL_PREFIX + id) !== null;
}

const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const isPoints = (a) => Array.isArray(a) && a.every(isPoint);

/**
 * 形を確かめ、欠けている配列は空で補う。おかしければ例外。
 * fallbackNames: 呼び名の無い旧形式（v0.1）のデータを移行するときに使う呼び名（公開版のもの）
 */
export function validateCourse(c, { fallbackNames } = {}) {
  if (!c || c.schemaVersion !== 1) throw new Error('対応していない形式です（schemaVersion が 1 ではない）');
  if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) throw new Error('id は半角英小文字・数字・ハイフンにしてください');
  if (typeof c.name !== 'string') throw new Error('name（コース名）がありません');
  if (c.revision != null && !Number.isInteger(c.revision)) throw new Error('revision（データの版）は整数にしてください');
  if (!Array.isArray(c.nines) || c.nines.length === 0) throw new Error('nines（9ホールのまとまり）がありません');
  if (c.greenNames != null && !(Array.isArray(c.greenNames) && c.greenNames.length
    && c.greenNames.every((x) => typeof x === 'string' && x) && new Set(c.greenNames).size === c.greenNames.length)) {
    throw new Error('greenNames（グリーンの呼び名）が不正です');
  }
  const legacyName = (c.greenNames || fallbackNames || ['A'])[0];
  if (!c.greenNames && fallbackNames) c.greenNames = [...fallbackNames];
  for (const n of c.nines) {
    if (typeof n.id !== 'string' || typeof n.name !== 'string') throw new Error('nines の id・name がありません');
    if (!Array.isArray(n.holes)) throw new Error(`${n.name} に holes がありません`);
    for (const h of n.holes) {
      const where = `${n.name} ${h.no}番`;
      h.tees ??= [];
      h.hazards ??= [];
      h.line ??= [];
      h.fairway ??= [];
      if (!Array.isArray(h.tees) || !h.tees.every((t) => isPoint(t.pos))) throw new Error(`${where} のティーの座標が不正です`);
      if (!isPoints(h.line)) throw new Error(`${where} の line が不正です`);
      // 旧形式（1ホール1グリーンの green）を greens に移す。
      // 旧アプリで新データを編集すると green と greens が両方あることがあるので、その場合も捨てずに足す
      if (!Array.isArray(h.greens)) h.greens = [];
      if (h.green && !h.greens.some((g) => g.name === legacyName)) h.greens.unshift({ name: legacyName, ...h.green });
      delete h.green;
      if (new Set(h.greens.map((g) => g.name)).size !== h.greens.length) throw new Error(`${where} に同じ名前のグリーンが2つあります`);
      for (const g of h.greens) {
        if (typeof g.name !== 'string' || !g.name) throw new Error(`${where} のグリーンに名前がありません`);
        for (const k of ['center', 'front', 'back']) {
          if (g[k] != null && !isPoint(g[k])) throw new Error(`${where} の${g.name}グリーン（${k}）の座標が不正です`);
        }
        if (g.polygon != null && !isPoints(g.polygon)) throw new Error(`${where} の${g.name}グリーンの形が不正です`);
      }
      if (!Array.isArray(h.hazards)) throw new Error(`${where} の hazards が不正です`);
      for (const z of h.hazards) {
        z.points ??= [];
        if (typeof z.label !== 'string' || !isPoints(z.points) || (z.polygon != null && !isPoints(z.polygon))
          || (z.line != null && !isPoints(z.line))) {
          throw new Error(`${where} のハザードが不正です`);
        }
        if (z.green != null && typeof z.green !== 'string') throw new Error(`${where} のハザードの対象グリーンが不正です`);
      }
    }
  }
  // 使われているのに呼び名一覧に無い名前は一覧に足す（選択・付け替えの対象から漏れないように）
  const used = c.nines.flatMap((n) => n.holes.flatMap((h) => [...h.greens.map((g) => g.name), ...h.hazards.map((z) => z.green).filter(Boolean)]));
  const names = [...greenNames(c)];
  for (const u of used) if (!names.includes(u)) names.push(u);
  if (c.greenNames || names.length !== greenNames(c).length) c.greenNames = names;
  return c;
}

/** コースをJSONファイルとして書き出す（courses/ に置いて配信する用） */
export function downloadCourse(course) {
  const data = cleanCopy(course);
  const blob = new Blob([JSON.stringify(data, null, 1) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** ラウンド設定（コースと回る順番）*/
export function loadRound() { return readLocal(ROUND_KEY); }
export function saveRound(round) { writeLocal(ROUND_KEY, round); }

/** ラウンドで回る18ホールの並び。[{ nine, hole, index }] */
export function roundHoles(course, nineIds) {
  const out = [];
  for (const id of nineIds) {
    const nine = course.nines.find((n) => n.id === id);
    if (nine) nine.holes.forEach((hole) => out.push({ nine, hole, index: out.length }));
  }
  return out;
}

// ---------- 2グリーン ----------

/** コースのグリーンの呼び名（例: ["ベント", "高麗"]）。未設定なら A・B */
export function greenNames(course) {
  return course.greenNames && course.greenNames.length ? course.greenNames : ['A', 'B'];
}

/** 中央が登録されているグリーンだけ */
export function usableGreens(hole) {
  return (hole.greens || []).filter((g) => g.center);
}

/** 使うグリーンを選ぶ。指定の名前が無いホール（1グリーンなど）は登録済みの最初のグリーン */
export function pickGreen(hole, name) {
  const gs = usableGreens(hole);
  return gs.find((g) => g.name === name) || gs[0] || null;
}

export function isHoleRegistered(hole) {
  return usableGreens(hole).length > 0;
}
