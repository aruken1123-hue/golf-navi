// アイコン（緑の地にピンフラッグ）を PNG で書き出す。実行: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 0〜1 の座標で図形を判定（maskable でも切れないよう中央 60% に収める）
function pixel(u, v) {
  const green = [32, 120, 60];
  const pole = u > 0.43 && u < 0.47 && v > 0.22 && v < 0.74;
  const flag = u >= 0.47 && v > 0.22 && v < 0.40 && (u - 0.47) < 0.24 * (1 - Math.abs(v - 0.31) / 0.09);
  const dx = (u - 0.45) / 0.22, dy = (v - 0.76) / 0.06;
  const cup = dx * dx + dy * dy < 1;
  if (flag) return [230, 0, 51];
  if (pole) return [255, 255, 255];
  if (cup) return [124, 200, 90];
  return green;
}

mkdirSync('icons', { recursive: true });
for (const s of [192, 512]) writeFileSync(`icons/icon-${s}.png`, png(s, pixel));
console.log('icons/icon-192.png, icons/icon-512.png を作りました');
