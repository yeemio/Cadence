/**
 * PgInspectionOrderStore.revertJudgment PG 形态锚定（D-24，retest-59c9f8d）。
 *
 * 缺陷：撤销判定端口此前只在内存实现有（6a-2 验收登记 PG 适配器 fail-closed
 * 缺位）——部署形态（DATABASE_URL 接线）inspection.revoke.v1 在用例层
 * "存储适配器未实现 revertJudgment" 恒拒，质检撤销功能不可用。
 *
 * 纯桩面（不连库；体例同 inventory-rls-raw.test.ts）：桩 prisma 记录
 * inspectionOrderRecord.findFirst / updateMany / findFirstOrThrow 时序与实参，
 * 锚定三面（对照 in-memory revertJudgment 与 inspection-stores.ts 端口头注）：
 *  1) 命中：条件 UPDATE（where 含 objectVersion 乐观锁）state/版本推进 +
 *     判定五字段与 closeDueAt/overdueNotifiedAt 全清 null，读回投影行；
 *  2) 行不存在 → null（404 语义由用例层翻译，不发起 UPDATE）；
 *  3) 版本不符（UPDATE 零行命中）→ InspectionConflictError（同 updateJudgment
 *     合同——并发写冲突不吞成 404）。
 * 容器级活库复证（登记，不在本测试面）：deploy compose 起库后经
 * inspection.revoke.v1 HTTP 面端到端——见回传报告复证命令。
 */
import { describe, expect, it, vi } from 'vitest';
import { InspectionId, TenantId } from '@smes/business-core';
import { InspectionConflictError } from '@smes/application';
import type { PrismaClient } from '@prisma/client';

vi.mock('@prisma/client', () => ({
  // 本测试路径不触发 isUniqueViolation 形状消费（实际不命中）；不连库。
  Prisma: { PrismaClientKnownRequestError: class MockKnownRequestError extends Error {} },
  PrismaClient: class MockPrismaClient {},
}));

import { PgInspectionOrderStore } from '../src/inspection/pg-inspection-stores.js';

const TENANT = TenantId.create('t-d24');
const ID = InspectionId.create('insp-d24-1');
const T0 = new Date('2026-10-26T08:00:00.000Z');

/** 已判定单投影行（failed 判定 + 点名标记在身——撤销前形态）。 */
const judgedRow = {
  id: 'insp-d24-1',
  tenantId: 't-d24',
  flowConfigId: 'inspection',
  state: 'failed',
  objectVersion: 3,
  kind: 'incoming',
  sourceType: 'purchase',
  sourceRefId: 'po-1',
  itemId: 'item-1',
  drawingNo: null,
  quantity: 10,
  passedQty: 0,
  failedQty: 10,
  judgeRemark: '尺寸超差',
  judgedBy: 'qc-01',
  judgedAt: T0,
  closeDueAt: T0,
  overdueNotifiedAt: T0,
  createdAt: T0,
  updatedAt: T0,
};

/** 读回行（UPDATE 落库后的形状——七字段清空 + state/版本推进）。 */
const revertedRow = {
  ...judgedRow,
  state: 'pending',
  objectVersion: 4,
  passedQty: null,
  failedQty: null,
  judgeRemark: null,
  judgedBy: null,
  judgedAt: null,
  closeDueAt: null,
  overdueNotifiedAt: null,
};

/** 桩 prisma：三操作时序记录 + 可配置存在性与 UPDATE 命中行数。 */
function makeStub(existing: typeof judgedRow | null, updateCount: number) {
  const calls: Array<{ readonly op: string; readonly args: unknown }> = [];
  const stub = {
    inspectionOrderRecord: {
      async findFirst(args: unknown) {
        calls.push({ op: 'findFirst', args });
        return existing;
      },
      async updateMany(args: unknown) {
        calls.push({ op: 'updateMany', args });
        return { count: updateCount };
      },
      async findFirstOrThrow(args: unknown) {
        calls.push({ op: 'findFirstOrThrow', args });
        return revertedRow;
      },
    },
  };
  return { calls, asPrisma: () => stub as unknown as PrismaClient };
}

describe('PgInspectionOrderStore.revertJudgment（D-24：PG 形态撤销判定投影清理）', () => {
  it('命中：条件 UPDATE（乐观 where）清判定五字段 + closeDueAt/overdueNotifiedAt，state/版本推进后读回', async () => {
    const stub = makeStub(judgedRow, 1);
    const store = new PgInspectionOrderStore(stub.asPrisma());

    const reverted = await store.revertJudgment(TENANT, ID, 3, 'pending', 4);

    // 时序：存在性预检 → 条件 UPDATE → 读回（同 updateJudgment 体例）。
    expect(stub.calls.map((call) => call.op)).toEqual(['findFirst', 'updateMany', 'findFirstOrThrow']);
    // 条件 UPDATE 实参：乐观锁 where + 七字段清 null + state/版本推进。
    const update = stub.calls[1]!.args as {
      readonly where: Record<string, unknown>;
      readonly data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ tenantId: TENANT, id: ID, objectVersion: 3 });
    expect(update.data).toMatchObject({
      state: 'pending',
      objectVersion: 4,
      passedQty: null,
      failedQty: null,
      judgeRemark: null,
      judgedBy: null,
      judgedAt: null,
      closeDueAt: null,
      overdueNotifiedAt: null,
    });
    // 读回投影：判定痕迹全清 + 点名标记清空（再判不合格重新起时限）。
    expect(reverted).not.toBeNull();
    expect(reverted!.state).toBe('pending');
    expect(reverted!.objectVersion).toBe(4);
    expect(reverted!.passedQty).toBeNull();
    expect(reverted!.failedQty).toBeNull();
    expect(reverted!.judgeRemark).toBeNull();
    expect(reverted!.judgedBy).toBeNull();
    expect(reverted!.judgedAt).toBeNull();
    expect(reverted!.closeDueAt).toBeNull();
    expect(reverted!.overdueNotifiedAt).toBeNull();
  });

  it('行不存在 → null（404 语义由用例层翻译），不发起 UPDATE', async () => {
    const stub = makeStub(null, 1);
    const store = new PgInspectionOrderStore(stub.asPrisma());
    await expect(store.revertJudgment(TENANT, ID, 3, 'pending', 4)).resolves.toBeNull();
    expect(stub.calls.map((call) => call.op)).toEqual(['findFirst']); // 零 UPDATE
  });

  it('版本不符（UPDATE 零行命中）→ InspectionConflictError，消息含期望/实际版本', async () => {
    const stub = makeStub(judgedRow, 0); // 预检读到 v3，但 UPDATE 未命中（并发已推进）
    const store = new PgInspectionOrderStore(stub.asPrisma());
    const attempt = store.revertJudgment(TENANT, ID, 2, 'pending', 4);
    await expect(attempt).rejects.toBeInstanceOf(InspectionConflictError);
    await expect(attempt).rejects.toThrow(/期望 2.*实际 3/);
    expect(stub.calls.map((call) => call.op)).toEqual(['findFirst', 'updateMany']); // 不读回
  });

  it('实现即端口能力：实例上 revertJudgment 为函数（用例层 fail-closed 探测不再命中）', () => {
    const store = new PgInspectionOrderStore(makeStub(judgedRow, 1).asPrisma());
    // 对齐用例层探测形状（inspection.service.ts revoke：typeof this.orders.revertJudgment !== 'function'）。
    const asStore = store as unknown as { revertJudgment?: unknown };
    expect(typeof asStore.revertJudgment).toBe('function');
  });
});
