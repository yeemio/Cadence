/**
 * dispatch 售后报销测试（U5 A12，文档《售后派工》§2.4 口径）：新增前置（挂售后
 * 派工单 + 仅审批通过后可填报 + 一单一报销）、明细恰合（与通过报工集双向无缺漏）、
 * 四费默认 0/≥0/上界、金额合计、编辑只改四费/备注 + 乐观锁、幂等（operationId）、
 * 查询面（by-dispatch data=null 口径 / context 判定事实）、域事件（filed/updated
 * → A5 售后成本块信号）、默认空端口 fail-closed、模块装配与权限码。零框架直连
 * （内存实现 + 可注入假端口；reporting 真实接线归合流）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { DispatchInputError } from '../../src/dispatch/dispatch-errors.js';
import { parseIdParam } from '../../src/dispatch/dispatch-input.js';
import type { DispatchKind } from '../../src/dispatch/dispatch-config.js';
import {
  InMemoryDispatchDomainEventStore,
  InMemoryDispatchOperationStore,
  InMemoryDispatchOrderStore,
} from '../../src/dispatch/in-memory-dispatch-stores.js';
import { InMemoryAftercareClaimStore } from '../../src/dispatch/in-memory-aftercare-claim-stores.js';
import { AftercareClaimModule } from '../../src/dispatch/aftercare-claim.module.js';
import { AftercareClaimController } from '../../src/dispatch/aftercare-claim.controllers.js';
import { AftercareClaimService } from '../../src/dispatch/aftercare-claim.service.js';
import type { AftercareClaimCommitted, AftercareClaimCommandResult } from '../../src/dispatch/aftercare-claim.service.js';
import { AFTERCARE_CLAIM_EVENT_TYPES } from '../../src/dispatch/aftercare-claim-events.js';
import {
  parseAftercareClaimSavePayload,
  parseAftercareClaimUpdatePayload,
  type AftercareClaimCommand,
} from '../../src/dispatch/aftercare-claim-input.js';
import type {
  AftercareApprovedReportLine,
  AftercareApprovedReportPort,
} from '../../src/dispatch/aftercare-claim-ports.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const finance = UserId.create('u-finance-01');
const worker1 = UserId.create('u-worker-01');
const worker2 = UserId.create('u-worker-02');
const verifier = UserId.create('u-verifier-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（审批通过报工事实夹具） ----

class FakeApprovedReportPort implements AftercareApprovedReportPort {
  rows = new Map<string, AftercareApprovedReportLine[]>(); // dispatchId -> 通过报工行

  seed(dispatchId: string, lines: AftercareApprovedReportLine[]): void {
    this.rows.set(dispatchId, [...lines].sort((a, b) => a.reportDate.localeCompare(b.reportDate)));
  }

  async listApproved(_tenant: TenantId, dispatchId: string): Promise<readonly AftercareApprovedReportLine[]> {
    return this.rows.get(dispatchId) ?? [];
  }
}

function approvedLine(
  reportId: string,
  worker: UserId,
  reportDate: string,
  approvedMinutes: number,
): AftercareApprovedReportLine {
  return { reportId, reportDate, worker, approvedBy: verifier, approvedMinutes };
}

// ---- 装配 ----

function newHarness(reportPort?: FakeApprovedReportPort) {
  const orders = new InMemoryDispatchOrderStore();
  const claims = new InMemoryAftercareClaimStore();
  const operations = new InMemoryDispatchOperationStore();
  const domainEvents = new InMemoryDispatchDomainEventStore();
  const reports = reportPort ?? new FakeApprovedReportPort();
  const service = new AftercareClaimService(orders, claims, operations, domainEvents, reports, {
    now: () => FIXED_NOW,
  });
  return { orders, claims, operations, domainEvents, reports, service };
}

/** 造一张售后派工单（draft 初始投影直落存储——报销面只读单头）。 */
async function seedAftermarketOrder(
  orders: InMemoryDispatchOrderStore,
  id = 'dsp-after-1',
  kind: DispatchKind = 'aftermarket',
): Promise<string> {
  await orders.create({
    tenant: t1,
    id,
    workOrderId: 'wo-1',
    kind,
    flowConfigId: 'dispatch-default',
    state: 'draft',
    objectVersion: 1,
    title: '售后派工：客户现场调试',
    drawingNo: null,
    operationCode: null,
    material: null,
    sizeSpec: null,
    quantity: 1,
    assignee: worker1,
    dueAt: null,
    remark: null,
  });
  return id;
}

