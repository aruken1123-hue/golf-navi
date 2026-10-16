// 配信しているコースデータ（courses/index.json に載っているもの）の点検
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCourse, usableGreens } from '../js/store.js';
import { distanceM } from '../js/geo.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../courses/${f}`, import.meta.url), 'utf8'));
const index = read('index.json').courses;
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('一覧のコースはすべて読めて、id とファイル名が合っている', () => {
  const ids = new Set();
  for (const e of index) {
    assert.ok(!ids.has(e.id), `${e.id} が一覧に2回あります`);
    ids.add(e.id);
    assert.equal(e.file, `${e.id}.json`);
    const c = validateCourse(read(e.file));
    assert.equal(c.id, e.id);
    assert.equal(c.name, e.name);
    assert.ok(Number.isInteger(c.revision) && c.revision >= 1, `${e.id} の revision`);
  }
});

test('一覧のコースは圏外でも使えるよう sw.js で事前保存する', () => {
  for (const e of index) assert.ok(sw.includes(`'courses/${e.file}'`), `${e.file} が sw.js の APP_FILES にありません`);
});

test('どのホールもティーとグリーン中央があり、Par とティー→グリーンの距離がそれらしい', () => {
  for (const e of index) {
    const c = validateCourse(read(e.file));
    for (const n of c.nines) {
      for (const h of n.holes) {
        const where = `${c.name} ${n.name} ${h.no}番`;
        assert.ok([3, 4, 5].includes(h.par), `${where} の Par`);
        assert.ok(h.tees.length >= 1, `${where} にティーがありません`);
        const gs = usableGreens(h);
        assert.ok(gs.length >= 1, `${where} にグリーンがありません`);
        for (const g of gs) {
          const yd = distanceM(h.tees[0].pos, g.center) / 0.9144;
          // 直線距離なので、ドッグレッグでは短くなる。Par ごとのおおよその範囲から外れたら位置の取り違えを疑う
          const [lo, hi] = { 3: [60, 260], 4: [180, 500], 5: [330, 650] }[h.par];
          assert.ok(yd >= lo && yd <= hi, `${where} ${g.name}グリーンまで ${Math.round(yd)}y（Par${h.par}）`);
        }
      }
    }
  }
});

test('同じコースの中で、別のホールのグリーンを指していない', () => {
  for (const e of index) {
    const c = validateCourse(read(e.file));
    const all = c.nines.flatMap((n) => n.holes.flatMap((h) => usableGreens(h).map((g) => ({ where: `${n.name}${h.no}${g.name}`, hole: `${n.id}-${h.no}`, p: g.center }))));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[i].hole === all[j].hole) continue;
        assert.ok(distanceM(all[i].p, all[j].p) > 8, `${c.name}: ${all[i].where} と ${all[j].where} のグリーンが重なっています`);
      }
    }
  }
});
