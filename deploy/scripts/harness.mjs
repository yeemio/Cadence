/**
 * RLS 容器实证共享脚手架（M4 部署期收尾波·双写去重）：rls-proof.mjs 与
 * rls-session-proof.mjs 原各自复写的容器生命周期 / assert 记分 / spawnSync
 * 管道 / psql 便捷面抽此单份共享。
 *
 * 边界（写明）：本模块只共享**机制**——被证事实（断言内容、迁移与探针序列、
 * 端口/容器名/口令等容器参数）仍归各 proof 脚本，不在本模块内掺入任何
 * proof 特有逻辑。
 *
 * 用法形状：
 *   const kit = createProofAsserts();
 *   const pg = await startProofPostgres({ container, port, appPassword, assert: kit });
 *   pg.psql('app_user', "SET app.current_tenant = 't-a'; SELECT ...");
 *   ... kit.assert(cond, '断言文案') ...
 *   finally: await cleanupProofPostgres(container, 'rls-proof');
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(DEPLOY_DIR, '..');

/** assert 记分器：PASS/FAIL 打印 + 失败计数（退出码判定）。 */
export function createProofAsserts() {
  let failures = 0;
  return {
    get failures() {
      return failures;
    },
    pass(message) {
      console.log(`PASS: ${message}`);
    },
    fail(message) {
      failures += 1;
      console.error(`FAIL: ${message}`);
    },
    assert(condition, message) {
      if (condition) this.pass(message);
      else this.fail(message);
    },
  };
}

/** 同步 spawn 包装：cwd 缺省仓根，capture=true 收 stdout/stderr，env 可覆盖。 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

/** 取 psql 输出最后一个非空行（多语句时前面是 SET/INSERT 等命令标签）。 */
export function lastLine(output) {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1]?.trim() ?? '';
}

/** 轮询等待：predicate 为真即返 true，耗尽 attempts 返 false（不抛错）。 */
export async function waitFor(predicate, { attempts = 90, intervalMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }
  return false;
}

/** 容器内 psql（走本地 socket；container image 默认 local trust）。 */
function psqlIn(container, user, sql, { onErrorStop = true } = {}) {
  const args = ['exec', container, 'psql', '-U', user, '-d', 'cadence', '-tA'];
  if (onErrorStop) args.push('-v', 'ON_ERROR_STOP=1');
  args.push('-c', sql);
  return run('docker', args, { capture: true });
}

/**
 * 起一次性 postgres:16 实证容器（挂 deploy/pg-init——app_user 由 initdb 钩子
 * 真实创建）：容器就绪 + app_user 落位双等待（pg_isready 可能早于 init 脚本
 * 完成），两项各一条 assert。返回 { container, psql }。
 */
export async function startProofPostgres({ container, port, appPassword, assert }) {
  run('docker', ['rm', '-f', container], { capture: true });
  const up = run('docker', [
    'run', '-d', '--rm', '--name', container,
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=cadence',
    '-e', `POSTGRES_APP_PASSWORD=${appPassword}`,
    '-v', `${DEPLOY_DIR}/pg-init:/docker-entrypoint-initdb.d:ro`,
    '-p', `${port}:5432`, 'postgres:16',
  ]);
  if (up.status !== 0) throw new Error(`容器启动失败：${up.stderr}`);

  const ready = await waitFor(
    () =>
      run('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'cadence'], { capture: true })
        .status === 0,
  );
  assert.assert(ready, 'postgres:16 容器就绪');

  let appUserOk = false;
  await waitFor(() => {
    const role = psqlIn(
      container,
      'postgres',
      "SELECT count(*) FROM pg_roles WHERE rolname='app_user' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls",
    );
    appUserOk = role.status === 0 && role.stdout.trim() === '1';
    return appUserOk;
  }, { attempts: 30 });
  assert.assert(appUserOk, 'pg-init/01-app-user.sh 生效：app_user 存在（可登录、非 superuser、无 BYPASSRLS）');

  return {
    container,
    psql: (user, sql, options) => psqlIn(container, user, sql, options),
  };
}

/** 收尾清理：无论成败都删容器（一次性实证不留残留）。 */
export async function cleanupProofPostgres(container, label) {
  await run('docker', ['rm', '-f', container], { capture: true });
  console.log(`[${label}] 容器 ${container} 已清理`);
}
