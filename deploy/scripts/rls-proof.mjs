/**
 * RLS 容器实证（ADR-0005 M4 预研——Done-when 2 的三面自证）。
 *
 * 一次性 postgres:16 容器（挂 deploy/pg-init，真实消费 init SQL）→
 * postgres superuser 全量 migrate deploy（含 rls_tenant_isolation）→ 三面：
 *   ① superuser CRUD 正常 —— PG superuser/owner 绕过 RLS：跨线安全基准，
 *      四套 e2e 同语义零破坏（org/auth e2e 另行复跑作回归）。
 *   ② 受限 app_user 不设 session 变量：查询 0 行 / 写入被拒（fail-closed：
 *      current_setting(..., true) → NULL → 谓词 NULL → 策略 false）。
 *   ③ app_user SET app.current_tenant='t-a'：仅见 t-a 行；跨租户 UPDATE
 *      匹配 0 行；跨租户 INSERT 被 WITH CHECK 拒。
 *
 * 用法：node deploy/scripts/rls-proof.mjs   （需 docker；自管容器清理）
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEPLOY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DEPLOY, '..');
const PG_PORT = 55521; // 避开 e2e 脚本端口（55491/55494…）
const CONTAINER = `cadence-rls-proof-${process.pid}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const EXPECTED_RLS_TABLES = 86; // schema 全部带 tenant_id 的表（rls-conformance 守恒；M3 maintenance/drawing 落库后 72→80；S1 backfill 六表落库后 80→86）

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

/** 容器内 psql（走本地 socket；container image 默认 local trust）。 */
function psql(user, sql, { onErrorStop = true } = {}) {
  const args = ['exec', CONTAINER, 'psql', '-U', user, '-d', 'cadence', '-tA'];
  if (onErrorStop) args.push('-v', 'ON_ERROR_STOP=1');
  args.push('-c', sql);
  return run('docker', args, { capture: true });
}

/** 取 psql 输出最后一个非空行（多语句时前面是 SET/INSERT 等命令标签）。 */
function lastLine(output) {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1]?.trim() ?? '';
}

