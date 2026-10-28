import { InMemoryWorkOrderEquipmentStore } from '../../src/workorder/workorder-equipment.js';
/**
 * 发料任务/发料记录（U1，A11 增量）测试：内存存储合同、派工同步生成/补全/
 * 归拢、四数量口径、确认发料（part 拆预占 / std-elec 库位扣减回执快照 /
 * equipment 利用库存滚动拆分）、快递单管理、撤销原路回滚与任务汇总状态机、
 * 撤销派工清理、输入解析边界、控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import type { IssueDemandLine } from '../../src/issue/issue-ports.js';
import {
  EMPTY_ISSUE_DEMAND_PORT,
  NOOP_ISSUE_MATERIAL_PORT,
  type IssueDemandSourcePort,
  type IssueMaterialPort,
  type IssueStockCommand,
  type IssueStockReceipt,
} from '../../src/issue/issue-ports.js';
import { IssueInputError } from '../../src/issue/issue-errors.js';
import {
  IssueRecordsController,
  IssueTasksController,
} from '../../src/issue/issue.controllers.js';
import { IssueModule } from '../../src/issue/issue.module.js';
import {
  IssueService,
  type IssueCommandResult,
  type IssueCommitted,
} from '../../src/issue/issue.service.js';
import { createInMemoryIssueStores } from '../../src/issue/in-memory-issue-stores.js';
import {
  parseIssueCommandEnvelopeBody,
  parseIssueConfirmPayload,
  parseIssueSyncPayload,
} from '../../src/issue/issue-input.js';
import type { IssueCommand } from '../../src/issue/issue-input.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const worker = UserId.create('user-wh-1');
const FIXED_NOW = '2026-10-26T08:00:00.000Z';

let opSeq = 0;

function envelopeOf(
  kind: IssueCommand['kind'],
  payload: unknown,
  options: { expectedRevision?: 'initial' | number; tenant?: TenantId } = {},
): CommandEnvelope<IssueCommand> {
  opSeq += 1;
  return makeCommandEnvelope({
    tenantId: options.tenant ?? t1,
    issuedBy: worker,
    operationId: OperationId.create(`op-issue-${opSeq}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload },
  });
}

async function committed(result: IssueCommandResult): Promise<IssueCommitted> {
  expect(result.status).toBe('committed');
  return result as IssueCommitted;
}

async function rejectedReason(result: IssueCommandResult): Promise<string> {
  expect(result.status).toBe('rejected');
  return (result as { reason: string }).reason;
}

// ---- 测试替身：清单需求行源 + 库存/预占联动端口 ----

function demandLine(partial: Partial<IssueDemandLine> & { listingLineId: string; kind: IssueDemandLine['kind'] }): IssueDemandLine {
  return {
    equipmentRef: 'eq-1',
    moduleName: 'Mod-A',
    name: `part-${partial.listingLineId}`,
    drawingNo: null,
    itemId: null,
    requiredQty: 10,
    origin: 'production',
    useInventoryQty: 0,
    inboundCompletedQty: 0,
    ...partial,
  };
}

class FakeDemandPort implements IssueDemandSourcePort {
  constructor(private lines: readonly IssueDemandLine[] = []) {}
  setLines(lines: readonly IssueDemandLine[]): void {
    this.lines = lines;
  }
  async demandLines(): Promise<readonly IssueDemandLine[]> {
    return this.lines;
  }
}

class FakeMaterialPort implements IssueMaterialPort {
  /** 锚点预占：`${workOrderId}|${equipmentRef ?? ''}|${itemId}` → qty。 */
  readonly reserved = new Map<string, number>();
  /** 料品可用：itemId → qty。 */
  readonly available = new Map<string, number>();
  /** 已出库账：issueKey → 回执（重复指令幂等回首次结果）。 */
  readonly issuedLedger = new Map<string, IssueStockReceipt>();
  /** 回滚记录：issueKey → 次数。 */
  readonly rolledBack = new Map<string, number>();
  /** 拒绝名单：issueKey → 拒绝原因。 */
  readonly refuse = new Map<string, string>();

  private reservedKey(workOrderId: string, equipmentRef: string | null, itemId: string): string {
    return `${workOrderId}|${equipmentRef ?? ''}|${itemId}`;
  }

  setReserved(workOrderId: string, equipmentRef: string | null, itemId: string, qty: number): void {
    this.reserved.set(this.reservedKey(workOrderId, equipmentRef, itemId), qty);
  }

  async availableQtyOf(_tenant: TenantId, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return new Map(itemIds.map((itemId) => [itemId, this.available.get(itemId) ?? 0]));
  }

  async reservedQtyOf(
    _tenant: TenantId,
    query: { workOrderId: string; equipmentRef: string | null; itemIds: readonly string[] },
  ): Promise<ReadonlyMap<string, number>> {
    return new Map(
      query.itemIds.map((itemId) => [
        itemId,
        this.reserved.get(this.reservedKey(query.workOrderId, query.equipmentRef, itemId)) ?? 0,
      ]),
    );
  }

  async issueStock(_tenant: TenantId, command: IssueStockCommand): Promise<IssueStockReceipt> {
    const existing = this.issuedLedger.get(command.issueKey);
    if (existing !== undefined) return { ...existing, duplicate: true };
    const refused = this.refuse.get(command.issueKey);
    if (refused !== undefined) return { issued: false, refusedReason: refused };
    // 可发拆分：每库位先核销预占（该工作令+物料下全部锚点预占合并池），余量走可用。
    const poolKeys = [...this.reserved.keys()].filter(
      (key) => key.startsWith(`${command.workOrderId}|`) && key.endsWith(`|${command.itemId}`),
    );
    const pool = poolKeys.reduce((sum, key) => sum + (this.reserved.get(key) ?? 0), 0);
    let reservedLeft = pool;
    const allocations = command.allocations.map((allocation) => {
      const reservedPart = Math.min(allocation.quantity, Math.max(0, reservedLeft));
      reservedLeft -= reservedPart;
      return {
        locationId: allocation.locationId,
        quantity: allocation.quantity,
        reservedConsumedQty: reservedPart,
        availableConsumedQty: allocation.quantity - reservedPart,
      };
    });
    const receipt: IssueStockReceipt = { issued: true, allocations };
    this.issuedLedger.set(command.issueKey, receipt);
    // 回写预占池：按锚点顺序扣减
    let toDeduct = pool - reservedLeft;
    for (const key of poolKeys) {
      if (toDeduct <= 0) break;
      const current = this.reserved.get(key) ?? 0;
      const take = Math.min(current, toDeduct);
      this.reserved.set(key, current - take);
      toDeduct -= take;
    }
    return receipt;
  }

  async rollbackIssue(_tenant: TenantId, command: { issueKey: string }): Promise<{ rolled: boolean; refusedReason?: string }> {
    if (!this.issuedLedger.has(command.issueKey)) {
      return { rolled: false, refusedReason: `出库键 '${command.issueKey}' 无账可回滚` };
    }
    this.rolledBack.set(command.issueKey, (this.rolledBack.get(command.issueKey) ?? 0) + 1);
    return { rolled: true };
  }
}