let opSeq = 0;
function envelopeOf(
  kind: AftercareClaimCommand['kind'],
  payload: unknown,
  expectedRevision: 'initial' | number = 'initial',
  tenant: TenantId = t1,
): CommandEnvelope<AftercareClaimCommand> {
  opSeq += 1;
  return makeCommandEnvelope({
    tenantId: tenant,
    issuedBy: finance,
    operationId: OperationId.create(`op-aftercare-${opSeq}`),
    expectedRevision,
    issuedAt: FIXED_NOW,
    command: { kind, payload },
  });
}

async function committed(result: AftercareClaimCommandResult): Promise<AftercareClaimCommitted> {
  expect(result.status).toBe('committed');
  return result as AftercareClaimCommitted;
}

function mustBeRejected(result: AftercareClaimCommandResult, reasonMatch: string): void {
  expect(result.status).toBe('rejected');
  expect((result as { readonly reason: string }).reason).toContain(reasonMatch);
}

/** 标准夹具：一单两通过报工（两人两日）。 */
function standardApproved(): AftercareApprovedReportLine[] {
  return [
    approvedLine('wr-001', worker1, '2026-10-20T08:00:00.000Z', 480),
    approvedLine('wr-002', worker2, '2026-10-21T08:00:00.000Z', 300),
  ];
}

// ---- 新增（aftercare.claim.save） ----

