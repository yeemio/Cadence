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
 * 容器/assert/run 机制脚手架与 rls-session-proof.mjs 共享 ./harness.mjs
 * （M4 收尾波双写去重——本脚本只保留被证事实）。
 *
 * 用法：node deploy/scripts/rls-proof.mjs   （需 docker；自管容器清理）
 */
import {
  cleanupProofPostgres,
  createProofAsserts,
  DEPLOY_DIR,
  lastLine,
  run,
  startProofPostgres,
} from './harness.mjs';

const PG_PORT = 55521; // 避开 e2e 脚本端口（55491/55494…）
const CONTAINER = `cadence-rls-proof-${process.pid}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const EXPECTED_RLS_TABLES = 101; // schema 全部带 tenant_id 的表（rls-conformance 守恒；S1 backfill 六表 80→86；U 波 T1 三表+issue 五表+attachment+原材料关联+售后报销两表 86→98；U7 项目成本三表 98→101）

const kit = createProofAsserts();

async function main() {
  console.log(`[rls-proof] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}，pg-init=${DEPLOY_DIR}/pg-init`);

  // 1) 一次性容器（挂 pg-init：受限 app 用户 = RLS 生效前提，本实证真实消费）
  const { psql } = await startProofPostgres({
    container: CONTAINER,
    port: PG_PORT,
    appPassword: 'app_proof_password',
    assert: kit,
  });

  // 2) 全量迁移（postgres superuser —— 与四套 e2e 完全同路径）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  kit.assert(migrate.status === 0, 'prisma migrate deploy（superuser，全量迁移含 RLS 入库）');

  // 迁移事实：24 表 ENABLE RLS + 24 条 tenant_isolation 策略
  const rlsTables = psql('postgres', "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity");
  kit.assert(rlsTables.status === 0 && rlsTables.stdout.trim() === String(EXPECTED_RLS_TABLES),
    `RLS 已 ENABLE 的表数 = ${rlsTables.stdout.trim() || '(psql 失败)'}（期望 ${EXPECTED_RLS_TABLES}）`);
  const policies = psql('postgres', "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'");
  kit.assert(policies.status === 0 && policies.stdout.trim() === String(EXPECTED_RLS_TABLES),
    `tenant_isolation 策略数 = ${policies.stdout.trim() || '(psql 失败)'}（期望 ${EXPECTED_RLS_TABLES}）`);

  // 3) 面 ①：superuser CRUD 正常（owner/superuser 绕过 RLS——e2e 语义零破坏）
  const seed = psql('postgres',
    `INSERT INTO users (id, tenant_id, username, display_name) VALUES
       ('proof-id-a', 't-a', 'proof-a', '租户A用户'), ('proof-id-b', 't-b', 'proof-b', '租户B用户');`);
  kit.assert(seed.status === 0, `面① superuser INSERT（两租户种子）→ ${seed.status === 0 ? 'OK' : seed.stderr.trim()}`);
  const superSelect = psql('postgres', 'SELECT count(*) FROM users');
  kit.assert(superSelect.status === 0 && superSelect.stdout.trim() === '2',
    `面① superuser SELECT count = ${superSelect.stdout.trim()}（两租户全可见）`);
  const superUpdate = psql('postgres', "UPDATE users SET display_name='租户A用户V2' WHERE tenant_id='t-a'");
  kit.assert(superUpdate.status === 0 && superUpdate.stdout.trim() === 'UPDATE 1',
    `面① superuser UPDATE → ${superUpdate.stdout.trim() || superUpdate.stderr.trim()}`);

  // 4) 面 ②：app_user 不设 session 变量 → 查询 0 行 / 写入被拒
  const blindSelect = psql('app_user', 'SELECT count(*) FROM users');
  kit.assert(blindSelect.status === 0 && blindSelect.stdout.trim() === '0',
    `面② app_user 无变量 SELECT count = ${blindSelect.stdout.trim()}（0 行，fail-closed）`);
  const blindInsert = psql('app_user', "INSERT INTO users (id, tenant_id, username, display_name) VALUES ('proof-id-x', 't-a', 'x', 'X')", { onErrorStop: false });
  kit.assert(blindInsert.status !== 0 && /row-level security|violates/.test(blindInsert.stderr),
    `面② app_user 无变量 INSERT → 被拒（${blindInsert.stderr.trim().split('\n')[0] ?? ''}）`);

  // 5) 面 ③：app_user SET app.current_tenant='t-a' → 仅见 t-a；跨租户操作被拒
  const scopedSelect = psql('app_user', "SET app.current_tenant = 't-a'; SELECT count(*) FROM users");
  kit.assert(scopedSelect.status === 0 && lastLine(scopedSelect.stdout) === '1',
    `面③ app_user SET t-a 后 count = ${lastLine(scopedSelect.stdout)}（仅 t-a 行，t-b 不可见）`);
  const scopedCross = psql('app_user', "SET app.current_tenant = 't-a'; SELECT count(*) FROM users WHERE tenant_id='t-b'");
  kit.assert(scopedCross.status === 0 && lastLine(scopedCross.stdout) === '0',
    `面③ WHERE tenant_id='t-b' 计数 = ${lastLine(scopedCross.stdout)}（跨租户读 0 行）`);
  const scopedOwnInsert = psql('app_user', "SET app.current_tenant = 't-a'; INSERT INTO users (id, tenant_id, username, display_name) VALUES ('proof-id-a2', 't-a', 'proof-a2', '租户A第二用户')");
  kit.assert(scopedOwnInsert.status === 0,
    `面③ 本租户 INSERT（t-a）→ OK（${lastLine(scopedOwnInsert.stdout) || scopedOwnInsert.stderr.trim()}）`);
  const crossUpdate = psql('app_user', "SET app.current_tenant = 't-a'; UPDATE users SET display_name='越权改写' WHERE tenant_id='t-b'");
  kit.assert(crossUpdate.status === 0 && lastLine(crossUpdate.stdout) === 'UPDATE 0',
    `面③ 跨租户 UPDATE → ${lastLine(crossUpdate.stdout) || crossUpdate.stderr.trim()}（0 行命中，t-b 行未被改写）`);
  const tamper = psql('postgres', "SELECT display_name FROM users WHERE tenant_id='t-b'");
  kit.assert(tamper.status === 0 && /租户B用户/.test(tamper.stdout) && !/越权改写/.test(tamper.stdout),
    `面③ 复核（superuser 读）：t-b 行内容未变 = ${JSON.stringify(tamper.stdout.trim())}（越权写未生效）`);
  const crossInsert = psql('app_user', "SET app.current_tenant = 't-a'; INSERT INTO users (id, tenant_id, username, display_name) VALUES ('proof-id-evil', 't-b', 'evil', '冒充租户B')", { onErrorStop: false });
  kit.assert(crossInsert.status !== 0 && /row-level security|violates/.test(crossInsert.stderr),
    `面③ 跨租户 INSERT（冒充 t-b）→ 被 WITH CHECK 拒（${crossInsert.stderr.trim().split('\n')[0] ?? ''}）`);
  const superFinal = psql('postgres', 'SELECT count(*) FROM users');
  kit.assert(superFinal.status === 0 && superFinal.stdout.trim() === '3',
    `收口 superuser 复核总行数 = ${superFinal.stdout.trim()}（2 种子 + 1 本租户合法写，无越权行）`);

  console.log(`\n[rls-proof] 完成：${kit.failures === 0 ? '三面全部通过' : `${kit.failures} 项失败`}`);
  process.exitCode = kit.failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('rls-proof 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupProofPostgres(CONTAINER, 'rls-proof');
  });
