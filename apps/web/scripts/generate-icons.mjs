/**
 * PWA 品牌图标生成器（M5 收尾波：SVG 占位 → 真实多尺寸 PNG）。
 *
 * 零外部资源（清洁室）：node 内置 zlib deflate + 手写 PNG 块（IHDR/IDAT/IEND
 * + CRC32），几何沿用占位 SVG 的品牌形状——"节拍"圆环 + 斜杠（cadence=节拍），
 * 配色对齐 shadcn 中性 token（近黑底 #18181b / 近白前景 #fafafa）。
 * 像素级抗锯齿 = SDF（有向距离场）smoothstep，无渲染库依赖。
 *
 * 产物（public/icons/）：
 *   icon-192.png / icon-512.png         —— purpose 'any'（圆角方形底、透明角）
 *   icon-maskable-192/512.png           —— purpose 'maskable'（全出血方形底，
 *                                          图形居 80% 安全区内，OS 裁剪不伤形）
 *   apple-touch-icon.png（180）         —— iOS 主屏（全出血、不透明）
 *
 * 用法：node scripts/generate-icons.mjs（幂等，覆盖重生成；改动几何后重跑 +
 * vite.config.ts 的 manifest 图标清单如有增删同步更新）。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(WEB_ROOT, 'public', 'icons');

// ---- 品牌几何（512 设计空间，与占位 icon.svg 同参）----
const DESIGN = 512;
const BG = [0x18, 0x18, 0x1b]; // zinc-900 近黑（theme_color 同源）
const FG = [0xfa, 0xfa, 0xfa]; // zinc-50 近白
const RING = { cx: 256, cy: 256, r: 150, halfStroke: 14 }; // 圆环（stroke 28）
const SLASH = { x: 336, y0: 128, y1: 384, halfStroke: 14 }; // 节拍斜杠（圆端帽）
const CORNER_R = 96; // 'any' 图标圆角（rx=96/512）

// ---- SDF（有向距离场，单位：像素）----
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 覆盖率：sdf<0 在形内、>0 在形外，1px 过渡带做抗锯齿。 */
const coverage = (sdf) => clamp01(0.5 - sdf);

/** 圆角矩形 SDF（中心/half 尺寸/圆角半径）。 */
function roundRectSDF(px, py, cx, cy, half, rad) {
  const qx = Math.abs(px - cx) - (half - rad);
  const qy = Math.abs(py - cy) - (half - rad);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rad;
}

/** 圆环 SDF（|dist-r|-halfStroke）。 */
function ringSDF(px, py) {
  return Math.abs(Math.hypot(px - RING.cx, py - RING.cy) - RING.r) - RING.halfStroke;
}

/** 垂直线段 SDF（点到线段距离 - halfStroke；端点即圆端帽）。 */
function slashSDF(px, py) {
  const { x, y0, y1, halfStroke } = SLASH;
  const clampedY = Math.min(Math.max(py, y0), y1); // 垂直线段：x 恒定，y 夹取
  return Math.hypot(px - x, py - clampedY) - halfStroke;
}

/**
 * 栅格化一帧。
 * @param size 目标边长（px）
 * @param mode 'any'（圆角底+透明角）| 'fullbleed'（不透明满幅底，maskable/apple 用）
 */
function render(size, mode) {
  const scale = DESIGN / size; // 目标像素 -> 设计空间
  const half = size / 2;
  const rows = [];
  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(size * 4 + 1); // +1 = PNG 行过滤字节（0=None）
    for (let px = 0; px < size; px += 1) {
      // 像素中心采样（半像素偏移），映射回 512 设计空间
      const dx = (px + 0.5) * scale;
      const dy = (py + 0.5) * scale;
      // 两形并集：SDF 并集 = min（max 是交集）；见 SDF 组合常规
      const glyph = coverage(Math.min(ringSDF(dx, dy), slashSDF(dx, dy)));
      let alpha = 255;
      let [r, g, b] = BG;
      if (mode === 'any') {
        const bg = coverage(roundRectSDF(dx, dy, DESIGN / 2, DESIGN / 2, DESIGN / 2, CORNER_R));
        alpha = Math.round(bg * 255);
      }
      if (glyph > 0) {
        r = Math.round(BG[0] + (FG[0] - BG[0]) * glyph);
        g = Math.round(BG[1] + (FG[1] - BG[1]) * glyph);
        b = Math.round(BG[2] + (FG[2] - BG[2]) * glyph);
      }
      const o = px * 4 + 1;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      row[o + 3] = alpha;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

// ---- PNG 编码（RGBA/8，无隔行）----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(raw, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 生成清单 ----
const TARGETS = [
  { file: 'icon-192.png', size: 192, mode: 'any' },
  { file: 'icon-512.png', size: 512, mode: 'any' },
  { file: 'icon-maskable-192.png', size: 192, mode: 'fullbleed' },
  { file: 'icon-maskable-512.png', size: 512, mode: 'fullbleed' },
  { file: 'apple-touch-icon.png', size: 180, mode: 'fullbleed' },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, mode } of TARGETS) {
  const png = encodePng(render(size, mode), size);
  writeFileSync(resolve(OUT_DIR, file), png);
  console.log(`[icons] ${file} ${size}x${size} (${(png.length / 1024).toFixed(1)} KiB)`);
}
console.log(`[icons] done -> ${OUT_DIR}`);
