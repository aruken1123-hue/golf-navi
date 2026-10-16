// パソコン編集（tools/pcedit.py のサーバーで開いたときだけ使う）: コースのファイルへの保存とスマホへの公開
// 公開サイトやスマホでは使えない（サーバーが無いので、見つからなければ何もしない）

const HEADER = { 'X-Golfnavi-PC': '1' }; // このヘッダーが無い依頼はサーバーが断る（ほかのサイトからの書き換え防止）

/** パソコン編集のサーバーで開いているか。開いていれば状態（未公開のファイルなど）、無ければ null */
export async function detectPC() {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return null;
  try {
    const res = await fetch('api/pc/status', { headers: HEADER, cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

async function call(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...HEADER, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let json = null;
    try { json = await res.json(); } catch { /* 中身の無い応答 */ }
    return { status: res.status, json: json || {} };
  } catch {
    return { status: 0, json: { error: 'パソコン編集のサーバーにつながりません（黒い画面を閉じていませんか）' } };
  }
}

/**
 * コースをファイル（courses/<id>.json）に保存する。
 * baseRevision: 読み込んだときの版。ファイルがその後に変わっていたら status 409 が返る
 */
export function saveCourseFile(data, baseRevision) {
  return call('PUT', `api/pc/course/${encodeURIComponent(data.id)}`, { course: data, baseRevision });
}

/** 保存済みのコースのファイルを GitHub に送る（スマホに届く） */
export function publishCourses() {
  return call('POST', 'api/pc/publish');
}