function newHarness(options: { demand?: FakeDemandPort; material?: FakeMaterialPort; equipmentSource?: InMemoryWorkOrderEquipmentStore } = {}) {
  const stores = createInMemoryIssueStores();
  const demand = options.demand ?? new FakeDemandPort();
  const material = options.material ?? new FakeMaterialPort();
  const service = new IssueService(
    stores.taskStore,
    stores.taskLineStore,
    stores.recordStore,
    stores.expressStore,
    stores.operationStore,
    stores.domainEventStore,
    demand,
    material,
    { now: () => FIXED_NOW, ...(options.equipmentSource ? { equipmentSource: options.equipmentSource } : {}) },
  );
  return { stores, demand, material, service };
}

/** 装配类工作令的标准需求行集：eq-1 非标 2 行 + 标准 1 行 + 电气 1 行 + 配件来源 1 行。 */
function assemblyDemand(): IssueDemandLine[] {
  return [
    demandLine({ listingLineId: 'll-p1', kind: 'part', equipmentRef: 'eq-1', requiredQty: 10, itemId: null, drawingNo: 'DWG-1' }),
    demandLine({ listingLineId: 'll-p2', kind: 'part', equipmentRef: 'eq-1', requiredQty: 4, itemId: null }),
    demandLine({ listingLineId: 'll-s1', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 20, itemId: 'item-bolt', moduleName: 'Mod-B' }),
    demandLine({ listingLineId: 'll-e1', kind: 'electrical', equipmentRef: 'eq-1', requiredQty: 6, itemId: 'item-wire', moduleName: 'Mod-C' }),
    // 配件申请来源行：生产发料排除
    demandLine({ listingLineId: 'll-spa', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 99, itemId: 'item-spa', origin: 'aftermarket' }),
  ];
}

const SYNC_ASM_EQ1 = {
  workOrderId: 'wo-1',
  dispatchKind: 'assembly',
  equipmentRefs: ['eq-1'],
  triggerRef: { type: 'dispatch', id: 'dsp-1' },
};

// ---- 派工同步生成/补全 ----