describe('aftercare.claim.save：仅审批通过后可填报 + 一单一报销', () => {
  it('落单：行身份快照（报工日期/售后人/审批人/审批工时）+ 四费默认 0 + 合计计算 + filed 事件', async () => {
    const h = newHarness();
    const dispatchId = await seedAftermarketOrder(h.orders);
    h.reports.seed(dispatchId, standardApproved());

    const result = await committed(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: [
            { reportId: 'wr-001', lodgingMinor: 20000, trafficMinor: 5000 },
            { reportId: 'wr-002', overtimeMinor: 8000, remark: '夜间抢修加班' },
          ],
        }),
      ),
    );

    expect(result.newRevision).toBe(1);
    expect(result.claim.dispatchId).toBe(dispatchId);
    expect(result.claim.totalMinor).toBe(33000); // 20000+5000+8000
    // 行 1：未填交通外费用默认 0；身份快照来自通过报工事实
    expect(result.claim.lines[0]).toMatchObject({
      lineNo: 1,
      reportId: 'wr-001',
      reportDate: '2026-10-20T08:00:00.000Z',
      worker: 'u-worker-01',
      approvedBy: 'u-verifier-01',
      approvedMinutes: 480,
      lodgingMinor: 20000,
      trafficMinor: 5000,
      overtimeMinor: 0,
      otherMinor: 0,
      remark: null,
      totalMinor: 25000,
    });
    expect(result.claim.lines[1]).toMatchObject({
      reportId: 'wr-002',
      worker: 'u-worker-02',
      lodgingMinor: 0,
      trafficMinor: 0,
      overtimeMinor: 8000,
      otherMinor: 0,
      totalMinor: 8000,
      remark: '夜间抢修加班',
    });

    // 域事件：filed（A5 售后成本块初值信号）
    expect(result.events[0]?.eventType).toBe(AFTERCARE_CLAIM_EVENT_TYPES.aftercareClaimFiled);
    expect(result.events[0]?.payload).toMatchObject({
      dispatchId,
      lineCount: 2,
      claimTotalMinor: 33000,
      objectVersion: 1,
      actor: 'u-finance-01',
    });
    const stored = await h.domainEvents.byAggregate({ id: result.claim.id, type: 'aftercare-claim' });
    expect(stored).toHaveLength(1);
  });

  it('无审批通过报工 → rejected（含未接线默认空端口 fail-closed）', async () => {
    const h = newHarness();
    const dispatchId = await seedAftermarketOrder(h.orders);
    // 端口无数据：未通过报工
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', { dispatchOrderId: dispatchId, personLines: [{ reportId: 'wr-001' }] }),
      ),
      '尚无审批通过的报工记录，无法报销',
    );

    // 默认空端口（零接线 boot，构造省略端口参数）：同样拒绝
    const orders = new InMemoryDispatchOrderStore();
    const id = await seedAftermarketOrder(orders, 'dsp-after-2');
    const service2 = new AftercareClaimService(
      orders,
      new InMemoryAftercareClaimStore(),
      new InMemoryDispatchOperationStore(),
      new InMemoryDispatchDomainEventStore(),
      undefined, // 缺省 = EMPTY_AFTERCARE_REPORT_PORT
      { now: () => FIXED_NOW },
    );
    mustBeRejected(
      await service2.execute(
        envelopeOf('aftercare.claim.save.v1', { dispatchOrderId: id, personLines: [{ reportId: 'wr-001' }] }),
      ),
      '尚无审批通过的报工记录，无法报销',
    );
  });

  it('重复新增 → 「该派工单已存在报销记录，请直接编辑」（文档原文语义）', async () => {
    const h = newHarness();
    const dispatchId = await seedAftermarketOrder(h.orders);
    h.reports.seed(dispatchId, standardApproved());
    await committed(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: standardApproved().map(({ reportId }) => ({ reportId })),
        }),
      ),
    );
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: standardApproved().map(({ reportId }) => ({ reportId })),
        }),
      ),
      '已存在报销记录，请直接编辑',
    );
  });

  it('非售后派工单 / 派工单不存在 / 跨租户 → rejected', async () => {
    const h = newHarness();
    await seedAftermarketOrder(h.orders, 'dsp-part-1', 'part');
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', { dispatchOrderId: 'dsp-part-1', personLines: [{ reportId: 'wr-001' }] }),
      ),
      '不是售后派工单',
    );
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', { dispatchOrderId: 'dsp-none', personLines: [{ reportId: 'wr-001' }] }),
      ),
      '不存在派工单',
    );

    const h2 = newHarness();
    const otherTenant = await seedAftermarketOrder(h2.orders, 'dsp-after-t2');
    h2.reports.seed(otherTenant, standardApproved());
    await committed(
      await h2.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: otherTenant,
          personLines: standardApproved().map(({ reportId }) => ({ reportId })),
        }),
      ),
    );
    // 跨租户读：对其他租户表现为不存在
    mustBeRejected(
      await h2.service.execute(
        envelopeOf(
          'aftercare.claim.save.v1',
          { dispatchOrderId: otherTenant, personLines: [{ reportId: 'wr-001' }] },
          'initial',
          TenantId.create('t-other'),
        ),
      ),
      '不存在派工单',
    );
  });

  it('明细须与通过报工一致：缺行/未知行 → rejected', async () => {
    const h = newHarness();
    const dispatchId = await seedAftermarketOrder(h.orders);
    h.reports.seed(dispatchId, standardApproved());
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: [{ reportId: 'wr-001' }], // 缺 wr-002
        }),
      ),
      '缺行',
    );
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: [
            { reportId: 'wr-001' },
            { reportId: 'wr-002' },
            { reportId: 'wr-forged' }, // 伪造行
          ],
        }),
      ),
      '未知行',
    );
  });

  it('幂等：operationId 重复 → rejected（重试已成功命令同样被拒）；expectedRevision 非 initial → rejected', async () => {
    const h = newHarness();
    const dispatchId = await seedAftermarketOrder(h.orders);
    h.reports.seed(dispatchId, standardApproved());
    const envelope = envelopeOf('aftercare.claim.save.v1', {
      dispatchOrderId: dispatchId,
      personLines: standardApproved().map(({ reportId }) => ({ reportId })),
    });
    await committed(await h.service.execute(envelope));
    // 同命令重试：先被一单一报销守卫拒绝（重试窗口双重闭合——幂等账本 +
    // (tenant, dispatchId) 唯一，任一先命中均为 rejected）
    mustBeRejected(await h.service.execute(envelope), '已存在报销记录');

    // 纯幂等路径：同一 operationId 打到另一张合格派工单——记账先于落库，拒绝
    const otherId = await seedAftermarketOrder(h.orders, 'dsp-after-other');
    h.reports.seed(otherId, standardApproved());
    const recycled = makeCommandEnvelope({
      tenantId: t1,
      issuedBy: finance,
      operationId: envelope.operationId,
      expectedRevision: 'initial' as const,
      issuedAt: FIXED_NOW,
      command: {
        kind: 'aftercare.claim.save.v1' as const,
        payload: {
          dispatchOrderId: otherId,
          personLines: standardApproved().map(({ reportId }) => ({ reportId })),
        },
      },
    });
    mustBeRejected(await h.service.execute(recycled), '操作幂等冲突');

    mustBeRejected(
      await h.service.execute(
        envelopeOf(
          'aftercare.claim.save.v1',
          { dispatchOrderId: dispatchId, personLines: [{ reportId: 'wr-001' }] },
          1, // 创建命令必须 initial
        ),
      ),
      "expectedRevision 须为 'initial'",
    );
  });
});

