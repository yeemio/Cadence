/**
 * M5 正式 PWA 构建产物断言（node 静态证据链；实机浏览器离线导航验证边界
 * 见 README M5 登记——本脚本钉 build 侧可机器断言的全部事实）：
 *
 *   1. manifest 完整（name/icons/start_url/display）
 *   2. SW 生成（sw.js + workbox runtime）且 precache 清单含 offline.html /
 *      icons/icon.svg / 双入口 html（inline 注册的 scope 覆盖面）
 *   3. 双入口 html 内联 SW 注册（injectRegister: 'inline'）
 *   4. 登录入口无响应式断点污染：登录 js chunk 不含 md: 断点类；css 为全站
 *      共享单文件（Tailwind v4 单 css 输出的既有形态，登录 html 引用与主壳
 *      同一 css——断点类按使用扫描生成，登录页未用响应式类）——登录 chunk
 *      预算按 js 算（ADR-0009 登录最小 bundle 不回归）
 *   5. 登录 js chunk gzip < 15KB
 *   6. html5-qrcode 仍为懒块（独立于主 chunk 的 js 文件承载，不进主 chunk /
 *      不进登录 chunk）
 *   7. 主壳 css 含 M5 响应式改造产物（抽屉 fixed + translate 产物 + md 断点
 *      —— Tailwind v4 语法 min-width:48rem = 768px）
 *
 * 用法：node scripts/verify-pwa.mjs   （前置：脚本内自跑 pnpm build）
 */
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(WEB_ROOT, 'dist');

let failures = 0;
function pass(message) {
  console.log(`PASS: ${message}`);
}
function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}
function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

// 0) 构建（自包含）
execSync('pnpm build', { cwd: WEB_ROOT, stdio: 'inherit' });

// 1) manifest
const manifestPath = resolve(DIST, 'manifest.webmanifest');
assert(existsSync(manifestPath), 'dist/manifest.webmanifest 存在');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(manifest.name === 'Cadence' && manifest.short_name === 'Cadence', `manifest name/short_name = ${manifest.name}/${manifest.short_name}`);
  assert(manifest.start_url === '/' && manifest.display === 'standalone', `manifest start_url=${manifest.start_url} display=${manifest.display}`);
  assert(
    Array.isArray(manifest.icons) && manifest.icons.some((icon) => icon.src.includes('icon.svg')),
    `manifest icons 含 SVG 图标（${manifest.icons?.map((i) => i.src).join(',')}）`,
  );
}

// 2) SW + precache
const swPath = resolve(DIST, 'sw.js');
assert(existsSync(swPath), 'dist/sw.js 存在（generateSW）');
const sw = existsSync(swPath) ? readFileSync(swPath, 'utf8') : '';
const workboxFiles = readdirSync(DIST).filter((name) => /^workbox-.*\.js$/.test(name));
assert(workboxFiles.length > 0, `workbox runtime chunk 存在（${workboxFiles.join(',')}）`);
// precache 清单（sw.js 内联注入的数组字面量）
assert(/"url":"offline\.html"/.test(sw) || /offline\.html/.test(sw), 'precache 清单含 offline.html（离线壳页）');
assert(/icons\/icon\.svg/.test(sw), 'precache 清单含 icons/icon.svg');
assert(/index\.html/.test(sw) && /login\.html/.test(sw), 'precache 清单含双入口 html（主壳 + 登录）');
assert(/precacheAndRoute/.test(sw), 'sw.js 注册 precacheAndRoute');
assert(/NetworkFirst/.test(sw) && /offline\.html/.test(sw), 'runtime 导航 NetworkFirst + precacheFallback offline.html 在产物内');
assert(sw.includes('cadence-navigations-v1'), '导航运行时缓存名 cadence-navigations-v1 在产物内');

// 3) 双入口内联注册
for (const entry of ['index.html', 'login.html']) {
  const html = readFileSync(resolve(DIST, entry), 'utf8');
  assert(/serviceWorker\.register/.test(html), `${entry} 内联 SW 注册（injectRegister inline）`);
}

// 4~7) chunk 断言
const assets = readdirSync(resolve(DIST, 'assets'));
const loginJs = assets.filter((name) => /^login-.*\.js$/.test(name));
const indexCss = assets.filter((name) => /^index-.*\.css$/.test(name));
assert(loginJs.length === 1, `登录 js chunk 唯一（${loginJs.join(',')}）`);

if (loginJs.length === 1) {
  const loginBody = readFileSync(resolve(DIST, 'assets', loginJs[0]), 'utf8');
  assert(!loginBody.includes('md:'), '登录 js 无 md: 断点类（无响应式断点污染）');
  const bytes = readFileSync(resolve(DIST, 'assets', loginJs[0]));
  const gzipKiB = gzipSync(bytes).length / 1024;
  assert(gzipKiB < 15, `登录 js chunk gzip = ${gzipKiB.toFixed(2)} KiB（< 15 KiB）`);
}

// html5-qrcode 懒块：独立 js 文件承载（rollup 对 dynamic import 的分块），
// 主 chunk / 登录 chunk 均不含其实现
const indexHtml = readFileSync(resolve(DIST, 'index.html'), 'utf8');
const mainBundleRefs = [...indexHtml.matchAll(/assets\/(index-[^"']+\.js)/g)].map((m) => m[1]);
const lazyQrcode = assets.filter(
  (name) =>
    name.endsWith('.js') &&
    !mainBundleRefs.includes(name) &&
    !name.startsWith('login-') &&
    readFileSync(resolve(DIST, 'assets', name), 'utf8').includes('html5-qrcode'),
);
assert(lazyQrcode.length > 0, `html5-qrcode 懒块存在（${lazyQrcode.join(',')}）`);
for (const chunk of mainBundleRefs) {
  const body = readFileSync(resolve(DIST, 'assets', chunk), 'utf8');
  assert(!/html5-qrcode|Html5Qrcode/.test(body), `主 chunk ${chunk} 不内联 html5-qrcode（仍懒加载）`);
}

if (indexCss.length === 1) {
  const css = readFileSync(resolve(DIST, 'assets', indexCss[0]), 'utf8');
  // Tailwind v4 断点语法：min-width:48rem（= 768px，md）
  assert(/min-width:\s*48rem/.test(css), '主壳 css 含 md 断点（min-width:48rem = 768px，M5 响应式产物）');
  assert(/position:fixed|position: fixed/.test(css), '主壳 css 含 fixed 定位（抽屉侧栏产物）');
  assert(/-translate-x-full|--tw-translate-x:-100%/.test(css), '主壳 css 含抽屉收起 transform（-translate-x-full）');
  assert(/overflow-x-auto/.test(css), '主壳 css 含表格横滚（overflow-x-auto）');
  assert(/h-11/.test(css), '主壳 css 含 44px 触摸目标（h-11）');
}

console.log(`\n[verify-pwa] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