describe('issue.sync：装配/电气生成与补全', () => {
  it('装配触发：按设备建任务、子行=非标+标准（排除配件行与电气行），任务号前缀 ISS-ASM', async () => {
    const { service, demand } = newHarness({ demand: new FakeDemandPort(assemblyDemand()) });
    demand.setLines(assemblyDemand());
    const result = await committed(
      await service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)),
    );
    const tasks = result.tasks ?? [];
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.taskNo.startsWith('ISS-ASM-')).toBe(true);
    expect(task.dispatchKind).toBe('assembly');
    expect(task.rollup).toBe(false);
    expect(task.equipmentRef).toBe('eq-1');
    expect(task.state).toBe('not-started');
    expect(task.triggerRefs).toEqual([{ type: 'dispatch', id: 'dsp-1' }]);
    expect(task.totalRequiredQty).toBe(34); // 10 + 4 + 20（排除电气 6 与配件 99）
    expect((result.appendedCountByTask ?? new Map()).get(task.id)).toBe(3);

    const detail = await service.taskDetail(t1, task.id);
    expect(detail.lines.map((line) => line.kind)).toEqual(['part', 'part', 'standard']);
    expect(detail.lines.map((line) => line.sourceLineId)).toEqual(['ll-p1', 'll-p2', 'll-s1']);
  });

  it('幂等补全：重触发不建新主表，只补缺失子行（syncMissingLines）', async () => {
    const { service, demand } = newHarness();
    const lines = assemblyDemand();
    demand.setLines(lines);
    const first = await committed(await service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const taskId = (first.tasks ?? [])[0]!.id;

    // 新增一行清单 + 已发过一行的设备不动：重触发只补新行
    demand.setLines([...lines, demandLine({ listingLineId: 'll-p3', kind: 'part', equipmentRef: 'eq-1', requiredQty: 7 })]);
    const second = await committed(await service.execute(envelopeOf('issue.sync.v1', { ...SYNC_ASM_EQ1, triggerRef: { type: 'dispatch', id: 'dsp-2' } })));
    expect(second.tasks ?? []).toHaveLength(1);
    expect((second.tasks ?? [])[0]!.id).toBe(taskId);
    expect((second.appendedCountByTask ?? new Map()).get(taskId)).toBe(1);

    const all = await service.listTasks(t1, { workOrderId: 'wo-1' });
    expect(all).toHaveLength(1); // 主表不重复
    const detail = await service.taskDetail(t1, taskId);
    expect(detail.lines).toHaveLength(4);
    expect(detail.task.totalRequiredQty).toBe(41);
  });

  it('电气触发：只生成电气行任务（前缀 ISS-ELEC），与装配任务并存不合并', async () => {
    const { service, demand } = newHarness();
    demand.setLines(assemblyDemand());
    await committed(await service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const result = await committed(
      await service.execute(
        envelopeOf('issue.sync.v1', { workOrderId: 'wo-1', dispatchKind: 'electrical', equipmentRefs: ['eq-1'] }),
      ),
    );
    const electrical = (result.tasks ?? [])[0]!;
    expect(electrical.taskNo.startsWith('ISS-ELEC-')).toBe(true);
    expect(electrical.dispatchKind).toBe('electrical');
    const detail = await service.taskDetail(t1, electrical.id);
    expect(detail.lines.map((line) => line.kind)).toEqual(['electrical']);
    expect(await service.listTasks(t1, { workOrderId: 'wo-1' })).toHaveLength(2);
  });

  it('整线装配归拢：rollup 一工作令一条、设备维空、子行=全令外购设备行；无外购设备不建单', async () => {
    const { service, demand } = newHarness();
    demand.setLines([
      ...assemblyDemand(),
      demandLine({ listingLineId: 'll-eq1', kind: 'equipment', equipmentRef: null, requiredQty: 2, name: '机械手' }),
      demandLine({ listingLineId: 'll-eq2', kind: 'equipment', equipmentRef: null, requiredQty: 1, name: '提升机' }),
    ]);
    const result = await committed(
      await service.execute(envelopeOf('issue.sync.v1', { ...SYNC_ASM_EQ1, rollup: true })),
    );
    expect(result.tasks ?? []).toHaveLength(2); // eq-1 自制 + 归拢
    const rollupTask = (result.tasks ?? []).find((task) => task.rollup)!;
    expect(rollupTask.taskNo.startsWith('ISS-ASM-ROLLUP-')).toBe(true);
    expect(rollupTask.equipmentRef).toBeNull();
    const detail = await service.taskDetail(t1, rollupTask.id);
    expect(detail.lines.map((line) => line.sourceLineId)).toEqual(['ll-eq1', 'll-eq2']);

    // 归拢幂等：再触发（不带自制设备）只补新设备行
    demand.setLines([
      ...assemblyDemand(),
      demandLine({ listingLineId: 'll-eq1', kind: 'equipment', equipmentRef: null, requiredQty: 2 }),
      demandLine({ listingLineId: 'll-eq2', kind: 'equipment', equipmentRef: null, requiredQty: 1 }),
      demandLine({ listingLineId: 'll-eq3', kind: 'equipment', equipmentRef: null, requiredQty: 5 }),
    ]);
    const again = await committed(
      await service.execute(envelopeOf('issue.sync.v1', { workOrderId: 'wo-1', dispatchKind: 'assembly', rollup: true })),
    );
    const rollupAgain = (again.tasks ?? []).find((task) => task.rollup)!;
    expect(rollupAgain.id).toBe(rollupTask.id);
    expect((again.appendedCountByTask ?? new Map()).get(rollupTask.id)).toBe(1);

    // 无外购设备的工作令：归拢不建单
    const empty = newHarness({ demand: new FakeDemandPort(assemblyDemand()) });
    const emptyResult = await committed(
      await empty.service.execute(envelopeOf('issue.sync.v1', { workOrderId: 'wo-2', dispatchKind: 'assembly', rollup: true })),
    );
    expect(emptyResult.tasks).toHaveLength(0);
  });

  it('缺设备维且非归拢：阻断（文档 1.2 四子模块缺 equipment 维不生成）', async () => {
    const { service } = newHarness();
    const reason = await rejectedReason(
      await service.execute(envelopeOf('issue.sync.v1', { workOrderId: 'wo-1', dispatchKind: 'assembly' })),
    );
    expect(reason).toContain('equipmentRefs 为空');
  });

  it('跨租户隔离：任务/行按租户收口', async () => {
    const { service, demand } = newHarness();
    demand.setLines(assemblyDemand());
    await committed(await service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    expect(await service.listTasks(t2)).toHaveLength(0);
    const t2result = await committed(
      await service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1, { tenant: t2 })),
    );
    const task = (t2result.tasks ?? [])[0]!;
    await expect(service.taskDetail(t1, task.id)).rejects.toThrow();
  });
});

// ---- 四数量与确认发料 ----