// ---- 编辑（aftercare.claim.update） ----

describe('aftercare.claim.update：只改四费/备注 + 行身份冻结 + 乐观锁', () => {
  async function seeded(): Promise<{
    h: ReturnType<typeof newHarness>;
    dispatchId: string;
    claimId: string;
  }> {
    const h = newHarness();
    const dispatchId = await seedAftermarketOrder(h.orders);
    h.reports.seed(dispatchId, standardApproved());
    const saved = await committed(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: [
            { reportId: 'wr-001', lodgingMinor: 20000 },
            { reportId: 'wr-002' },
          ],
        }),
      ),
    );
    return { h, dispatchId, claimId: saved.claim.id };
  }

  it('费用重写 + 版本 +1 + updated 事件（含修订前合计）', async () => {
    const { h, dispatchId } = await seeded();
    const updated = await committed(
      await h.service.execute(
        envelopeOf(
          'aftercare.claim.update.v1',
          {
            personLines: [
              { reportId: 'wr-001', lodgingMinor: 15000, trafficMinor: 3000, remark: '下调食宿' },
              { reportId: 'wr-002', otherMinor: 1200 },
            ],
          },
          1, // 报销单当前 objectVersion
        ),
        dispatchId,
      ),
    );
    expect(updated.newRevision).toBe(2);
    expect(updated.claim.totalMinor).toBe(19200); // 15000+3000+1200
    expect(updated.claim.lines[0]).toMatchObject({
      reportId: 'wr-001',
      lodgingMinor: 15000,
      trafficMinor: 3000,
      remark: '下调食宿',
      totalMinor: 18000,
    });
    // 身份快照不被改写（报工日期/售后人/审批工时只读）
    expect(updated.claim.lines[0]).toMatchObject({
      reportDate: '2026-10-20T08:00:00.000Z',
      worker: 'u-worker-01',
      approvedMinutes: 480,
    });
    expect(updated.events[0]?.eventType).toBe(AFTERCARE_CLAIM_EVENT_TYPES.aftercareClaimUpdated);
    expect(updated.events[0]?.payload).toMatchObject({
      claimTotalMinor: 19200,
      previousClaimTotalMinor: 20000,
      objectVersion: 2,
    });
  });

  it('乐观锁：expectedRevision 与当前版本不符 → rejected；派工单存在但无报销 → rejected', async () => {
    const { h, dispatchId } = await seeded();
    mustBeRejected(
      await h.service.execute(
        envelopeOf(
          'aftercare.claim.update.v1',
          { personLines: [{ reportId: 'wr-001' }, { reportId: 'wr-002' }] },
          9,
        ),
        dispatchId,
      ),
      '乐观锁冲突',
    );
    // 派工单存在（售后）但尚无报销 → 无法编辑
    const bareId = await seedAftermarketOrder(h.orders, 'dsp-after-bare');
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.update.v1', { personLines: [{ reportId: 'wr-001' }] }, 1),
        bareId,
      ),
      '尚无报销记录，无法编辑',
    );
  });

  it('行集须与既有报销行一一对应：缺行/未知行 → rejected；幂等记账生效', async () => {
    const { h, dispatchId } = await seeded();
    mustBeRejected(
      await h.service.execute(
        envelopeOf('aftercare.claim.update.v1', { personLines: [{ reportId: 'wr-001' }] }, 1),
        dispatchId,
      ),
      '缺行',
    );
    mustBeRejected(
      await h.service.execute(
        envelopeOf(
          'aftercare.claim.update.v1',
          { personLines: [{ reportId: 'wr-001' }, { reportId: 'wr-new' }] },
          1,
        ),
        dispatchId,
      ),
      '未知行',
    );
    // 幂等：同一 operationId 成功后重放被拒（版本已推进 → 乐观锁先行拒绝）
    const envelope = envelopeOf(
      'aftercare.claim.update.v1',
      { personLines: [{ reportId: 'wr-001' }, { reportId: 'wr-002' }] },
      1,
    );
    await committed(await h.service.execute(envelope, dispatchId));
    mustBeRejected(await h.service.execute(envelope, dispatchId), '乐观锁冲突');

    // 纯幂等路径：同一 operationId 打到另一张已有报销的派工单（版本恰好匹配）
    // ——记账先于费用重写，拒绝
    const otherId = await seedAftermarketOrder(h.orders, 'dsp-after-other');
    h.reports.seed(otherId, standardApproved());
    await committed(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: otherId,
          personLines: [{ reportId: 'wr-001' }, { reportId: 'wr-002' }],
        }),
      ),
    );
    const recycled = makeCommandEnvelope({
      tenantId: t1,
      issuedBy: finance,
      operationId: envelope.operationId,
      expectedRevision: 1,
      issuedAt: FIXED_NOW,
      command: {
        kind: 'aftercare.claim.update.v1' as const,
        payload: { personLines: [{ reportId: 'wr-001' }, { reportId: 'wr-002' }] },
      },
    });
    mustBeRejected(await h.service.execute(recycled, otherId), '操作幂等冲突');
  });
});

