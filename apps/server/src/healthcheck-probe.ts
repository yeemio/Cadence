/**
 * 健康探针（镜像内单份）+ SMES_TENANTS / SMES_DOMAIN 环境形状共享面
 * （M4 部署期收尾波·双写去重：探针 Host 推导原本三处重复——
 * apps/server/Dockerfile HEALTHCHECK 内联、deploy/compose.yaml server
 * healthcheck 内联、main.ts bootstrap 的已知租户解析——现全部收敛到本文件）。
 *
 * 三个消费点（同一份逻辑）：
 *   - apps/server/Dockerfile：HEALTHCHECK CMD node apps/server/dist/healthcheck-probe.js
 *   - deploy/compose.yaml：server 服务不定义 healthcheck，缺省继承镜像内定义
 *     （compose 语义：服务级未覆盖即用镜像 HEALTHCHECK）。
 *   - apps/server/src/main.ts：bootstrap 经 parseKnownTenants 解析已知租户清单
 *     （fail-fast 校验与 hostBasedTenantResolver lookup 同源）。
 *
 * Host 取舍（原三处注释合一，写明）：saas 形态（SMES_TENANTS 非空）fail-closed
 * 对域外 Host 一律拒绝——liveness 探针不得依赖租户路由，故探针 Host = 首个已知
 * 租户 + SMES_DOMAIN；单机回落 127.0.0.1（与既有行为相同）。用 node http 而非
 * fetch：fetch 规范禁改 Host 头（静默忽略，探针会误报）。
 *
 * 零重依赖：只 import node:http / node:path / node:url——不进 Nest 装配链、
 * 不触发 reflect-metadata（探针进程与 server 进程分离，快且无副作用）。
 */
import { get as httpGet } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 解析 SMES_TENANTS 逗号清单 → 已知租户数组（去空白、弃空项）。
 * main.ts bootstrap 与探针同源使用；空清单由调用方按形态裁定
 * （saas fail-fast 拒启 / 探针回落单机 Host）。
 */
export function parseKnownTenants(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * 探针 Host 推导：已知租户非空 → `首个租户.{domain}`；否则 127.0.0.1（单机形态）。
 */
export function probeHostFor(tenants: readonly string[], domain: string): string {
  const first = tenants[0];
  return first !== undefined && first.length > 0 ? `${first}.${domain}` : '127.0.0.1';
}

/**
 * 执行探针：GET /health（Host = 推导值）→ 200 即 0，否则 1；连接错误 1。
 * 退出码即 healthcheck 判定（Docker 语义：0 = healthy）。
 */
export function runHealthcheckProbe(
  env: { readonly [key: string]: string | undefined } = process.env,
): void {
  const host = probeHostFor(parseKnownTenants(env['SMES_TENANTS']), env['SMES_DOMAIN'] ?? '');
  const port = Number(env['PORT'] ?? 3000);
  const request = httpGet(
    { host: '127.0.0.1', port, path: '/health', headers: { Host: host } },
    (response) => {
      process.exit(response.statusCode === 200 ? 0 : 1);
    },
  );
  request.on('error', () => process.exit(1));
}

// main guard：node dist/healthcheck-probe.js 直接执行时跑探针；被 main.ts import 时零副作用。
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(resolve(entryArg)).href) {
  runHealthcheckProbe();
}