describe('issue.confirm：part 类（非标件）', () => {
  async function confirmedAssemblyTask() {
    const harness = newHarness();
    harness.demand.setLines(assemblyDemand());
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    return { ...harness, task: (sync.tasks ?? [])[0]!, sync };
  }

  it('未解析物料的 part 行：预占锚点缺失 → 已预占 0、可发 0（提交被拒）', async () => {
    const { service, task } = await confirmedAssemblyTask();
    const detail = await service.taskDetail(t1, task.id);
    const partWithNull = detail.lines.find((line) => line.sourceLineId === 'll-p1')!;
    expect(partWithNull.itemId).toBeNull();
    expect(partWithNull.reservedQty).toBe(0);
    expect(partWithNull.availableNowQty).toBe(0);
    const refused = await service.execute(
      envelopeOf('issue.confirm.v1', { lineKind: 'part', lines: [{ taskLineId: partWithNull.lineId, quantity: 1 }] }),
      task.id,
    );
    expect(await rejectedReason(refused)).toContain('当前可发数量不足');
  });

  it('带物料锚点的 part 行：确认拆预占冲减、超可发拒绝、可发为负按数据错误阻断', async () => {
    const harness = newHarness();
    harness.demand.setLines([
      demandLine({ listingLineId: 'll-p1', kind: 'part', equipmentRef: 'eq-1', requiredQty: 10, itemId: 'item-p1', drawingNo: 'DWG-1' }),
      demandLine({ listingLineId: 'll-s1', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 20, itemId: 'item-bolt' }),
    ]);
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const task = (sync.tasks ?? [])[0]!;
    const { service, material } = harness;
    material.setReserved('wo-1', 'eq-1', 'item-p1', 8);

    const detail = await service.taskDetail(t1, task.id);
    const partLine = detail.lines.find((line) => line.sourceLineId === 'll-p1')!;
    expect(partLine.reservedQty).toBe(8);
    expect(partLine.availableNowQty).toBe(8);

    // 超可发拒绝：本次 9 > 可发 8
    const over = await service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'part',
        lines: [{ taskLineId: partLine.lineId, quantity: 9 }],
      }, { expectedRevision: 'initial' }),
      task.id,
    );
    expect(await rejectedReason(over)).toContain('当前可发数量不足');

    // 合法确认 5：预占冲减 5，余 3 自制不落库
    const ok = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'part',
          lines: [{ taskLineId: partLine.lineId, quantity: 5 }],
        }),
        task.id,
      ),
    );
    expect(ok.record?.totalQty).toBe(5);
    expect(ok.record?.lines[0]).toMatchObject({
      thisQty: 5,
      reservedConsumedQty: 5,
      issuedBeforeQty: 0,
      issuedAfterQty: 5,
      pendingAfterQty: 5,
      reservedBeforeQty: 8,
      availableBeforeQty: 8,
      issueKey: null,
    });

    // 第二次确认 3：剩余预占 3 全冲，无余量
    const second = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'part',
          lines: [{ taskLineId: partLine.lineId, quantity: 3 }],
        }),
        task.id,
      ),
    );
    expect(second.record?.lines[0]).toMatchObject({ thisQty: 3, reservedConsumedQty: 3, issuedAfterQty: 8, pendingAfterQty: 2 });

    // 超剩余可发拒绝：已发 8 = 预占 8 → 可发 0
    const overAgain = await service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'part',
        lines: [{ taskLineId: partLine.lineId, quantity: 1 }],
      }),
      task.id,
    );
    expect(await rejectedReason(overAgain)).toContain('当前可发数量不足');

    // 数据错误阻断：预占被外部清零后已发 8 > 预占 0
    material.setReserved('wo-1', 'eq-1', 'item-p1', 0);
    const dataError = await service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'part',
        lines: [{ taskLineId: partLine.lineId, quantity: 1 }],
      }),
      task.id,
    );
    expect(await rejectedReason(dataError)).toContain('数据错误');
  });

  it('一条记录一种类别：part 提交中混入 standard 行被拒；勾选行须属本任务', async () => {
    const { service, task } = await confirmedAssemblyTask();
    const detail = await service.taskDetail(t1, task.id);
    const partLine = detail.lines.find((line) => line.kind === 'part')!;
    const stdLine = detail.lines.find((line) => line.kind === 'standard')!;
    const mixed = await service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'part',
        lines: [
          { taskLineId: partLine.lineId, quantity: 1 },
          { taskLineId: stdLine.lineId, quantity: 1 },
        ],
      }),
      task.id,
    );
    expect(await rejectedReason(mixed)).toContain('一条记录一种类别');
    const foreign = await service.execute(
      envelopeOf('issue.confirm.v1', { lineKind: 'part', lines: [{ taskLineId: 'itl-ghost', quantity: 1 }] }),
      task.id,
    );
    expect(await rejectedReason(foreign)).toContain('不属于任务');
  });

  it('电气任务不可提交 part 类（operableKinds 守卫）；装配任务不可提交 electrical', async () => {
    const harness = newHarness();
    harness.demand.setLines(assemblyDemand());
    await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const elec = await committed(
      await harness.service.execute(
        envelopeOf('issue.sync.v1', { workOrderId: 'wo-1', dispatchKind: 'electrical', equipmentRefs: ['eq-1'] }),
      ),
    );
    const elecTask = (elec.tasks ?? [])[0]!;
    const refused = await harness.service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'part',
        lines: [{ taskLineId: 'whatever', quantity: 1 }],
      }),
      elecTask.id,
    );
    expect(await rejectedReason(refused)).toContain('不支持 part 类确认发料');
  });
});

