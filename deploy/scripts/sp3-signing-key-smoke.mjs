/**
 * SP-3 签名密钥 env 固化冒烟（M2 安全前置批波 b，CONTRACT §SP-3 验证节）。
 *
 * 真实进程起停 + 一次性 PG 容器（harness.mjs 同体例，自管自清），两域各证一次：
 *   ① 设 env 起服 → 签发 read-reference → 杀进程重启 → 同 URL 仍兑现
 *      （附件：PG bytea 适配器 + SMES_ATTACHMENT_REF_SECRET；图纸：PG 五存储 +
 *      SMES_DRAWING_REF_SECRET——字节/修订与密钥都跨重启，404 只可能来自密钥）；
 *   ② 未设 env → 启动 warn 各一行 + 重启后旧引用 404（随机密钥轮换，实态不变）；
 *   ③ 格式非法（非 32 字节）→ 拒启动（fail-fast，两键各证一次）。
 *
 * 身份/权限：SMES_DEV_AUTH=on 的 x-smes-user dev 头 + /dev/policies 注入
 * admin 角色（生产形态不开——见 dev-policy.controller.ts 头注）。
 * DATABASE_URL 用容器 superuser（绕 RLS）：本冒烟证密钥语义，不证租户隔离
 * （RLS 三面归 rls-proof.mjs）。
 *
 * 用法：node deploy/scripts/sp3-signing-key-smoke.mjs   （需 docker；退出码
 * 0 = 全部断言通过 / 1 = 有失败项）
 */
import { spawn } from 'node:child_process';
import {
  cleanupProofPostgres,
  createProofAsserts,
  DEPLOY_DIR,
  REPO_ROOT,
  run,
  startProofPostgres,
  waitFor,
} from './harness.mjs';

const PG_PORT = 55522; // 避开 e2e 端口段（55491/55494…）与 rls-proof（55521）
const HTTP_PORT = 55531;
const CONTAINER = `cadence-sp3-smoke-${process.pid}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const OPERATOR = 'u-sp3-smoke';
const HEADERS = { 'x-smes-user': OPERATOR, 'content-type': 'application/json' };
const ATTACHMENT_KEY = 'ab'.repeat(32); // 64 位 hex → 32 字节（合法形状）
const DRAWING_KEY = 'cd'.repeat(32);
const FILE_BYTES = Buffer.from('sp3-signing-key-smoke 附件字节内容');

const kit = createProofAsserts();

/** 起一个真实 server 进程（env 决定形态），stdout/stderr 归档供 warn 断言。 */
function startServer(envExtra, label) {
  const child = spawn('node', ['apps/server/dist/main.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(HTTP_PORT),
      DATABASE_URL,
      MODULES_ENABLED: 'core,org,attachment,drawing',
      SMES_DEV_AUTH: 'on',
      SMES_DEV_POLICY_ENDPOINT: 'on',
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    out += String(chunk);
  });
  return { child, log: () => out, label };
}

async function stopServer(handle) {
  if (handle.child.exitCode !== null) return;
  handle.child.kill('SIGTERM');
  await waitFor(() => handle.child.exitCode !== null, { attempts: 30, intervalMs: 200 });
  if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

async function waitHealthy(label) {
  const ok = await waitFor(
    () => run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}/health`], { capture: true }).stdout === '200',
    { attempts: 60, intervalMs: 500 },
  );
  kit.assert(ok, `${label}：server /health 200`);
  return ok;
}

async function grantAdmin() {
  const res = await fetch(`${BASE}/dev/policies`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ rules: [{ kind: 'grant-role', tenant: 'default', user: OPERATOR, role: 'admin' }] }),
  });
  kit.assert(res.status === 200, `dev 策略注入 admin 角色（${res.status}）`);
}