async function main() {
  console.log(`[rls-proof] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}，pg-init=${DEPLOY}/pg-init`);

  // 1) 一次性容器（挂 pg-init：受限 app 用户 = RLS 生效前提，本实证真实消费）
  run('docker', ['rm', '-f', CONTAINER], { capture: true });
  const up = run('docker', [
    'run', '-d', '--rm', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=cadence',
    '-e', 'POSTGRES_APP_PASSWORD=app_proof_password',
    '-v', `${DEPLOY}/pg-init:/docker-entrypoint-initdb.d:ro`,
    '-p', `${PG_PORT}:5432`, 'postgres:16',
  ]);
  if (up.status !== 0) throw new Error(`容器启动失败：${up.stderr}`);
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt += 1) {
    ready = run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'cadence'], { capture: true }).status === 0;
    if (!ready) await delay(500);
  }
  assert(ready, 'postgres:16 容器就绪');

  // initdb 钩子（app_user）落位重试——pg_isready 可能早于 init 脚本完成
  let appUserReady = false;
  for (let attempt = 0; attempt < 30 && !appUserReady; attempt += 1) {
    const role = psql('postgres', "SELECT count(*) FROM pg_roles WHERE rolname='app_user' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls");
    appUserReady = role.status === 0 && role.stdout.trim() === '1';
    if (!appUserReady) await delay(500);
  }
  assert(appUserReady, 'pg-init/01-app-user.sh 生效：app_user 存在（可登录、非 superuser、无 BYPASSRLS）');

  // 2) 全量迁移（postgres superuser —— 与四套 e2e 完全同路径）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（superuser，全量迁移含 RLS 入库）');

  // 迁移事实：24 表 ENABLE RLS + 24 条 tenant_isolation 策略
  const rlsTables = psql('postgres', "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity");
  assert(rlsTables.status === 0 && rlsTables.stdout.trim() === String(EXPECTED_RLS_TABLES),
    `RLS 已 ENABLE 的表数 = ${rlsTables.stdout.trim() || '(psql 失败)'}（期望 ${EXPECTED_RLS_TABLES}）`);
  const policies = psql('postgres', "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'");
  assert(policies.status === 0 && policies.stdout.trim() === String(EXPECTED_RLS_TABLES),
    `tenant_isolation 策略数 = ${policies.stdout.trim() || '(psql 失败)'}（期望 ${EXPECTED_RLS_TABLES}）`);

  // 3) 面 ①：superuser CRUD 正常（owner/superuser 绕过 RLS——e2e 语义零破坏）
  const seed = psql('postgres',
    `INSERT INTO users (id, tenant_id, username, display_name) VALUES
       ('proof-id-a', 't-a', 'proof-a', '租户A用户'), ('proof-id-b', 't-b', 'proof-b', '租户B用户');`);
  assert(seed.status === 0, `面① superuser INSERT（两租户种子）→ ${seed.status === 0 ? 'OK' : seed.stderr.trim()}`);
  const superSelect = psql('postgres', 'SELECT count(*) FROM users');
  assert(superSelect.status === 0 && superSelect.stdout.trim() === '2',
    `面① superuser SELECT count = ${superSelect.stdout.trim()}（两租户全可见）`);
  const superUpdate = psql('postgres', "UPDATE users SET display_name='租户A用户V2' WHERE tenant_id='t-a'");
  assert(superUpdate.status === 0 && superUpdate.stdout.trim() === 'UPDATE 1',
    `面① superuser UPDATE → ${superUpdate.stdout.trim() || superUpdate.stderr.trim()}`);

  // 4) 面 ②：app_user 不设 session 变量 → 查询 0 行 / 写入被拒
  const blindSelect = psql('app_user', 'SELECT count(*) FROM users');
  assert(blindSelect.status === 0 && blindSelect.stdout.trim() === '0',
    `面② app_user 无变量 SELECT count = ${blindSelect.stdout.trim()}（0 行，fail-closed）`);
  const blindInsert = psql('app_user', "INSERT INTO users (id, tenant_id, username, display_name) VALUES ('proof-id-x', 't-a', 'x', 'X')", { onErrorStop: false });
  assert(blindInsert.status !== 0 && /row-level security|violates/.test(blindInsert.stderr),
    `面② app_user 无变量 INSERT → 被拒（${blindInsert.stderr.trim().split('\n')[0] ?? ''}）`);

  // 5) 面 ③：app_user SET app.current_tenant='t-a' → 仅见 t-a；跨租户操作被拒
  const scopedSelect = psql('app_user', "SET app.current_tenant = 't-a'; SELECT count(*) FROM users");
  assert(scopedSelect.status === 0 && lastLine(scopedSelect.stdout) === '1',
    `面③ app_user SET t-a 后 count = ${lastLine(scopedSelect.stdout)}（仅 t-a 行，t-b 不可见）`);
  const scopedCross = psql('app_user', "SET app.current_tenant = 't-a'; SELECT count(*) FROM users WHERE tenant_id='t-b'");
  assert(scopedCross.status === 0 && lastLine(scopedCross.stdout) === '0',
    `面③ WHERE tenant_id='t-b' 计数 = ${lastLine(scopedCross.stdout)}（跨租户读 0 行）`);
  const scopedOwnInsert = psql('app_user', "SET app.current_tenant = 't-a'; INSERT INTO users (id, tenant_id, username, display_name) VALUES ('proof-id-a2', 't-a', 'proof-a2', '租户A第二用户')");
  assert(scopedOwnInsert.status === 0,
    `面③ 本租户 INSERT（t-a）→ OK（${lastLine(scopedOwnInsert.stdout) || scopedOwnInsert.stderr.trim()}）`);
  const crossUpdate = psql('app_user', "SET app.current_tenant = 't-a'; UPDATE users SET display_name='越权改写' WHERE tenant_id='t-b'");
  assert(crossUpdate.status === 0 && lastLine(crossUpdate.stdout) === 'UPDATE 0',
    `面③ 跨租户 UPDATE → ${lastLine(crossUpdate.stdout) || crossUpdate.stderr.trim()}（0 行命中，t-b 行未被改写）`);
  const tamper = psql('postgres', "SELECT display_name FROM users WHERE tenant_id='t-b'");
  assert(tamper.status === 0 && /租户B用户/.test(tamper.stdout) && !/越权改写/.test(tamper.stdout),
    `面③ 复核（superuser 读）：t-b 行内容未变 = ${JSON.stringify(tamper.stdout.trim())}（越权写未生效）`);
  const crossInsert = psql('app_user', "SET app.current_tenant = 't-a'; INSERT INTO users (id, tenant_id, username, display_name) VALUES ('proof-id-evil', 't-b', 'evil', '冒充租户B')", { onErrorStop: false });
  assert(crossInsert.status !== 0 && /row-level security|violates/.test(crossInsert.stderr),
    `面③ 跨租户 INSERT（冒充 t-b）→ 被 WITH CHECK 拒（${crossInsert.stderr.trim().split('\n')[0] ?? ''}）`);
  const superFinal = psql('postgres', 'SELECT count(*) FROM users');
  assert(superFinal.status === 0 && superFinal.stdout.trim() === '3',
    `收口 superuser 复核总行数 = ${superFinal.stdout.trim()}（2 种子 + 1 本租户合法写，无越权行）`);

  console.log(`\n[rls-proof] 完成：${failures === 0 ? '三面全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('rls-proof 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[rls-proof] 容器 ${CONTAINER} 已清理`);
  });