// ---- 输入解析（文档 §2.4.3 规则） ----

describe('报销输入解析：四费非必填默认 0、有值须 ≥0、上界', () => {
  it('未填默认 0；0 值合法（区别于单价的 >0 语义）；负数/非整数/超上界 → DispatchInputError', () => {
    const parsed = parseAftercareClaimSavePayload({
      dispatchOrderId: 'dsp-after-1',
      personLines: [{ reportId: 'wr-001', lodgingMinor: 0 }, { reportId: 'wr-002' }],
    });
    expect(parsed.personLines[0]?.lodgingMinor).toBe(0);
    expect(parsed.personLines[1]).toMatchObject({
      lodgingMinor: 0,
      trafficMinor: 0,
      overtimeMinor: 0,
      otherMinor: 0,
    });

    expect(() =>
      parseAftercareClaimSavePayload({
        dispatchOrderId: 'dsp-after-1',
        personLines: [{ reportId: 'wr-001', lodgingMinor: -1 }],
      }),
    ).toThrow(DispatchInputError);
    expect(() =>
      parseAftercareClaimSavePayload({
        dispatchOrderId: 'dsp-after-1',
        personLines: [{ reportId: 'wr-001', lodgingMinor: 12.5 }],
      }),
    ).toThrow(DispatchInputError);
    expect(() =>
      parseAftercareClaimSavePayload({
        dispatchOrderId: 'dsp-after-1',
        personLines: [{ reportId: 'wr-001', lodgingMinor: 2_000_000_001 }],
      }),
    ).toThrow(DispatchInputError);
    // 合计上界（分）：两行各 1.1e9 → 2.2e9 超 2e9
    expect(() =>
      parseAftercareClaimSavePayload({
        dispatchOrderId: 'dsp-after-1',
        personLines: [
          { reportId: 'wr-001', lodgingMinor: 1_100_000_000 },
          { reportId: 'wr-002', lodgingMinor: 1_100_000_000 },
        ],
      }),
    ).toThrow(DispatchInputError);
  });

  it('明细键 = reportId：重复 → DispatchInputError；personLines 必填非空', () => {
    expect(() =>
      parseAftercareClaimSavePayload({
        dispatchOrderId: 'dsp-after-1',
        personLines: [{ reportId: 'wr-001' }, { reportId: 'wr-001' }],
      }),
    ).toThrow(DispatchInputError);
    expect(() =>
      parseAftercareClaimSavePayload({ dispatchOrderId: 'dsp-after-1', personLines: [] }),
    ).toThrow(DispatchInputError);
    expect(() =>
      parseAftercareClaimUpdatePayload({ personLines: undefined }),
    ).toThrow(DispatchInputError);
  });
});