/** 附件域：上传 → 签发下载引用 → 兑现 200（返回引用 URL 与字节一致性断言用）。 */
async function attachmentIssueAndRedeem() {
  const uploadRes = await fetch(`${BASE}/attachment/upload`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      fileName: 'sp3-smoke.txt',
      contentBase64: FILE_BYTES.toString('base64'),
      bizType: 'workorder',
      bizId: 'sp3-smoke-biz',
    }),
  });
  kit.assert(uploadRes.status === 201 || uploadRes.status === 200, `附件上传（${uploadRes.status}）`);
  const uploaded = await uploadRes.json();
  const refRes = await fetch(
    `${BASE}/attachment/download-reference?id=${encodeURIComponent(uploaded.id)}&bizId=sp3-smoke-biz`,
    { headers: HEADERS },
  );
  kit.assert(refRes.status === 200, `附件下载引用签发（${refRes.status}）`);
  const reference = await refRes.json();
  const redeem = await fetch(`${BASE}${reference.url}`);
  kit.assert(redeem.status === 200, `附件引用兑现（${redeem.status}）`);
  return reference.url;
}

/** 图纸域：发布 → 查看签发只读引用 → 兑现 200（返回引用 URL）。 */
async function drawingIssueAndRedeem(drawingId) {
  const publishRes = await fetch(`${BASE}/drawing/revisions/commands`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      operationId: `sp3-smoke-${Date.now()}`,
      expectedRevision: 'initial',
      command: {
        kind: 'drawing.publish.v1',
        payload: {
          drawingId,
          fileRef: 'files/dwg-sp3-smoke.pdf',
          changeNote: 'SP-3 冒烟发布',
          classification: 'public',
        },
      },
    }),
  });
  kit.assert(publishRes.status === 201 || publishRes.status === 200, `图纸发布（${publishRes.status}）`);
  const viewRes = await fetch(
    `${BASE}/drawing/revisions/${encodeURIComponent(drawingId)}/view?clearance=public&referenceTtlSeconds=600`,
    { headers: HEADERS },
  );
  kit.assert(viewRes.status === 200, `图纸查看+只读引用签发（${viewRes.status}）`);
  const view = await viewRes.json();
  kit.assert(typeof view.readReference?.url === 'string', '图纸回执携带 readReference.url');
  const redeem = await fetch(`${BASE}${view.readReference.url}`);
  kit.assert(redeem.status === 200, `图纸引用兑现（${redeem.status}）`);
  return view.readReference.url;
}