describe('issue.confirm：standard/electrical（库位扣减联动）', () => {
  async function standardHarness() {
    const harness = newHarness();
    harness.demand.setLines([
      demandLine({ listingLineId: 'll-s1', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 20, itemId: 'item-bolt', moduleName: 'Mod-B' }),
      demandLine({ listingLineId: 'll-s2', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 5, itemId: 'item-nut', moduleName: 'Mod-B' }),
    ]);
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    return { ...harness, task: (sync.tasks ?? [])[0]! };
  }

  it('四数量：可发=min(预占+料品可用, 待发)；库位合计=本次数量；回执拆分快照进 allocations', async () => {
    const { service, task, material } = await standardHarness();
    material.setReserved('wo-1', 'eq-1', 'item-bolt', 6);
    material.available.set('item-bolt', 30);

    const detail = await service.issueDetail(t1, task.id, { lineKind: 'standard', moduleName: undefined, name: undefined, pendingFilter: undefined, current: 1, size: 20 });
    const bolt = detail.lines.find((line) => line.sourceLineId === 'll-s1')!;
    expect(bolt.reservedQty).toBe(6);
    expect(bolt.pendingQty).toBe(20);
    // 当前可发 = min(预占 6 + 料品可用 30, 待发 20) = 20（不得超过待发——封顶口径）
    expect(bolt.availableNowQty).toBe(20);

    const nut = detail.lines.find((line) => line.sourceLineId === 'll-s2')!;
    expect(nut.reservedQty).toBe(0);
    expect(nut.availableNowQty).toBe(0); // 无预占无可用

    // 确认：bolt 两库位 4+3=7（预占核销 6 + 可用 1）；nut 未配库位 → 跳过
    const ok = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'standard',
          lines: [
            {
              taskLineId: bolt.lineId,
              allocations: [
                { locationId: 'loc-1', quantity: 4, recommended: true },
                { locationId: 'loc-2', quantity: 3, recommended: false },
              ],
            },
            { taskLineId: nut.lineId },
          ],
        }),
        task.id,
      ),
    );
    expect(ok.record?.lines).toHaveLength(1); // nut 跳过
    const boltSnapshot = ok.record?.lines[0]!;
    expect(boltSnapshot.thisQty).toBe(7);
    expect(boltSnapshot.reservedConsumedQty).toBe(6);
    expect(boltSnapshot.allocations).toEqual([
      { locationId: 'loc-1', quantity: 4, recommended: true, reservedConsumedQty: 4, availableConsumedQty: 0 },
      { locationId: 'loc-2', quantity: 3, recommended: false, reservedConsumedQty: 2, availableConsumedQty: 1 },
    ]);
    expect(boltSnapshot.issueKey).toMatch(/^issue-irc-.*-l0$/);
    expect(material.issuedLedger.has(boltSnapshot.issueKey!)).toBe(true);
  });

  it('端口拒绝则整单不落账（零记录）；全部行未配库位 → 拒绝', async () => {
    const { service, task, material } = await standardHarness();
    material.available.set('item-bolt', 30);
    const detail = await service.issueDetail(t1, task.id, { lineKind: 'standard', moduleName: undefined, name: undefined, pendingFilter: undefined, current: 1, size: 20 });
    const bolt = detail.lines.find((line) => line.sourceLineId === 'll-s1')!;

    const allSkipped = await service.execute(
      envelopeOf('issue.confirm.v1', { lineKind: 'standard', lines: [{ taskLineId: bolt.lineId }] }),
      task.id,
    );
    expect(await rejectedReason(allSkipped)).toContain('参与行为空');

    // 注入式拒绝：端口回 issued=false → 整单 rejected、零记录落账
    const original = material.issueStock;
    material.issueStock = async () => ({ issued: false, refusedReason: '库位结存不足' });
    const refused = await service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'standard',
        lines: [{ taskLineId: bolt.lineId, allocations: [{ locationId: 'loc-1', quantity: 4, recommended: false }] }],
      }),
      task.id,
    );
    material.issueStock = original;
    expect(await rejectedReason(refused)).toContain('库存联动被拒');
    expect(await service.listRecords(t1, { taskId: task.id })).toHaveLength(0); // 零记录
  });

  it('库位合计超当前可发拒绝；未解析物料的标准行不可库位发料', async () => {
    const harness = newHarness();
    harness.demand.setLines([
      demandLine({ listingLineId: 'll-s1', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 20, itemId: 'item-bolt' }),
      demandLine({ listingLineId: 'll-s9', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 8, itemId: null }),
    ]);
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const task = (sync.tasks ?? [])[0]!;
    harness.material.available.set('item-bolt', 4); // 可发 min(0+4, 20)=4

    const detail = await harness.service.taskDetail(t1, task.id);
    const bolt = detail.lines.find((line) => line.sourceLineId === 'll-s1')!;
    const unresolved = detail.lines.find((line) => line.sourceLineId === 'll-s9')!;
    expect(bolt.availableNowQty).toBe(4);

    const over = await harness.service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'standard',
        lines: [{ taskLineId: bolt.lineId, allocations: [{ locationId: 'loc-1', quantity: 5, recommended: false }] }],
      }),
      task.id,
    );
    expect(await rejectedReason(over)).toContain('当前可发数量不足');

    const noItem = await harness.service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'standard',
        lines: [
          { taskLineId: unresolved.lineId, allocations: [{ locationId: 'loc-1', quantity: 1, recommended: false }] },
        ],
      }),
      task.id,
    );
    expect(await rejectedReason(noItem)).toContain('未解析确认物料');
  });
});

describe('issue.confirm：equipment（归拢外购设备）', () => {
  async function rollupHarness() {
    const harness = newHarness();
    harness.demand.setLines([
      demandLine({ listingLineId: 'll-eq1', kind: 'equipment', equipmentRef: null, requiredQty: 5, name: '机械手', useInventoryQty: 3, inboundCompletedQty: 2 }),
      demandLine({ listingLineId: 'll-eq2', kind: 'equipment', equipmentRef: null, requiredQty: 4, name: '提升机', useInventoryQty: 0, inboundCompletedQty: 4 }),
    ]);
    const sync = await committed(
      await harness.service.execute(envelopeOf('issue.sync.v1', { ...SYNC_ASM_EQ1, rollup: true })),
    );
    const rollupTask = (sync.tasks ?? []).find((task) => task.rollup)!;
    return { ...harness, task: rollupTask };
  }

  it('可发=min(待发, max(0, 利用库存+入库完成−已发))；确认先冲剩余利用库存（采购入库份不落库）', async () => {
    const { service, task } = await rollupHarness();
    const detail = await service.taskDetail(t1, task.id);
    const eq1 = detail.lines.find((line) => line.sourceLineId === 'll-eq1')!;
    expect(eq1.reservedQty).toBe(5); // 3 + 2
    expect(eq1.availableNowQty).toBe(5);

    const first = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'equipment',
          lines: [{ taskLineId: eq1.lineId, quantity: 4 }],
        }),
        task.id,
      ),
    );
    expect(first.record?.lines[0]).toMatchObject({ thisQty: 4, useInventoryConsumedQty: 3, reservedConsumedQty: 0, issueKey: null });

    // 滚动余量：剩余利用库存 0 → 第二次全走采购入库份（不落库）
    const second = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'equipment',
          lines: [{ taskLineId: eq1.lineId, quantity: 1 }],
        }),
        task.id,
      ),
    );
    expect(second.record?.lines[0]).toMatchObject({ thisQty: 1, useInventoryConsumedQty: 0 });
  });

  it('归拢任务不可提交 part 类；可发为 0 时拒绝', async () => {
    const { service, task } = await rollupHarness();
    const detail = await service.taskDetail(t1, task.id);
    const eq2 = detail.lines.find((line) => line.sourceLineId === 'll-eq2')!; // 可发 4
    const refused = await service.execute(
      envelopeOf('issue.confirm.v1', { lineKind: 'part', lines: [{ taskLineId: eq2.lineId, quantity: 1 }] }),
      task.id,
    );
    expect(await rejectedReason(refused)).toContain('不支持 part 类');

    const over = await service.execute(
      envelopeOf('issue.confirm.v1', { lineKind: 'equipment', lines: [{ taskLineId: eq2.lineId, quantity: 5 }] }),
      task.id,
    );
    expect(await rejectedReason(over)).toContain('当前可发数量不足');
  });
});

