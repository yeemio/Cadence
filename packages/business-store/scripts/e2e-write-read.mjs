/**
 * 活库端到端验证（需 DATABASE_URL + 已 prisma migrate deploy/dev + prisma generate）。
 * 用法：DATABASE_URL=... pnpm --filter @smes/business-store db:e2e
 *
 * 验证面：
 *   1. 事实行写入读回（证据公共列 + 租户列）
 *   2. append-only 语义：UPDATE 事实行被 DB 触发器拒绝
 *   3. 修正走 supersedes 链：新行 objectVersion+1、supersedes 指向前任；链可查询
 *   4. 跨租户 supersedes 被 FK 拒绝（tenant 贯通）
 *   5. 事件 + Outbox 同事务写入；Outbox 投递记账可 UPDATE（豁免触发器）
 */
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

const prisma = new PrismaClient();

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function expectReject(fn, message, match) {
  try {
    await fn();
    assert(false, `${message}（未抛出异常）`);
  } catch (error) {
    const text = String(error?.message ?? error);
    assert(match.test(text), `${message}（错误含 "${match.source}"）`);
  }
}

async function main() {
  const tenantA = 't-e2e-a';
  const tenantB = 't-e2e-b';
  const workOrderId = uuidv7();
  const id1 = uuidv7();

  // 1. 事实行写入读回（缺省 id 走 Prisma uuid(7) 兜底；此处显式传入走应用侧权威生成）
  await prisma.workOrderRecord.create({
    data: {
      id: id1,
      tenantId: tenantA,
      workOrderId,
      objectVersion: 1,
      auditStatus: 'draft',
      provenance: { operationId: 'op-e2e-1', source: 'e2e' },
    },
  });
  const readBack = await prisma.workOrderRecord.findUniqueOrThrow({ where: { id: id1 } });
  assert(readBack.tenantId === tenantA, `事实行读回 tenantId=${readBack.tenantId}`);
  assert(readBack.objectVersion === 1 && readBack.auditStatus === 'draft', '事实行读回证据公共列');
  assert(readBack.provenance?.operationId === 'op-e2e-1', 'provenance JSONB 读回');
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/.test(readBack.id),
    'id 为 uuidv7（版本位 7）',
  );

  // Prisma 兜底路径：不传 id，由 client 侧 @default(uuid(7)) 生成
  const fallbackRow = await prisma.workOrderRecord.create({
    data: { tenantId: tenantA, workOrderId, objectVersion: 1, auditStatus: 'draft' },
  });
  assert(/-7[0-9a-f]{3}-/.test(fallbackRow.id), '@default(uuid(7)) 兜底生成的 id 版本位为 7');

  // 2. append-only：UPDATE 被触发器拒绝
  await expectReject(
    () => prisma.$executeRaw`UPDATE work_order_records SET audit_status = 'hack' WHERE id = ${id1}::uuid`,
    'append-only：UPDATE 事实行被拒',
    /append-only|Blocked/i,
  );
  await expectReject(
    () => prisma.$executeRaw`DELETE FROM work_order_records WHERE id = ${id1}::uuid`,
    'append-only：DELETE 事实行被拒',
    /append-only|Blocked/i,
  );

  // 3. 修正走 supersedes 链
  const id2 = uuidv7();
  await prisma.workOrderRecord.create({
    data: {
      id: id2,
      tenantId: tenantA,
      workOrderId,
      objectVersion: 2,
      auditStatus: 'draft',
      supersedes: id1,
      businessTime: new Date('2026-10-24T08:00:00Z'),
    },
  });
  const chain = await prisma.workOrderRecord.findMany({
    where: { tenantId: tenantA, workOrderId },
    orderBy: { objectVersion: 'asc' },
  });
  assert(chain.length === 3, `修正链可查询（含兜底行，共 ${chain.length} 行）`);
  assert(chain.at(-1)?.supersedes === id1 && chain.at(-1)?.objectVersion === 2, 'supersedes 链形状正确');

  // 4. 跨租户 supersedes 被拒（fields 含 tenantId 的复合外键）
  await expectReject(
    () =>
      prisma.workOrderRecord.create({
        data: {
          id: uuidv7(),
          tenantId: tenantB,
          workOrderId,
          objectVersion: 2,
          auditStatus: 'draft',
          supersedes: id1,
        },
      }),
    '跨租户 supersedes 被复合 FK 拒绝',
    /foreign key|ForeignKeyConstraintViolation/i,
  );

  // 事件 + Outbox 同事务
  const eventId = `evt-${uuidv7()}`;
  await prisma.$transaction([
    prisma.businessEventRecord.create({
      data: {
        eventId,
        tenantId: tenantA,
        eventType: 'smes.workorder.v1.created',
        aggregateId: workOrderId,
        aggregateType: 'workorder',
        aggregateRevision: 1,
        occurredAt: new Date(),
        payload: { qty: 10 },
      },
    }),
    prisma.outboxRecord.create({
      data: { eventId, tenantId: tenantA, createdAt: new Date(), attempts: 0, deliveredAt: null },
    }),
  ]);
  const event = await prisma.businessEventRecord.findUniqueOrThrow({ where: { eventId } });
  assert(event.payload?.qty === 10, '事件载荷 JSONB 读回');

  // 事件表 append-only
  await expectReject(
    () => prisma.$executeRaw`UPDATE event_records SET event_type = 'hack' WHERE event_id = ${eventId}`,
    'append-only：UPDATE 事件行被拒',
    /append-only|Blocked/i,
  );

  // 5. Outbox 投递记账可 UPDATE（豁免）
  await prisma.outboxRecord.update({
    where: { eventId },
    data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), deliveredAt: new Date() },
  });
  const outbox = await prisma.outboxRecord.findUniqueOrThrow({ where: { eventId } });
  assert(outbox.attempts === 1 && outbox.deliveredAt !== null, 'Outbox 投递记账可更新');

  console.log('\ne2e 完成');
}

main()
  .catch((error) => {
    console.error('e2e 出错:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