async function main() {
  console.log(`[sp3-smoke] 容器 ${CONTAINER}，PG ${PG_PORT}，HTTP ${HTTP_PORT}`);

  // 0) 前置：server 构建（真实 dist 起服）+ PG 容器 + 全量迁移
  const build = run('pnpm', ['--filter', '@smes/server', 'build']);
  kit.assert(build.status === 0, '@smes/server build（dist/main.js 就位）');
  await startProofPostgres({ container: CONTAINER, port: PG_PORT, appPassword: 'sp3-smoke-app', assert: kit });
  const migrate = run(
    'pnpm',
    ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    { env: { DATABASE_URL } },
  );
  kit.assert(migrate.status === 0, 'prisma migrate deploy（superuser，含 attachment_objects/drawing 表）');

  // ① 设 env：起服 → 两域签发+兑现 → 重启进程 → 同 URL 仍兑现
  const bootA = startServer(
    { SMES_ATTACHMENT_REF_SECRET: ATTACHMENT_KEY, SMES_DRAWING_REF_SECRET: DRAWING_KEY },
    'boot-A(设 env)',
  );
  if (!(await waitHealthy('boot-A'))) return finish(bootA);
  await grantAdmin();
  const attachmentUrl = await attachmentIssueAndRedeem();
  const drawingUrl = await drawingIssueAndRedeem('DWG-SP3-SMOKE-001');
  const logA = bootA.log();
  kit.assert(!logA.includes('SMES_ATTACHMENT_REF_SECRET 未设置'), 'boot-A：附件密钥 warn 不出现（env 已设）');
  kit.assert(!logA.includes('SMES_DRAWING_REF_SECRET 未设置'), 'boot-A：图纸密钥 warn 不出现（env 已设）');
  await stopServer(bootA);

  const bootB = startServer(
    { SMES_ATTACHMENT_REF_SECRET: ATTACHMENT_KEY, SMES_DRAWING_REF_SECRET: DRAWING_KEY },
    'boot-B(重启,同 env)',
  );
  if (!(await waitHealthy('boot-B'))) return finish(bootB);
  // 附件 TTL 缺省 60s——重启窗口内最先兑现（404 只可能来自密钥，字节在 PG bytea）
  const attRedeem = await fetch(`${BASE}${attachmentUrl}`);
  const attBody = attRedeem.status === 200 ? Buffer.from(await attRedeem.arrayBuffer()) : null;
  kit.assert(attRedeem.status === 200 && attBody?.equals(FILE_BYTES), `①附件域：重启后同 URL 兑现 200+字节一致（${attRedeem.status}）`);
  const drawRedeem = await fetch(`${BASE}${drawingUrl}`);
  kit.assert(drawRedeem.status === 200, `①图纸域：重启后同 URL 兑现 200（${drawRedeem.status}）`);
  await stopServer(bootB);

  // ② 未设 env：warn 两行 + 重启后旧引用 404（随机密钥轮换；PG 数据仍在——
  //    404 归因即密钥，非数据丢失）
  const bootC = startServer({}, 'boot-C(未设 env)');
  if (!(await waitHealthy('boot-C'))) return finish(bootC);
  await grantAdmin();
  const attachmentUrl2 = await attachmentIssueAndRedeem();
  const drawingUrl2 = await drawingIssueAndRedeem('DWG-SP3-SMOKE-002');
  const logC = bootC.log();
  kit.assert(logC.includes('SMES_ATTACHMENT_REF_SECRET 未设置'), '②附件域：未设 env → 启动 warn 一行');
  kit.assert(logC.includes('SMES_DRAWING_REF_SECRET 未设置'), '②图纸域：未设 env → 启动 warn 一行');
  await stopServer(bootC);

  const bootD = startServer({}, 'boot-D(重启,仍未设)');
  if (!(await waitHealthy('boot-D'))) return finish(bootD);
  const att404 = await fetch(`${BASE}${attachmentUrl2}`);
  kit.assert(att404.status === 404, `②附件域：未设 env 重启后旧引用 404（${att404.status}，随机密钥轮换）`);
  const draw404 = await fetch(`${BASE}${drawingUrl2}`);
  kit.assert(draw404.status === 404, `②图纸域：未设 env 重启后旧引用 404（${draw404.status}）`);
  await stopServer(bootD);

  // ③ 格式非法 → fail-fast 拒启动（两键各证一次；非 32 字节/非法编码）
  for (const [name, bad] of [
    ['SMES_ATTACHMENT_REF_SECRET', 'not-32-bytes!!'],
    ['SMES_DRAWING_REF_SECRET', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde'], // 63 位 hex
  ]) {
    const failBoot = startServer({ [name]: bad }, `fail-fast(${name})`);
    const rejected = await waitFor(() => failBoot.child.exitCode !== null, { attempts: 40, intervalMs: 500 });
    const failLog = failBoot.log();
    kit.assert(
      rejected && failBoot.child.exitCode !== 0 && failLog.includes(name) && failLog.includes('拒绝启动'),
      `③${name} 格式非法 → 进程拒绝启动（exit=${failBoot.child.exitCode}）`,
    );
    if (failBoot.child.exitCode === null) failBoot.child.kill('SIGKILL');
  }

  return finish();
}

async function finish(...leftovers) {
  for (const handle of leftovers) await stopServer(handle);
  await cleanupProofPostgres(CONTAINER, 'sp3-smoke');
  console.log(`[sp3-smoke] 结束：${kit.failures === 0 ? '全部断言通过' : `${kit.failures} 项失败`}（工作目录 ${DEPLOY_DIR}）`);
  process.exitCode = kit.failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('[sp3-smoke] 未预期失败：', error);
  cleanupProofPostgres(CONTAINER, 'sp3-smoke').finally(() => {
    process.exitCode = 1;
  });
});