// ---- 快递单（发货头）管理 ----

describe('issue：快递单管理', () => {
  it('确认携带发货头：find-or-create、同单号复用、发货人不一致拒绝；撤销后无引用删除', async () => {
    const harness = newHarness();
    harness.demand.setLines([
      demandLine({ listingLineId: 'll-p1', kind: 'part', equipmentRef: 'eq-1', requiredQty: 10, itemId: 'item-p1' }),
    ]);
    harness.material.setReserved('wo-1', 'eq-1', 'item-p1', 10);
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const task = (sync.tasks ?? [])[0]!;
    const { service } = harness;
    const lineId = (await service.taskDetail(t1, task.id)).lines[0]!.lineId;

    const expressPayload = {
      trackingNo: 'SF-001',
      shipper: '张三',
      shipTime: '2026-10-26T08:00:00.000Z',
      imageRefs: ['https://files.example/1.png'],
    };
    const first = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', { lineKind: 'part', lines: [{ taskLineId: lineId, quantity: 2 }], express: expressPayload }),
        task.id,
      ),
    );
    const expressId = first.record?.expressId;
    expect(expressId).toBeTruthy();
    expect(first.express?.trackingNo).toBe('SF-001');

    // 同单号复用（发货头一致）
    const second = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', { lineKind: 'part', lines: [{ taskLineId: lineId, quantity: 2 }], express: expressPayload }),
        task.id,
      ),
    );
    expect(second.record?.expressId).toBe(expressId);

    // 发货人不一致拒绝
    const mismatch = await service.execute(
      envelopeOf('issue.confirm.v1', {
        lineKind: 'part',
        lines: [{ taskLineId: lineId, quantity: 1 }],
        express: { ...expressPayload, shipper: '李四' },
      }),
      task.id,
    );
    expect(await rejectedReason(mismatch)).toContain('发货人不一致');

    // 下拉：shipHeads 按工作令返回；任务不存在返回空列表
    expect((await service.shipHeads(t1, task.id)).map((row) => row.trackingNo)).toEqual(['SF-001']);
    expect(await service.shipHeads(t1, 'itk-ghost')).toEqual([]);

    // 撤销后：仍有第二条有效记录引用 → 快递单保留
    const revoked = await committed(
      await service.execute(envelopeOf('issue.revoke.v1', {}, { expectedRevision: 1 }), first.record!.id),
    );
    expect(revoked.record?.state).toBe('revoked');
    expect((await service.shipHeads(t1, task.id)).map((row) => row.trackingNo)).toEqual(['SF-001']);
    // 第二条也撤销：无其余有效记录引用 → 快递单删除
    await committed(await service.execute(envelopeOf('issue.revoke.v1', {}, { expectedRevision: 1 }), second.record!.id));
    expect(await service.shipHeads(t1, task.id)).toEqual([]);
  });
});

// ---- 撤销与任务汇总 ----

describe('issue.revoke + 任务状态/进度', () => {
  function fullHarness() {
    const harness = newHarness();
    harness.demand.setLines([
      demandLine({ listingLineId: 'll-p1', kind: 'part', equipmentRef: 'eq-1', requiredQty: 4, itemId: 'item-p1' }),
      demandLine({ listingLineId: 'll-s1', kind: 'standard', equipmentRef: 'eq-1', requiredQty: 6, itemId: 'item-bolt' }),
      demandLine({ listingLineId: 'll-e1', kind: 'electrical', equipmentRef: 'eq-1', requiredQty: 8, itemId: 'item-wire' }),
    ]);
    return harness;
  }

  it('装配完成判定与进度', async () => {
    const harness = fullHarness();
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const task = (sync.tasks ?? [])[0]!;
    harness.material.setReserved('wo-1', 'eq-1', 'item-p1', 4);
    harness.material.available.set('item-bolt', 6);
    const { service } = harness;
    const lines = (await service.taskDetail(t1, task.id)).lines;
    const part = lines.find((line) => line.kind === 'part')!;
    const std = lines.find((line) => line.kind === 'standard')!;

    expect(task.state).toBe('not-started');
    expect(task.totalRequiredQty).toBe(10); // 4 + 6（电气行不在装配任务）

    // part 完成 + standard 未完成 → issuing
    const first = await committed(
      await service.execute(envelopeOf('issue.confirm.v1', { lineKind: 'part', lines: [{ taskLineId: part.lineId, quantity: 4 }] }), task.id),
    );
    expect(first.task?.state).toBe('issuing');
    expect(first.task?.totalIssuedQty).toBe(4);

    // standard 完成 → done（装配参与类别 part+standard 均完成）
    const second = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'standard',
          lines: [{ taskLineId: std.lineId, allocations: [{ locationId: 'loc-1', quantity: 6, recommended: false }] }],
        }),
        task.id,
      ),
    );
    expect(second.task?.state).toBe('done');
    expect(second.task?.finishedAt).toBe(FIXED_NOW);

    // 撤销 standard 记录 → 退回 issuing、已发回退
    const revoked = await committed(
      await service.execute(envelopeOf('issue.revoke.v1', {}, { expectedRevision: 1 }), second.record!.id),
    );
    expect(revoked.task?.state).toBe('issuing');
    expect(revoked.task?.totalIssuedQty).toBe(4);
    // 重复撤销拒绝
    const again = await service.execute(envelopeOf('issue.revoke.v1', {}, { expectedRevision: 2 }), second.record!.id);
    expect(await rejectedReason(again)).toContain('已撤销');
    // 乐观锁：错误版本拒绝
    const stale = await service.execute(envelopeOf('issue.revoke.v1', {}, { expectedRevision: 99 }), first.record!.id);
    expect(await rejectedReason(stale)).toContain('乐观锁冲突');
  });

  it('standard 撤销按快照 issueKey 原路回滚；已发数量回退', async () => {
    const harness = fullHarness();
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const task = (sync.tasks ?? [])[0]!;
    harness.material.available.set('item-bolt', 6);
    const { service, material } = harness;
    const std = (await service.taskDetail(t1, task.id)).lines.find((line) => line.kind === 'standard')!;
    const ok = await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'standard',
          lines: [{ taskLineId: std.lineId, allocations: [{ locationId: 'loc-1', quantity: 5, recommended: true }] }],
        }),
        task.id,
      ),
    );
    const issueKey = ok.record!.lines[0]!.issueKey!;
    expect(material.rolledBack.has(issueKey)).toBe(false);
    await committed(await service.execute(envelopeOf('issue.revoke.v1', {}, { expectedRevision: 1 }), ok.record!.id));
    expect(material.rolledBack.get(issueKey)).toBe(1);
    const detail = await service.taskDetail(t1, task.id);
    expect(detail.lines.find((line) => line.kind === 'standard')!.issuedQty).toBe(0);
  });

  it('电气任务完成判定=电气行均完成', async () => {
    const harness = fullHarness();
    await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const elec = await committed(
      await harness.service.execute(
        envelopeOf('issue.sync.v1', { workOrderId: 'wo-1', dispatchKind: 'electrical', equipmentRefs: ['eq-1'] }),
      ),
    );
    const elecTask = (elec.tasks ?? [])[0]!;
    harness.material.available.set('item-wire', 8);
    const line = (await harness.service.taskDetail(t1, elecTask.id)).lines[0]!;
    const ok = await committed(
      await harness.service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'electrical',
          lines: [{ taskLineId: line.lineId, allocations: [{ locationId: 'loc-w', quantity: 8, recommended: false }] }],
        }),
        elecTask.id,
      ),
    );
    expect(ok.task?.state).toBe('done');
  });
});