// ---- 查询面（文档 §3.4 #1/#2 口径） ----

describe('查询面：by-dispatch data=null 口径 / context 判定事实', () => {
  it('claimByDispatch：无报销/派工单不存在 → null（不抛「数据不存在」）', async () => {
    const h = newHarness();
    expect(await h.service.claimByDispatch(t1, 'dsp-none')).toBeNull();
    const dispatchId = await seedAftermarketOrder(h.orders);
    expect(await h.service.claimByDispatch(t1, dispatchId)).toBeNull();
    h.reports.seed(dispatchId, standardApproved());
    await committed(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: standardApproved().map(({ reportId }) => ({ reportId, otherMinor: 100 })),
        }),
      ),
    );
    const claim = await h.service.claimByDispatch(t1, dispatchId);
    expect(claim?.totalMinor).toBe(200);
    expect(await h.service.claimByDispatch(t2, dispatchId)).toBeNull(); // 跨租户不可见
  });

  it('claimContext：派工单不存在 → NotFoundError；给可报销行 + reimbursable 判定', async () => {
    const h = newHarness();
    await expect(h.service.claimContext(t1, 'dsp-none')).rejects.toThrow('派工单不存在');

    const dispatchId = await seedAftermarketOrder(h.orders);
    const before = await h.service.claimContext(t1, dispatchId);
    expect(before.reimbursable).toBe(false);
    expect(before.blockedReason).toContain('尚无审批通过的报工记录');
    expect(before.claim).toBeNull();

    h.reports.seed(dispatchId, standardApproved());
    const ready = await h.service.claimContext(t1, dispatchId);
    expect(ready.reimbursable).toBe(true);
    expect(ready.blockedReason).toBeNull();
    expect(ready.claimableLines.map((line) => line.reportId)).toEqual(['wr-001', 'wr-002']);
    expect(ready.order).toMatchObject({ id: dispatchId, kind: 'aftermarket', state: 'draft' });

    await committed(
      await h.service.execute(
        envelopeOf('aftercare.claim.save.v1', {
          dispatchOrderId: dispatchId,
          personLines: standardApproved().map(({ reportId }) => ({ reportId })),
        }),
      ),
    );
    const after = await h.service.claimContext(t1, dispatchId);
    expect(after.reimbursable).toBe(false);
    expect(after.blockedReason).toContain('已存在报销记录，请直接编辑');
    expect(after.claim?.id).toBeTruthy();
  });
});

// ---- 模块装配与权限码 ----

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + providers 可解析）', () => {
    const module = AftercareClaimModule.register();
    expect(module.controllers).toEqual([AftercareClaimController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AftercareClaimModule)).toBeUndefined();
  });

  it('权限码：4 路由逐点声明（aftercare:read / aftercare:claim）', () => {
    const expected: readonly [object, string, string][] = [
      [AftercareClaimController.prototype, 'byDispatch', 'aftercare:read'],
      [AftercareClaimController.prototype, 'context', 'aftercare:read'],
      [AftercareClaimController.prototype, 'save', 'aftercare:claim'],
      [AftercareClaimController.prototype, 'update', 'aftercare:claim'],
    ];
    for (const [target, method, code] of expected) {
      const actual = Reflect.getMetadata(
        PERMISSION_METADATA_KEY,
        (target as unknown as Record<string, object>)[method] as object,
      );
      expect(actual, `${String(method)} 权限码`).toBe(code);
    }
  });

  it('共享存储实例可注入（orderStore/operationStore/domainEventStore 与 dispatch 模块同批）', () => {
    const orders = new InMemoryDispatchOrderStore();
    const module = AftercareClaimModule.register({ orderStore: orders });
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(parseIdParam(' dsp-after-1 ')).toBe('dsp-after-1'); // 既有解析面可复用
  });
});
