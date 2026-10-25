/**
 * 浏览器 e2e 全局栈编排（playwright globalSetup）：一次性 docker postgres:16
 * + 15 模块 server（真实认证）+ prisma migrate/seed + vite preview 反代 web。
 *
 * 形态取舍（写明）：与 apps/web/tests/e2e-module-chain.test.ts 同一套路
 * （docker PG → 三包 build → migrate/seed → spawn server → /health 探活），
 * 差异仅两点：
 * 1) 增加 `pnpm --filter @smes/web build`（preview serve dist 产物；构建时
 *    显式清空 VITE_API_BASE_URL——同源相对路径 + preview proxy 反代，见
 *    start-preview.ts 文件头）；
 * 2) teardown 由 playwright 在整轮结束后回调（globalSetup 返回函数）。
 *
 * 触发：RUN_E2E=1（playwright.config.ts 条件引用本 setup；缺省 spec 全 skip、
 * 不起栈、不碰 docker）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { PreviewServer } from 'vite';
import {
  API_BASE,
  API_PORT,
  APPS_WEB,
  ARTEFACTS,
  CONTAINER,
  DATABASE_URL,
  MODULES,
  PG_PORT,
  ROOT,
  WEB_BASE,
} from './env.ts';
import { startPreview } from './start-preview.ts';

function run(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; capture?: boolean } = {},
) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

interface ServerHandle {
  child: ReturnType<typeof spawn>;
  log: string[];
  exited: Promise<number | null>;
}

function startApiServer(): ServerHandle {
  const child = spawn(process.execPath, [`${ROOT}/apps/server/dist/main.js`], {
    env: { ...process.env, PORT: String(API_PORT), DATABASE_URL, MODULES_ENABLED: MODULES },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  const collect = (chunk: Buffer) => log.push(chunk.toString());
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, log, exited };
}

async function waitHealthy(server: ServerHandle): Promise<boolean> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* 尚未监听 */
    }
    if (server.child.exitCode !== null) return false;
    await delay(500);
  }
  return false;
}

async function stopApiServer(server: ServerHandle | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([server.exited, delay(8000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await server.exited.catch(() => {});
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(ARTEFACTS, { recursive: true });

  let server: ServerHandle | null = null;
  let web: PreviewServer | null = null;
  const teardown = async (): Promise<void> => {
    if (web !== null) await web.close();
    await stopApiServer(server);
    run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log('[e2e-global] 栈已拆除（preview / server / docker 容器）');
  };

  try {
    // 1) 一次性 postgres 容器
    run('docker', ['rm', '-f', CONTAINER], { capture: true });
    const up = run('docker', [
      'run', '-d', '--rm', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=cadence',
      '-p', `${PG_PORT}:5432`, 'postgres:16',
    ]);
    if (up.status !== 0) throw new Error(`容器启动失败：${up.stderr}`);
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready =
        run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'cadence'], {
          capture: true,
        }).status === 0;
      if (!ready) await delay(500);
    }
    if (!ready) throw new Error('postgres:16 容器未就绪');

    // 2) 构建（server 链三包 + web 产物；与 e2e-module-chain 同序列）
    const hard = [
      run('pnpm', ['--filter', '@smes/application', 'build']),
      run('pnpm', ['--filter', '@smes/server', 'build']),
      // 同源相对路径形态：显式清空 VITE_API_BASE_URL（防外部环境注入污染产物）
      run('pnpm', ['--filter', '@smes/web', 'build'], { env: { VITE_API_BASE_URL: '' } }),
    ];
    if (!hard.every((result) => result.status === 0)) {
      throw new Error('构建失败（application / server / web）');
    }
    // business-store 尽力构建：并行线（T1）approval-config 等中间态可能 tsc 失败；
    // 浏览器走查栈是 15 模块运行时（不含 approval-config），dist 存在即可沿用
    // ——失败时警告留痕不阻断（dist 缺失才硬失败）。
    const store = run('pnpm', ['--filter', '@smes/business-store', 'build']);
    if (store.status !== 0) {
      if (!existsSync(`${ROOT}/packages/business-store/dist`)) {
        throw new Error('business-store 构建失败且无既有 dist（无法起栈）');
      }
      console.warn(
        '[e2e-global] 警告：business-store 构建失败（并行线中间态），沿用既有 dist 跑 15 模块走查栈',
      );
    }

    // 3) 迁移 + 种子（演示账号：admin 等，口令 demo-password）
    const migrate = run(
      'pnpm',
      ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { env: { DATABASE_URL } },
    );
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy 失败：${migrate.stderr}`);
    const seed = run('node', [`${ROOT}/packages/business-store/prisma/seed.mjs`], {
      env: { DATABASE_URL },
      capture: true,
    });
    if (!(seed.status === 0 && /seed 完成/.test(seed.stdout))) {
      throw new Error(`组织种子失败：${seed.stdout.trim()} ${seed.stderr.trim()}`);
    }

    // 4) 起 server（真实认证：不开 SMES_DEV_AUTH）→ /health 探活
    server = startApiServer();
    if (!(await waitHealthy(server))) {
      throw new Error(`server 未就绪，日志尾部：\n${server.log.slice(-25).join('')}`);
    }

    // 5) 起 preview（vite 原生 proxy 反代 API 前缀；/m 回落主壳 index.html）
    web = await startPreview();
    let webReady = false;
    for (let attempt = 0; attempt < 30 && !webReady; attempt += 1) {
      try {
        const response = await fetch(`${WEB_BASE}/login`);
        webReady = response.ok;
      } catch {
        /* 尚未监听 */
      }
      if (!webReady) await delay(500);
    }
    if (!webReady) throw new Error(`preview 未就绪（${WEB_BASE}/login 探活失败）`);
  } catch (error) {
    await teardown();
    throw error;
  }

  console.log(`[e2e-global] 栈就绪：PG :${PG_PORT} | server :${API_PORT} | preview :${WEB_BASE}`);
  return teardown;
}
