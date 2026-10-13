// 版番号の管理。画面のファイルが変わったのに版を上げ忘れると、スマホに古い画面が残り続けるため、
// ファイルの中身から作った指紋（ハッシュ）を version-lock.json に記録し、テストで照合する。
//   版を上げる: npm run bump        （0.1.0 → 0.1.1）
//               npm run bump 0.2.0  （指定した版にする）
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

/** sw.js が事前保存するファイル一覧 */
export function appFiles() {
  return [...read('sw.js').matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((f) => f !== './');
}

/** 画面のファイルの指紋。版番号の行とコースデータ（常に最新を取りに行く）は除く */
export function appHash() {
  const h = createHash('sha256');
  const files = [...appFiles().filter((f) => !f.startsWith('courses/')), 'sw.js'].sort();
  for (const f of files) {
    let body = readFileSync(new URL(f, root));
    if (!f.endsWith('.png')) {
      // 改行コード（Windows の CRLF / git の LF）の違いで指紋が変わらないように揃える
      let text = body.toString('utf8').replace(/\r\n/g, '\n');
      if (f === 'sw.js' || f === 'js/version.js') text = text.replace(/^.*VERSION\s*=\s*'[^']*'.*$/m, '');
      body = Buffer.from(text);
    }
    h.update(f).update('\0').update(body).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export function readLock() {
  return JSON.parse(read('version-lock.json'));
}

function bump(next) {
  const cur = read('js/version.js').match(/APP_VERSION = '([^']+)'/)[1];
  if (!next) {
    const [a, b, c] = cur.split('.').map(Number);
    next = `${a}.${b}.${c + 1}`;
  }
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`版の形式が不正です: ${next}`);
  writeFileSync(new URL('js/version.js', root), read('js/version.js').replace(/APP_VERSION = '[^']+'/, `APP_VERSION = '${next}'`));
  writeFileSync(new URL('sw.js', root), read('sw.js').replace(/const VERSION = '[^']+'/, `const VERSION = '${next}'`));
  writeFileSync(new URL('version-lock.json', root), JSON.stringify({ version: next, hash: appHash() }, null, 2) + '\n');
  console.log(`版を ${cur} → ${next} にしました（js/version.js・sw.js・version-lock.json）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'bump') {
  bump(process.argv[3]);
}