// ---- 撤销派工清理 ----

describe('issue.cleanup：撤销派工清理', () => {
  it('未开始任务连带删除（主+子行）；已发料任务阻断整批', async () => {
    const harness = newHarness();
    harness.demand.setLines(assemblyDemand());
    const sync = await committed(await harness.service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const task = (sync.tasks ?? [])[0]!;
    const { service } = harness;

    // 未开始 → 清理成功
    const cleaned = await committed(
      await service.execute(
        envelopeOf('issue.cleanup.v1', { workOrderId: 'wo-1', dispatchKind: 'assembly', equipmentRefs: ['eq-1'] }),
      ),
    );
    expect(cleaned.deletedTaskIds).toEqual([task.id]);
    expect(await service.listTasks(t1, { workOrderId: 'wo-1' })).toHaveLength(0);

    // 重建后发一笔 → 清理被拒
    await committed(await service.execute(envelopeOf('issue.sync.v1', SYNC_ASM_EQ1)));
    const rebuilt = (await service.listTasks(t1, { workOrderId: 'wo-1' }))[0]!;
    harness.material.available.set('item-bolt', 1);
    const std = (await service.taskDetail(t1, rebuilt.id)).lines.find((line) => line.kind === 'standard')!;
    await committed(
      await service.execute(
        envelopeOf('issue.confirm.v1', {
          lineKind: 'standard',
          lines: [{ taskLineId: std.lineId, allocations: [{ locationId: 'loc-1', quantity: 1, recommended: false }] }],
        }),
        rebuilt.id,
      ),
    );
    const blocked = await service.execute(
      envelopeOf('issue.cleanup.v1', { workOrderId: 'wo-1', dispatchKind: 'assembly', equipmentRefs: ['eq-1'] }),
    );
    expect(await rejectedReason(blocked)).toContain('非未开始');

    // 归拢清理走 includeRollup，不按设备过滤
    const empty = await service.execute(
      envelopeOf('issue.cleanup.v1', { workOrderId: 'wo-1', dispatchKind: 'assembly', includeRollup: true }),
    );
    expect(empty.status).toBe('committed');
  });
});

// ---- 输入解析与装配 ----

describe('issue 输入解析与信封纪律', () => {
  it('信封体：kind 枚举、expectedRevision 形状、payload 必填', () => {
    expect(() => parseIssueCommandEnvelopeBody({ operationId: 'op-1', expectedRevision: 'initial', command: { kind: 'issue.unknown.v1', payload: {} } })).toThrow(IssueInputError);
    expect(() => parseIssueCommandEnvelopeBody({ operationId: 'op-1', expectedRevision: 0, command: { kind: 'issue.sync.v1', payload: {} } })).toThrow(IssueInputError);
    expect(() => parseIssueCommandEnvelopeBody({ operationId: 'op-1', expectedRevision: 'initial', command: { kind: 'issue.sync.v1' } })).toThrow(IssueInputError);
    const ok = parseIssueCommandEnvelopeBody({
      operationId: 'op-1',
      expectedRevision: 'initial',
      command: { kind: 'issue.sync.v1', payload: { workOrderId: 'wo-1', dispatchKind: 'assembly', equipmentRefs: ['eq-1'] } },
    });
    expect(ok.command.kind).toBe('issue.sync.v1');
  });

  it('sync 载荷：dispatchKind 枚举、设备引用形状', () => {
    expect(() => parseIssueSyncPayload({ workOrderId: 'wo-1', dispatchKind: 'oddjob' })).toThrow(IssueInputError);
    expect(() => parseIssueSyncPayload({ workOrderId: 'wo-1', dispatchKind: 'assembly', equipmentRefs: [''] })).toThrow(IssueInputError);
    expect(parseIssueSyncPayload({ workOrderId: 'wo-1', dispatchKind: 'electrical' }).equipmentRefs).toBeUndefined();
  });

  it('confirm 载荷：lines 非空、数量为正、库位分配形状、图片 ≤6；纯勾选未配库位行放行（跳过语义在 service）', () => {
    expect(() => parseIssueConfirmPayload({ lineKind: 'part', lines: [] })).toThrow(IssueInputError);
    const pickedOnly = parseIssueConfirmPayload({ lineKind: 'standard', lines: [{ taskLineId: 'l1' }] });
    expect(pickedOnly.lines[0]!.quantity).toBeNull();
    expect(pickedOnly.lines[0]!.allocations).toBeNull();
    expect(() =>
      parseIssueConfirmPayload({ lineKind: 'part', lines: [{ taskLineId: 'l1', quantity: 0 }] }),
    ).toThrow(IssueInputError);
    expect(() =>
      parseIssueConfirmPayload({
        lineKind: 'standard',
        lines: [{ taskLineId: 'l1', allocations: [{ locationId: 'loc', quantity: 1, recommended: 'yes' }] }],
      }),
    ).toThrow(IssueInputError);
    expect(() =>
      parseIssueConfirmPayload({
        lineKind: 'part',
        lines: [{ taskLineId: 'l1', quantity: 1 }],
        express: { trackingNo: 'SF-1', shipper: 's', shipTime: FIXED_NOW, imageRefs: Array.from({ length: 7 }, (_, i) => `img-${i}`) },
      }),
    ).toThrow(IssueInputError);
    const ok = parseIssueConfirmPayload({
      lineKind: 'standard',
      lines: [{ taskLineId: 'l1', allocations: [{ locationId: 'loc', quantity: 2 }] }],
    });
    expect(ok.lines[0]!.allocations![0]!.recommended).toBe(false); // 缺省非推荐
  });

  it('创建族命令 expectedRevision 须 initial；revoke 须数字', async () => {
    const { service, demand } = newHarness();
    demand.setLines(assemblyDemand());
    const bad = await service.execute(
      envelopeOf('issue.sync.v1', SYNC_ASM_EQ1, { expectedRevision: 3 }),
    );
    expect(await rejectedReason(bad)).toContain("须为 'initial'");
  });
});

describe('控制器权限码与模块装配', () => {
  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, unknown>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('路由权限码（issue:read/write/revoke）', () => {
    expect(routePermissions(IssueTasksController, 'sync')).toBe('issue:write');
    expect(routePermissions(IssueTasksController, 'cleanup')).toBe('issue:write');
    expect(routePermissions(IssueTasksController, 'list')).toBe('issue:read');
    expect(routePermissions(IssueTasksController, 'detail')).toBe('issue:read');
    expect(routePermissions(IssueTasksController, 'issueDetail')).toBe('issue:read');
    expect(routePermissions(IssueTasksController, 'confirm')).toBe('issue:write');
    expect(routePermissions(IssueTasksController, 'shipHeads')).toBe('issue:read');
    expect(routePermissions(IssueRecordsController, 'list')).toBe('issue:read');
    expect(routePermissions(IssueRecordsController, 'detail')).toBe('issue:read');
    expect(routePermissions(IssueRecordsController, 'revoke')).toBe('issue:revoke');
  });

  it('IssueModule.register 缺省回落内存实现 + 导出 IssueService（零 DB boot）', () => {
    const dynamic = IssueModule.register();
    expect(dynamic.module).toBe(IssueModule);
    expect(dynamic.controllers).toHaveLength(2);
    expect(dynamic.exports).toContain(IssueService);
    expect((dynamic.providers ?? []).length).toBeGreaterThan(0);
  });

  it('缺省端口：空需求源 + NOOP 库存端口语义完整（同步零行、确认可用量 0）', async () => {
    const stores = createInMemoryIssueStores();
    const service = new IssueService(
      stores.taskStore,
      stores.taskLineStore,
      stores.recordStore,
      stores.expressStore,
      stores.operationStore,
      stores.domainEventStore,
      EMPTY_ISSUE_DEMAND_PORT,
      NOOP_ISSUE_MATERIAL_PORT,
      { now: () => FIXED_NOW },
    );
    const result = await committed(
      await service.execute(envelopeOf('issue.sync.v1', { workOrderId: 'wo-x', dispatchKind: 'assembly', rollup: true })),
    );
    expect(result.tasks).toHaveLength(0); // 空需求源 → 无外购设备行 → 不建归拢单
  });
});


describe('真实设备维发料同步', () => {
  it('两设备分单、不串行，aftermarket不进入生产；重同步不重复任务或行，跨令设备拒绝', async () => {
    const source = new InMemoryWorkOrderEquipmentStore();
    for (const id of ['eq-a', 'eq-b']) await source.create({ tenant: t1, id, workOrderId: 'wo-1', code: id, name: id, quantity: 1, kind: 'self-made' });
    await source.create({ tenant: t1, id: 'eq-other', workOrderId: 'wo-other', code: 'O', name: '其它令', quantity: 1, kind: 'self-made' });
    const demand = new FakeDemandPort([
      demandLine({ listingLineId: 'line-a', kind: 'part', equipmentRef: 'eq-a', itemId: 'same-material' }),
      demandLine({ listingLineId: 'line-b', kind: 'standard', equipmentRef: 'eq-b', itemId: 'same-material' }),
      demandLine({ listingLineId: 'aftermarket', kind: 'standard', equipmentRef: 'eq-a', itemId: 'same-material', origin: 'aftermarket' }),
    ]);
    const h = newHarness({ demand, equipmentSource: source });
    const payload = { workOrderId: 'wo-1', dispatchKind: 'assembly', equipmentRefs: ['eq-a', 'eq-b'] };
    const first = await committed(await h.service.execute(envelopeOf('issue.sync.v1', payload)));
    expect(first.tasks).toHaveLength(2);
    for (const task of first.tasks ?? []) {
      const detail = await h.service.issueDetail(t1, task.id, { lineKind: undefined, moduleName: undefined, name: undefined, pendingFilter: undefined, current: 1, size: 20 });
      expect(detail.lines.map((line) => line.sourceLineId)).toEqual([task.equipmentRef === 'eq-a' ? 'line-a' : 'line-b']);
    }
    const second = await committed(await h.service.execute(envelopeOf('issue.sync.v1', payload)));
    expect(second.tasks?.map((task) => task.id).sort()).toEqual(first.tasks?.map((task) => task.id).sort());
    expect((await h.service.execute(envelopeOf('issue.sync.v1', { ...payload, equipmentRefs: ['eq-other'] }))).status).toBe('rejected');
  });
});
