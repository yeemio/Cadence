import type { WorkOrderEquipmentStore } from '../workorder/workorder-equipment.js';
/**
 * IssueService —— 发料任务/发料记录用例编排（U1，A11 增量：发料链路）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分。实现 IssueSyncPort（派工触发面——dispatch 侧合流注入）。
 *
 * 四件事：
 *
 * 1. 派工同步生成/补全（issue.sync）：装配（part+standard 行）/电气（electrical
 *    行）按「工作令+设备+派工类型」find-or-create 主表 + appendMissing 补子行
 *    （幂等：重触发只补缺失行）；整线装配归拢（rollup）一工作令一条、
 *    equipment 行子行全令归拢、无外购设备不建单；生产发料排除 aftermarket
 *    origin 行；缺设备维且非归拢 → 阻断（文档 1.2）；
 * 2. 去发料/确认发料（issue.confirm）：一条记录一种 lineKind（不可跨类混提）；
 *    行范围=勾选行（standard/electrical 未配库位的行跳过、全部跳过则拒）；
 *    四数量校验（part：可发=预占−已发，负数按数据错误阻断；standard/electrical：
 *    可发=min(预占+料品可用, 待发)；equipment：可发=min(待发, max(0, 预占−已发))）；
 *    standard/electrical 经 IssueMaterialPort 库位扣减（issueKey 幂等，回执快照
 *    进 allocations，撤销按同一 issueKey 原路回滚）；part 拆预占冲减、equipment
 *    拆利用库存冲减（余量不落库）；快照不以后续实时库存反改；确认后
 *    refreshTaskSummary 重算状态与进度；
 * 3. 撤销发料（issue.revoke）：仅整单、仅有效记录；standard/electrical 按确认
 *    快照 issueKey 原路回滚（IssueMaterialPort.rollbackIssue）；记录迁 revoked
 *    （已发累计退出）；快递单无其余有效记录引用时删除；refreshTaskSummary；
 * 4. 撤销派工清理（issue.cleanup）：目标任务非未开始则整批拒绝；投影行连带
 *    删除（任务+子行）；发料记录不删（快照事实保留）。
 *
 * 落账顺序（与 listing/dispatch 同取舍）：解析与纯读校验（四数量/快递头一致性）
 * 通过后幂等记账——被拒不占用 operationId；此后库存端口联动（拒绝则整单
 * rejected 返回，operationId 已占用——与 inventory 深校验/记账取舍一致：端口
 * 是扣减权威，无先读预演面）→ 投影写入 → 域事件发布（IssueConfirmed /
 * IssueRevoked——BusinessEvent + Outbox）。端口成功后投影写入失败属数据级
 * 中断（抛 IssueStateError 兜底，PG 侧合流时以事务收口）。
 */
import {
  EventId,
  OperationId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
  type CommittedOutcome,
  type IndeterminateOutcome,
  type RejectedOutcome,
  type TenantId,
} from '@smes/business-core';
import {
  ISSUE_RECORD_NO_PREFIX,
  issueTaskNoPrefix,
  operableKinds,
  participationKinds,
  type IssueDispatchKind,
  type IssueLineKind,
  type IssueTaskState,
} from './issue-config.js';
import {
  ISSUE_RECORD_AGGREGATE_TYPE,
  ISSUE_TASK_AGGREGATE_TYPE,
  makeIssueConfirmedEvent,
  makeIssueRevokedEvent,
  provenanceOf,
  type IssueConfirmedPayload,
  type IssueEventProvenance,
  type IssueRevokedPayload,
} from './issue-events.js';
import {
  IssueInputError,
  IssueNotFoundError,
  IssueStateError,
} from './issue-errors.js';
import {
  parseIssueCleanupPayload,
  parseIssueConfirmPayload,
  parseIssueRevokePayload,
  parseIssueSyncPayload,
  type IssueCleanupPayload,
  type IssueCommand,
  type IssueCommandKind,
  type IssueConfirmLinePayload,
  type IssueConfirmPayload,
  type IssueSyncPayload,
} from './issue-input.js';
import {
  EMPTY_ISSUE_DEMAND_PORT,
  NOOP_ISSUE_MATERIAL_PORT,
  type IssueDemandLine,
  type IssueDemandSourcePort,
  type IssueMaterialPort,
  type IssueSyncPort,
  type IssueSyncReceipt,
  type IssueSyncTrigger,
} from './issue-ports.js';
import type {
  AppendIssueTaskLineInput,
  IssueExpress,
  IssueExpressStore,
  IssueOperationStore,
  IssueRecord,
  IssueRecordLineSnapshot,
  IssueRecordStore,
  IssueTask,
  IssueTaskLine,
  IssueTaskLineStore,
  IssueTaskStore,
  ListIssueRecordsFilter,
  ListIssueTasksFilter,
  IssueDomainEventStore,
} from './issue-stores.js';
import {
  newDomainEventId,
  newIssueExpressId,
  newIssueRecordId,
  newIssueTaskId,
  newIssueTaskLineId,
  uuidv7,
} from './issue-ids.js';

// ---- 结果形状 ----

export interface IssueCommitted extends CommittedOutcome {
  readonly task?: IssueTask;
  readonly tasks?: readonly IssueTask[];
  readonly record?: IssueRecord;
  readonly express?: IssueExpress;
  /** 同步各任务本次补全行数（taskId → count）。 */
  readonly appendedCountByTask?: ReadonlyMap<string, number>;
  /** 清理删除的任务 id 集。 */
  readonly deletedTaskIds?: readonly string[];
}

export type IssueCommandResult = IssueCommitted | RejectedOutcome | IndeterminateOutcome;

/** 明细行四数量视图（实时计算，不落任务子表——文档 1.2/1.4）。 */
export interface IssueLineQuantities {
  readonly lineId: string;
  readonly kind: IssueLineKind;
  /** 总需求量（行快照）。 */
  readonly requiredQty: number;
  /** 已发数量（有效记录累计）。 */
  readonly issuedQty: number;
  /** 待发数量 = max(总需求 − 已发, 0)。 */
  readonly pendingQty: number;
  /** 已预占库存（part/standard/electrical：锚点预占 Σ；equipment：利用库存+入库完成）。 */
  readonly reservedQty: number;
  /** 当前可发数量（类别口径；part 可为负——数据错误由确认发料阻断）。 */
  readonly availableNowQty: number;
}

/** 任务明细视图 = 任务行字段 + 四数量。 */
export type IssueTaskLineView = IssueTaskLine & IssueLineQuantities;

/** 去发料页明细视图（当前页行 + 四数量 + 筛选/分页元数据）。 */
export type IssueDetailLineView = IssueTaskLineView;

export interface IssueDetailView {
  readonly task: IssueTask;
  readonly lines: readonly IssueDetailLineView[];
  readonly lineTotal: number;
  /** 有数据的可操作类别集（去发料页 Tab）。 */
  readonly operateKinds: readonly IssueLineKind[];
  /** 当前类别（或全类别）的模块名选项（分组筛选下拉）。 */
  readonly groupOptions: readonly string[];
}

export interface IssueServiceOptions {
  readonly equipmentSource?: WorkOrderEquipmentStore | undefined;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

export class IssueService implements IssueSyncPort {
  private readonly nowFn: () => string;

  constructor(
    private readonly tasks: IssueTaskStore,
    private readonly taskLines: IssueTaskLineStore,
    private readonly records: IssueRecordStore,
    private readonly expresses: IssueExpressStore,
    private readonly operations: IssueOperationStore,
    private readonly domainEvents: IssueDomainEventStore,
    private readonly demandSource: IssueDemandSourcePort = EMPTY_ISSUE_DEMAND_PORT,
    private readonly material: IssueMaterialPort = NOOP_ISSUE_MATERIAL_PORT,
    private readonly options: IssueServiceOptions = {},
  ) {
    this.nowFn = options.now ?? DEFAULT_NOW;
  }

  private now(): string {
    return this.nowFn();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(envelope: CommandEnvelope<IssueCommand>, pathId?: string): Promise<IssueCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly IssueCommandKind[] = ['issue.sync.v1', 'issue.confirm.v1', 'issue.cleanup.v1'];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建/集合命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有记录：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'issue.sync.v1':
        return this.sync(envelope, parseIssueSyncPayload(envelope.command.payload));
      case 'issue.confirm.v1':
        return this.confirm(envelope, this.requirePathId(pathId, kind), parseIssueConfirmPayload(envelope.command.payload));
      case 'issue.revoke.v1':
        return this.revoke(envelope, this.requirePathId(pathId, kind), parseIssueRevokePayload(envelope.command.payload));
      case 'issue.cleanup.v1':
        return this.cleanup(envelope, parseIssueCleanupPayload(envelope.command.payload));
    }
  }

  private requirePathId(pathId: string | undefined, kind: IssueCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new IssueInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- issue.sync（派工触发生成/补全） ----

  /** IssueSyncPort 面：dispatch 派工成功事件点的生成钩子（接线归合流）。 */
  async syncFromDispatch(tenant: TenantId, trigger: IssueSyncTrigger): Promise<IssueSyncReceipt> {
    const envelope = this.systemEnvelope(tenant, 'issue.sync.v1', {
      workOrderId: trigger.workOrderId,
      dispatchKind: trigger.dispatchKind,
      ...(trigger.equipmentRefs === undefined ? {} : { equipmentRefs: [...trigger.equipmentRefs] }),
      ...(trigger.rollup === undefined ? {} : { rollup: trigger.rollup }),
      ...(trigger.workOrderLabel === undefined ? {} : { workOrderLabel: trigger.workOrderLabel }),
      ...(trigger.plannedStartAt === undefined ? {} : { plannedStartAt: trigger.plannedStartAt }),
      ...(trigger.plannedEndAt === undefined ? {} : { plannedEndAt: trigger.plannedEndAt }),
      ...(trigger.operators === undefined ? {} : { operators: [...trigger.operators] }),
      ...(trigger.triggerRef === undefined || trigger.triggerRef === null ? {} : { triggerRef: trigger.triggerRef }),
    });
    const outcome = await this.sync(envelope, parseIssueSyncPayload(envelope.command.payload));
    if (outcome.status !== 'committed') {
      throw new IssueStateError(`派工触发生成被拒：${outcome.reason}`);
    }
    return {
      tasks: outcome.tasks ?? [],
      appendedCountByTask: outcome.appendedCountByTask ?? new Map<string, number>(),
    };
  }

  private async sync(envelope: CommandEnvelope<IssueCommand>, payload: IssueSyncPayload): Promise<IssueCommandResult> {
    const tenant = envelope.tenantId;
    const equipmentRefs = payload.equipmentRefs ?? [];
    const rollup = payload.rollup ?? false;
    // 阻断规则（文档 1.2）：四子模块缺设备维时不生成——非归拢同步必须携带非空
    // 自制设备集合（未选设备=全令自制的解析归调用方）。
    if (equipmentRefs.length === 0 && !rollup) {
      return rejected('同步被拒：equipmentRefs 为空且非归拢同步（生成发料任务须携带设备维；归拢走 rollup=true）');
    }

    if (this.options.equipmentSource) {
      for (const ref of equipmentRefs) {
        const equipment = await this.options.equipmentSource.find(tenant, ref);
        if (!equipment || equipment.workOrderId !== payload.workOrderId || equipment.kind !== 'self-made') return rejected('设备不存在、不属于本工作令/租户或不是自制设备');
      }
    }
    const production = (await this.demandSource.demandLines(tenant, payload.workOrderId)).filter(
      (line) => line.origin === 'production',
    );
    const lineKinds: readonly IssueLineKind[] = participationKinds(payload.dispatchKind, false);

    const targets: { task: IssueTask; lines: readonly IssueDemandLine[] }[] = [];
    for (const equipmentRef of equipmentRefs) {
      const task = await this.findOrCreateTask(tenant, payload, {
        rollup: false,
        equipmentRef,
      });
      targets.push({
        task,
        lines: production.filter((line) => line.equipmentRef === equipmentRef && lineKinds.includes(line.kind)),
      });
    }
    if (rollup && payload.dispatchKind === 'assembly') {
      const equipmentLines = production.filter((line) => line.kind === 'equipment');
      // 无外购设备则不建归拢单（文档 1.2）——行集为空不建主表。
      if (equipmentLines.length > 0) {
        const task = await this.findOrCreateTask(tenant, payload, { rollup: true, equipmentRef: null });
        targets.push({ task, lines: equipmentLines });
      }
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: ISSUE_TASK_AGGREGATE_TYPE,
      aggregateId: payload.workOrderId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const appendedCountByTask = new Map<string, number>();
    const refreshedTasks: IssueTask[] = [];
    for (const target of targets) {
      const result = await this.appendMissingLines(tenant, target.task.id, target.lines);
      appendedCountByTask.set(target.task.id, result.appended.length);
      // 补行后即时重算汇总（总需求/进度冗余列与行集一致）。
      refreshedTasks.push((await this.refreshTaskSummary(tenant, target.task.id)).task);
    }
    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      tasks: refreshedTasks,
      appendedCountByTask,
    };
  }

  private async findOrCreateTask(
    tenant: TenantId,
    payload: IssueSyncPayload,
    dimension: { readonly rollup: boolean; readonly equipmentRef: string | null },
  ): Promise<IssueTask> {
    const existing = await this.tasks.findByDimension(tenant, {
      workOrderId: payload.workOrderId,
      dispatchKind: payload.dispatchKind,
      rollup: dimension.rollup,
      equipmentRef: dimension.equipmentRef,
    });
    if (existing !== null) {
      // 幂等：命中既有任务只补子行；triggerRefs 保留首次锚点（关联派工单号
      // 的实时解析是展示层行为，合流接线时按需扩展）。
      return existing;
    }
    return this.tasks.create({
      tenant,
      id: newIssueTaskId(),
      taskNo: `${issueTaskNoPrefix(payload.dispatchKind, dimension.rollup)}${uuidv7()}`,
      workOrderId: payload.workOrderId,
      workOrderLabel: payload.workOrderLabel ?? null,
      dispatchKind: payload.dispatchKind,
      rollup: dimension.rollup,
      equipmentRef: dimension.equipmentRef,
      plannedStartAt: payload.plannedStartAt ?? null,
      plannedEndAt: payload.plannedEndAt ?? null,
      operators: payload.operators ?? [],
      triggerRefs:
        payload.triggerRef === undefined || payload.triggerRef === null ? [] : [payload.triggerRef],
    });
  }

  /** syncMissingLines：按 (taskId, sourceLineId) 去重补全子行（既有行不动）。 */
  private async appendMissingLines(
    tenant: TenantId,
    taskId: string,
    demandLines: readonly IssueDemandLine[],
  ): Promise<{ readonly appended: readonly IssueTaskLine[]; readonly all: readonly IssueTaskLine[] }> {
    if (demandLines.length === 0) {
      return { appended: [], all: await this.taskLines.listByTask(tenant, taskId) };
    }
    return this.taskLines.appendMissing(
      tenant,
      taskId,
      demandLines.map((line): AppendIssueTaskLineInput => ({
        tenant,
        id: newIssueTaskLineId(),
        taskId,
        lineNo: 0, // 存储侧续排（端口合同：appendMissing 负责行号）
        kind: line.kind,
        sourceLineId: line.listingLineId,
        itemId: line.itemId,
        moduleName: line.moduleName,
        name: line.name,
        drawingNo: line.drawingNo,
        requiredQty: line.requiredQty,
      })),
    );
  }

  // ---- issue.confirm（去发料/确认发料） ----

  private async confirm(
    envelope: CommandEnvelope<IssueCommand>,
    taskId: string,
    payload: IssueConfirmPayload,
  ): Promise<IssueCommandResult> {
    const tenant = envelope.tenantId;
    const task = await this.tasks.find(tenant, taskId);
    if (task === null) {
      return rejected(`租户 '${tenant}' 内不存在发料任务 '${taskId}'`);
    }
    const operable = operableKinds(task.dispatchKind, task.rollup);
    if (!operable.includes(payload.lineKind)) {
      return rejected(
        `任务 '${task.taskNo}' 不支持 ${payload.lineKind} 类确认发料（允许类别：${operable.join('/')}）`,
      );
    }

    const taskLines = await this.taskLines.listByTask(tenant, taskId);
    const lineById = new Map(taskLines.map((line) => [line.id, line]));
    // 行范围解析：勾选行；standard/electrical 未配库位分配的行跳过（不发不报错）。
    const participating: { taskLine: IssueTaskLine; submit: IssueConfirmLinePayload; thisQty: number }[] = [];
    for (const submit of payload.lines) {
      const taskLine = lineById.get(submit.taskLineId);
      if (taskLine === undefined) {
        return rejected(`发料行 '${submit.taskLineId}' 不属于任务 '${task.taskNo}'（勾选行须为任务明细行）`);
      }
      if (taskLine.kind !== payload.lineKind) {
        return rejected(
          `发料行 '${submit.taskLineId}' 类别为 ${taskLine.kind}，与本次提交类别 ${payload.lineKind} 不符（一条记录一种类别）`,
        );
      }
      if (payload.lineKind === 'standard' || payload.lineKind === 'electrical') {
        if (submit.allocations === null || submit.allocations.length === 0) continue; // 未配库位行跳过
        participating.push({
          taskLine,
          submit,
          thisQty: submit.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0),
        });
      } else {
        if (submit.quantity === null) {
          return rejected(`发料行 '${submit.taskLineId}' 须携带 quantity（${payload.lineKind} 类按行数量发料）`);
        }
        participating.push({ taskLine, submit, thisQty: submit.quantity });
      }
    }
    if (participating.length === 0) {
      return rejected('确认发料被拒：参与行为空（须至少一行勾选且可发；标准件/电气件行须已配库位分配）');
    }

    // 四数量（发料前实时值）——校验与快照共用同一次读取。
    const quantities = await this.lineQuantities(tenant, task, taskLines);
    const quantityByLineId = new Map(quantities.map((entry) => [entry.lineId, entry]));

    // 逐行校验（文档 1.4.1/1.4.2/2.3.2）。物料锚定检查先于数量检查（未解析
    // 物料的标准/电气行可发恒 0，先报根因）。
    for (const row of participating) {
      const quantity = quantityByLineId.get(row.taskLine.id);
      if (quantity === undefined) continue; // 防御（前面已守卫行归属）
      if ((payload.lineKind === 'standard' || payload.lineKind === 'electrical') && row.taskLine.itemId === null) {
        return rejected(
          `发料行 '${row.taskLine.id}' 未解析确认物料（库位发料须物料锚定；先完成物料校验确认）`,
        );
      }
      if (payload.lineKind === 'part' && quantity.availableNowQty < 0) {
        return rejected(
          `发料行 '${row.taskLine.id}' 数据错误：已发 ${quantity.issuedQty} > 已预占 ${quantity.reservedQty}（后端按数据错误阻断，不前端截断）`,
        );
      }
      if (row.thisQty <= 0) {
        return rejected(`发料行 '${row.taskLine.id}' 本次发料数量须 > 0`);
      }
      if (row.thisQty > quantity.availableNowQty) {
        return rejected(
          `发料行 '${row.taskLine.id}' 当前可发数量不足（可发 ${quantity.availableNowQty} < 本次 ${row.thisQty}）`,
        );
      }
    }

    if (payload.lineKind === 'equipment') {
      const supply = new Map<string, number>();
      for (const line of await this.demandSource.demandLines(tenant, task.workOrderId)) {
        if (line.kind !== 'equipment' || line.origin !== 'production' || line.itemId === null) continue;
        supply.set(line.itemId, (supply.get(line.itemId) ?? 0) + line.useInventoryQty + line.inboundCompletedQty);
      }
      const held = new Map<string, number>();
      for (const record of await this.records.list(tenant, { workOrderId: task.workOrderId, state: 'active' })) {
        if (record.lineKind !== 'equipment') continue;
        for (const line of record.lines) if (line.itemId !== null) held.set(line.itemId, (held.get(line.itemId) ?? 0) + line.thisQty);
      }
      const requested = new Map<string, number>();
      for (const row of participating) if (row.taskLine.itemId !== null) requested.set(row.taskLine.itemId, (requested.get(row.taskLine.itemId) ?? 0) + row.thisQty);
      for (const [itemId, qty] of requested) {
        if (qty > Math.max(0, (supply.get(itemId) ?? 0) - (held.get(itemId) ?? 0))) return rejected(`外购设备物料 '${itemId}' 共享实收与利库剩余量不足，本次未发料`);
      }
    }

    // 快递单（发货头）一致性预检（纯读，被拒不占用 operationId）：同单号须发货头一致。
    let existingExpress: IssueExpress | null = null;
    if (payload.express !== null) {
      existingExpress = await this.expresses.findByNo(tenant, task.workOrderId, payload.express.trackingNo);
      if (existingExpress !== null && existingExpress.shipper !== payload.express.shipper) {
        return rejected(
          `快递单号 '${payload.express.trackingNo}' 已存在且发货人不一致（同单号须发货头一致）`,
        );
      }
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: ISSUE_RECORD_AGGREGATE_TYPE,
      aggregateId: taskId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 快递单落账：已有单号复用（expressId 挂记录），新单号创建。
    let expressId: string | null = null;
    let express: IssueExpress | null = null;
    if (payload.express !== null) {
      if (existingExpress !== null) {
        expressId = existingExpress.id;
        express = existingExpress;
      } else {
        express = await this.expresses.create({
          tenant,
          id: newIssueExpressId(),
          trackingNo: payload.express.trackingNo,
          shipper: payload.express.shipper,
          shipTime: payload.express.shipTime,
          imageRefs: payload.express.imageRefs,
          workOrderId: task.workOrderId,
          taskId: task.id,
        });
        expressId = express.id;
      }
    }

    // 库存联动（standard/electrical）：端口扣减（拒绝则整单 rejected——端口是
    // 扣减权威，无先读预演面；此路径 operationId 已占用，同 inventory 取舍）。
    // issueKey 锚定 (记录 id, 行序)：撤销按快照 issueKey 原路回滚。
    const recordId = newIssueRecordId();
    const stockReceipts: {
      issueKey: string;
      itemId: string;
      totalQty: number;
      reservedConsumedQty: number;
      availableConsumedQty: number;
    }[] = [];
    const allocationReceipts = new Map<string, NonNullable<IssueStockAllocations>>();
    const issueKeys = new Map<string, string>();
    if (payload.lineKind === 'standard' || payload.lineKind === 'electrical') {
      for (const [index, row] of participating.entries()) {
        const issueKey = `issue-${recordId}-l${index}`;
        const receipt = await this.material.issueStock(tenant, {
          issueKey,
          workOrderId: task.workOrderId,
          equipmentRef: task.equipmentRef,
          itemId: row.taskLine.itemId as string,
          allocations: (row.submit.allocations ?? []).map((allocation) => ({
            locationId: allocation.locationId,
            quantity: allocation.quantity,
          })),
        });
        if (!receipt.issued) {
          return rejected(`发料行 '${row.taskLine.id}' 库存联动被拒：${receipt.refusedReason ?? '未知原因'}`);
        }
        allocationReceipts.set(row.taskLine.id, receipt.allocations ?? []);
        issueKeys.set(row.taskLine.id, issueKey);
        stockReceipts.push({
          issueKey,
          itemId: row.taskLine.itemId as string,
          totalQty: row.thisQty,
          reservedConsumedQty: (receipt.allocations ?? []).reduce((sum, entry) => sum + entry.reservedConsumedQty, 0),
          availableConsumedQty: (receipt.allocations ?? []).reduce((sum, entry) => sum + entry.availableConsumedQty, 0),
        });
      }
    }

    // 已发累计与来源拆分滚动余量（同确认单内按提交行顺序滚减——文档 1.4.1）。
    const activeRecords = (await this.records.list(tenant, { taskId })).filter(
      (record) => record.state === 'active',
    );
    const issuedBefore = new Map<string, number>();
    const reservedConsumedBefore = new Map<string, number>();
    const useInventoryConsumedBefore = new Map<string, number>();
    for (const record of activeRecords) {
      for (const line of record.lines) {
        issuedBefore.set(line.taskLineId, (issuedBefore.get(line.taskLineId) ?? 0) + line.thisQty);
        reservedConsumedBefore.set(
          line.taskLineId,
          (reservedConsumedBefore.get(line.taskLineId) ?? 0) + line.reservedConsumedQty,
        );
        useInventoryConsumedBefore.set(
          line.taskLineId,
          (useInventoryConsumedBefore.get(line.taskLineId) ?? 0) + line.useInventoryConsumedQty,
        );
      }
    }

    // equipment 行剩余利用库存的实时需求行读取（清单当前 use_inventory − 已分摊）。
    const demandBySourceLine = new Map(
      payload.lineKind === 'equipment'
        ? (await this.demandSource.demandLines(tenant, task.workOrderId)).map((line) => [
            line.listingLineId,
            line,
          ])
        : [],
    );

    const snapshotLines: IssueRecordLineSnapshot[] = participating.map((row) => {
      const quantity = quantityByLineId.get(row.taskLine.id)!;
      const issuedBeforeQty = issuedBefore.get(row.taskLine.id) ?? 0;
      const issuedAfterQty = issuedBeforeQty + row.thisQty;
      let reservedConsumedQty = 0;
      let useInventoryConsumedQty = 0;
      if (payload.lineKind === 'part') {
        // 非标：先冲剩余预占（max(0, 预占 − 未撤销发料已分摊预占)），余量为自制不落库。
        reservedConsumedQty = Math.min(
          row.thisQty,
          Math.max(0, quantity.reservedQty - (reservedConsumedBefore.get(row.taskLine.id) ?? 0)),
        );
      } else if (payload.lineKind === 'equipment') {
        // 外购设备：先冲剩余利用库存（清单当前 − 未撤销发料已分摊），采购入库份不落库。
        const demand = demandBySourceLine.get(row.taskLine.sourceLineId);
        const remaining = Math.max(
          0,
          (demand?.useInventoryQty ?? 0) - (useInventoryConsumedBefore.get(row.taskLine.id) ?? 0),
        );
        useInventoryConsumedQty = Math.min(row.thisQty, remaining);
      }
      const allocations =
        payload.lineKind === 'standard' || payload.lineKind === 'electrical'
          ? (row.submit.allocations ?? []).map((allocation) => {
              const receipt =
                allocationReceipts.get(row.taskLine.id)?.find((entry) => entry.locationId === allocation.locationId) ??
                null;
              return {
                locationId: allocation.locationId,
                quantity: allocation.quantity,
                recommended: allocation.recommended,
                reservedConsumedQty: receipt?.reservedConsumedQty ?? 0,
                availableConsumedQty: receipt?.availableConsumedQty ?? allocation.quantity,
              };
            })
          : [];
      return {
        taskLineId: row.taskLine.id,
        kind: row.taskLine.kind,
        sourceLineId: row.taskLine.sourceLineId,
        itemId: row.taskLine.itemId,
        moduleName: row.taskLine.moduleName,
        name: row.taskLine.name,
        drawingNo: row.taskLine.drawingNo,
        requiredQty: row.taskLine.requiredQty,
        reservedBeforeQty: quantity.reservedQty,
        issuedBeforeQty,
        thisQty: row.thisQty,
        issuedAfterQty,
        pendingAfterQty: Math.max(row.taskLine.requiredQty - issuedAfterQty, 0),
        availableBeforeQty: quantity.availableNowQty,
        reservedConsumedQty:
          payload.lineKind === 'standard' || payload.lineKind === 'electrical'
            ? allocations.reduce((sum, allocation) => sum + allocation.reservedConsumedQty, 0)
            : reservedConsumedQty,
        useInventoryConsumedQty,
        issueKey: issueKeys.get(row.taskLine.id) ?? null,
        allocations,
      };
    });

    const totalQty = snapshotLines.reduce((sum, line) => sum + line.thisQty, 0);
    const record = await this.records.create({
      tenant,
      id: recordId,
      recordNo: `${ISSUE_RECORD_NO_PREFIX}${uuidv7()}`,
      taskId: task.id,
      taskNo: task.taskNo,
      workOrderId: task.workOrderId,
      workOrderLabel: task.workOrderLabel,
      dispatchKind: task.dispatchKind,
      rollup: task.rollup,
      equipmentRef: task.equipmentRef,
      lineKind: payload.lineKind,
      issuedAt: this.now(),
      issuedBy: envelope.issuedBy,
      totalQty,
      expressId,
      lines: snapshotLines,
    });

    const summary = await this.refreshTaskSummary(tenant, task.id);

    const eventPayload: IssueConfirmedPayload = {
      recordId: record.id,
      recordNo: record.recordNo,
      taskId: task.id,
      workOrderId: task.workOrderId,
      dispatchKind: task.dispatchKind,
      rollup: task.rollup,
      lineKind: payload.lineKind,
      lineCount: snapshotLines.length,
      totalQty,
      expressId,
      stockReceipts,
      taskState: summary.state,
      taskTotalRequiredQty: summary.totalRequiredQty,
      taskTotalIssuedQty: summary.totalIssuedQty,
      objectVersion: 1,
      actor: envelope.issuedBy,
    };
    await this.domainEvents.append(makeIssueConfirmedEvent(this.domainEventBase(envelope), eventPayload));

    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      record,
      ...(express === null ? {} : { express }),
      task: summary.task,
    };
  }

  // ---- issue.revoke（撤销发料：整单 + 原路回滚） ----

  private async revoke(
    envelope: CommandEnvelope<IssueCommand>,
    recordId: string,
    payload: { readonly remark: string | null },
  ): Promise<IssueCommandResult> {
    void payload; // 备注不落快照（溯源经域事件 provenance 承载）
    const tenant = envelope.tenantId;
    const record = await this.records.find(tenant, recordId);
    if (record === null) {
      return rejected(`租户 '${tenant}' 内不存在发料记录 '${recordId}'`);
    }
    if (record.state !== 'active') {
      return rejected(`发料记录 '${record.recordNo}' 已撤销（仅有效记录可整单撤销，不支持重复撤销）`);
    }
    if (envelope.expectedRevision !== record.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，发料记录当前 objectVersion=${record.objectVersion}`,
      );
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: ISSUE_RECORD_AGGREGATE_TYPE,
      aggregateId: record.id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 原路回滚（standard/electrical）：按确认快照 issueKey 反冲（非标/外购设备
    // 不回冲库存——文档 1.4.3）。回滚后记录写入失败属数据级中断（并发窗口），
    // 抛 StateError 人工对账（内存路径不可达）。
    const stockRollbacks: { issueKey: string; rolled: boolean }[] = [];
    if (record.lineKind === 'standard' || record.lineKind === 'electrical') {
      for (const line of record.lines) {
        if (line.issueKey === null || line.allocations.length === 0) continue;
        const rollback = await this.material.rollbackIssue(tenant, { issueKey: line.issueKey });
        if (!rollback.rolled) {
          return rejected(
            `发料记录 '${record.recordNo}' 库存回滚被拒（行 ${line.taskLineId}）：${rollback.refusedReason ?? '未知原因'}`,
          );
        }
        stockRollbacks.push({ issueKey: line.issueKey, rolled: true });
      }
    }

    const revokedAt = this.now();
    const revoked = await this.records.revoke(tenant, record.id, record.objectVersion, revokedAt, envelope.issuedBy);
    if (revoked === null) {
      throw new IssueStateError(
        `发料记录 '${record.recordNo}' 回滚后撤销写入冲突（并发撤销窗口）：库存已回滚、记录态未迁移，须人工对账`,
      );
    }

    // 快递单清理：该快递单无其余有效发料记录引用时删除（文档 1.2/3.3）。
    if (record.expressId !== null) {
      const stillActive = (await this.records.list(tenant, { workOrderId: record.workOrderId })).some(
        (candidate) => candidate.state === 'active' && candidate.expressId === record.expressId,
      );
      if (!stillActive) {
        await this.expresses.delete(tenant, record.expressId);
      }
    }

    const summary = await this.refreshTaskSummary(tenant, record.taskId);

    const eventPayload: IssueRevokedPayload = {
      recordId: revoked.id,
      recordNo: revoked.recordNo,
      taskId: revoked.taskId,
      workOrderId: revoked.workOrderId,
      lineKind: revoked.lineKind,
      stockRollbacks,
      taskState: summary.state,
      taskTotalRequiredQty: summary.totalRequiredQty,
      taskTotalIssuedQty: summary.totalIssuedQty,
      objectVersion: revoked.objectVersion,
      actor: envelope.issuedBy,
    };
    await this.domainEvents.append(makeIssueRevokedEvent(this.domainEventBase(envelope), eventPayload));

    return { status: 'committed', newRevision: revoked.objectVersion, events: [], record: revoked, task: summary.task };
  }

  // ---- issue.cleanup（撤销派工清理） ----

  private async cleanup(
    envelope: CommandEnvelope<IssueCommand>,
    payload: IssueCleanupPayload,
  ): Promise<IssueCommandResult> {
    const tenant = envelope.tenantId;
    const equipmentRefs = payload.equipmentRefs ?? [];
    const includeRollup = payload.includeRollup ?? false;
    if (equipmentRefs.length === 0 && !includeRollup) {
      return rejected('清理被拒：equipmentRefs 为空且不含归拢（清理须指定目标任务集）');
    }

    const workOrders = await this.tasks.list(tenant, {
      workOrderId: payload.workOrderId,
      dispatchKind: payload.dispatchKind,
    });
    // 自制任务按设备匹配；归拢任务只随整线装配清理、不按设备过滤（文档 3.3）。
    const targets = workOrders.filter(
      (task) =>
        (!task.rollup && task.equipmentRef !== null && equipmentRefs.includes(task.equipmentRef)) ||
        (includeRollup && task.rollup),
    );
    if (targets.length === 0) {
      return { status: 'committed', newRevision: 1, events: [], deletedTaskIds: [] };
    }

    // 任一目标任务非未开始 → 整批拒绝（文档 3.3：不可撤销该派工）。
    const started = targets.filter((task) => task.state !== 'not-started');
    if (started.length > 0) {
      return rejected(
        `清理被拒：任务 ${started.map((task) => task.taskNo).join('、')} 已有发料记录（非未开始，不可随撤销派工删除）`,
      );
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: ISSUE_TASK_AGGREGATE_TYPE,
      aggregateId: payload.workOrderId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const deletedTaskIds: string[] = [];
    for (const target of targets) {
      await this.taskLines.deleteByTask(tenant, target.id);
      await this.tasks.delete(tenant, target.id);
      deletedTaskIds.push(target.id);
    }
    return { status: 'committed', newRevision: 1, events: [], deletedTaskIds };
  }

  // ---- 查询 ----

  /** 发料任务列表（createdAt 降序；state/workOrderId/dispatchKind/equipmentRef/rollup 过滤）。 */
  async listTasks(tenant: TenantId, filter?: ListIssueTasksFilter): Promise<readonly IssueTask[]> {
    return this.tasks.list(tenant, filter);
  }

  /** 任务详情（任务 + 明细行四数量——实时计算不落库）。 */
  async taskDetail(tenant: TenantId, taskId: string): Promise<{
    readonly task: IssueTask;
    readonly lines: readonly IssueTaskLineView[];
  }> {
    const task = await this.tasks.find(tenant, taskId);
    if (task === null) {
      throw new IssueNotFoundError(`租户 '${tenant}' 内不存在发料任务 '${taskId}'`);
    }
    const taskLines = await this.taskLines.listByTask(tenant, taskId);
    const quantityByLineId = new Map(
      (await this.lineQuantities(tenant, task, taskLines)).map((entry) => [entry.lineId, entry]),
    );
    return {
      task,
      lines: taskLines.map((line) => ({ ...line, ...(quantityByLineId.get(line.id) as IssueLineQuantities) })),
    };
  }

  /** 去发料页明细（当前 Tab 当前页 + 四数量；模块/名称先过滤，待发状态在四数量后过滤再分页——文档 2.3.1）。 */
  async issueDetail(tenant: TenantId, taskId: string, query: IssueDetailQueryInput): Promise<IssueDetailView> {
    const task = await this.tasks.find(tenant, taskId);
    if (task === null) {
      throw new IssueNotFoundError(`租户 '${tenant}' 内不存在发料任务 '${taskId}'`);
    }
    const taskLines = await this.taskLines.listByTask(tenant, taskId);
    const operateKinds = operableKinds(task.dispatchKind, task.rollup).filter((kind) =>
      taskLines.some((line) => line.kind === kind),
    );
    let scoped = taskLines;
    if (query.lineKind !== undefined) {
      scoped = scoped.filter((line) => line.kind === query.lineKind);
    }
    if (query.moduleName !== undefined) {
      scoped = scoped.filter((line) => line.moduleName === query.moduleName); // 模块/元件组精确匹配
    }
    if (query.name !== undefined) {
      const needle = query.name.toLowerCase();
      scoped = scoped.filter(
        (line) =>
          (line.name ?? '').toLowerCase().includes(needle) ||
          (line.drawingNo ?? '').toLowerCase().includes(needle),
      );
    }
    const scopedIds = new Set(scoped.map((line) => line.id));
    const quantityByLineId = new Map(
      (await this.lineQuantities(tenant, task, taskLines)).map((entry) => [entry.lineId, entry]),
    );

    let rows: IssueTaskLineView[] = scoped.map((line) => ({
      ...line,
      ...(quantityByLineId.get(line.id) as IssueLineQuantities),
    }));
    if (query.pendingFilter !== undefined) {
      rows = rows.filter((row) => {
        // 有效可发 = min(max(当前可发,0), 待发)；部分可发 0<有效<待发；全部可发 ≥ 待发；无可发 = 0。
        const effective = Math.min(Math.max(row.availableNowQty, 0), row.pendingQty);
        if (query.pendingFilter === 'none') return effective === 0;
        if (query.pendingFilter === 'all-available') return effective >= row.pendingQty;
        return effective > 0 && effective < row.pendingQty; // partial
      });
    }
    const lineTotal = rows.length;
    const start = (query.current - 1) * query.size;
    const page = rows.slice(start, start + query.size);
    const groupOptions = [
      ...new Set(scoped.map((line) => line.moduleName).filter((name): name is string => name !== null)),
    ].sort();
    return { task, lines: page, lineTotal, operateKinds, groupOptions };
  }

  /** 发料记录列表（issuedAt 降序；taskId/workOrderId/state 过滤）。 */
  async listRecords(tenant: TenantId, filter?: ListIssueRecordsFilter): Promise<readonly IssueRecord[]> {
    return this.records.list(tenant, filter);
  }

  /** 发料记录详情。 */
  async recordDetail(tenant: TenantId, recordId: string): Promise<IssueRecord> {
    const record = await this.records.find(tenant, recordId);
    if (record === null) {
      throw new IssueNotFoundError(`租户 '${tenant}' 内不存在发料记录 '${recordId}'`);
    }
    return record;
  }

  /**
   * 快递单下拉（去发料页）：任务不存在返回空列表（不抛 404——文档 3.1）。
   * 范围 = 该任务归属工作令下已登记的发货头。
   */
  async shipHeads(tenant: TenantId, taskId: string): Promise<readonly IssueExpress[]> {
    const task = await this.tasks.find(tenant, taskId);
    if (task === null) return [];
    return this.expresses.listByWorkOrder(tenant, task.workOrderId);
  }

  // ---- 四数量与任务汇总 ----

  /**
   * 明细行四数量（实时计算，不落任务子表——文档 1.4）：
   *  - 已发 = 有效（active）记录明细累计；
   *  - 待发 = max(总需求 − 已发, 0)；
   *  - 已预占：part/standard/electrical = 端口按（工作令+设备+物料）锚点汇总；
   *    equipment = 需求行（利用库存 + 采购入库完成）；
   *  - 当前可发：part = 预占 − 已发（负数=数据错误，确认时阻断）；standard/
   *    electrical = min(预占 + 料品可用, 待发)；equipment = min(待发, max(0,
   *    预占 − 已发))。
   */
  private async lineQuantities(
    tenant: TenantId,
    task: IssueTask,
    taskLines: readonly IssueTaskLine[],
  ): Promise<readonly IssueLineQuantities[]> {
    const activeRecords = (await this.records.list(tenant, { taskId: task.id })).filter(
      (record) => record.state === 'active',
    );
    const issuedByLine = new Map<string, number>();
    for (const record of activeRecords) {
      for (const line of record.lines) {
        issuedByLine.set(line.taskLineId, (issuedByLine.get(line.taskLineId) ?? 0) + line.thisQty);
      }
    }

    // 预占锚点查询（part/standard/electrical 合并批查）与 equipment 需求行读取。
    const anchorItemIds = [
      ...new Set(
        taskLines
          .filter((line) => line.kind !== 'equipment' && line.itemId !== null)
          .map((line) => line.itemId as string),
      ),
    ];
    const reservedMap =
      anchorItemIds.length === 0
        ? new Map<string, number>()
        : await this.material.reservedQtyOf(tenant, {
            workOrderId: task.workOrderId,
            equipmentRef: task.equipmentRef,
            itemIds: anchorItemIds,
          });
    const availableMap =
      anchorItemIds.length === 0
        ? new Map<string, number>()
        : await this.material.availableQtyOf(tenant, anchorItemIds);
    const hasEquipmentLines = taskLines.some((line) => line.kind === 'equipment');
    const demandBySourceLine = new Map(
      hasEquipmentLines
        ? (await this.demandSource.demandLines(tenant, task.workOrderId)).map((line) => [
            line.listingLineId,
            line,
          ])
        : [],
    );

    return taskLines.map((line) => {
      const issuedQty = issuedByLine.get(line.id) ?? 0;
      const pendingQty = Math.max(line.requiredQty - issuedQty, 0);
      if (line.kind === 'equipment') {
        const demand = demandBySourceLine.get(line.sourceLineId);
        const reservedQty = (demand?.useInventoryQty ?? 0) + (demand?.inboundCompletedQty ?? 0);
        return {
          lineId: line.id,
          kind: line.kind,
          requiredQty: line.requiredQty,
          issuedQty,
          pendingQty,
          reservedQty,
          availableNowQty: Math.min(pendingQty, Math.max(0, reservedQty - issuedQty)),
        };
      }
      const reservedQty = line.itemId === null ? 0 : (reservedMap.get(line.itemId) ?? 0);
      if (line.kind === 'part') {
        return {
          lineId: line.id,
          kind: line.kind,
          requiredQty: line.requiredQty,
          issuedQty,
          pendingQty,
          reservedQty,
          availableNowQty: reservedQty - issuedQty,
        };
      }
      const itemAvailable = line.itemId === null ? 0 : (availableMap.get(line.itemId) ?? 0);
      return {
        lineId: line.id,
        kind: line.kind,
        requiredQty: line.requiredQty,
        issuedQty,
        pendingQty,
        reservedQty,
        availableNowQty: Math.min(reservedQty + itemAvailable, pendingQty),
      };
    });
  }

  /**
   * 任务汇总重算（refreshTaskSummary 口径，文档 1.5）：
   *  - 未开始：已发合计为 0（无有效发料记录）；
   *  - 已完成：参与类别行全部 已发 ≥ 总需求（装配=part+standard；电气=
   *    electrical；归拢=equipment）；
   *  - 发料中：其余（已发 > 0 且参与类别仍有未完成行）；
   *  - 进度合计覆盖全部有效明细行（含非参与类别行——按任务实际存在类别；
   *    生产发料不含 aftermarket origin 行——sync 已排除）。
   */
  private async refreshTaskSummary(
    tenant: TenantId,
    taskId: string,
  ): Promise<{
    readonly task: IssueTask;
    readonly state: IssueTaskState;
    readonly totalRequiredQty: number;
    readonly totalIssuedQty: number;
  }> {
    const task = await this.tasks.find(tenant, taskId);
    if (task === null) {
      throw new IssueNotFoundError(`租户 '${tenant}' 内不存在发料任务 '${taskId}'（汇总重算锚点丢失）`);
    }
    const taskLines = await this.taskLines.listByTask(tenant, taskId);
    const quantities = await this.lineQuantities(tenant, task, taskLines);
    const totalRequiredQty = quantities.reduce((sum, entry) => sum + entry.requiredQty, 0);
    const totalIssuedQty = quantities.reduce((sum, entry) => sum + entry.issuedQty, 0);
    const hasIssued = totalIssuedQty > 0;
    const participates = participationKinds(task.dispatchKind, task.rollup);
    const relevant = quantities.filter((entry) => participates.includes(entry.kind));
    const done = relevant.length > 0 && relevant.every((entry) => entry.issuedQty >= entry.requiredQty);
    const state: IssueTaskState = done ? 'done' : hasIssued ? 'issuing' : 'not-started';
    const finishedAt = done ? (task.finishedAt ?? this.now()) : null;
    let refreshed = task;
    if (
      state !== task.state ||
      totalRequiredQty !== task.totalRequiredQty ||
      totalIssuedQty !== task.totalIssuedQty ||
      finishedAt !== task.finishedAt
    ) {
      const updated = await this.tasks.refreshSummary(tenant, task.id, task.objectVersion, {
        state,
        totalRequiredQty,
        totalIssuedQty,
        finishedAt,
      });
      if (updated === null) {
        throw new IssueStateError(
          `任务 '${task.taskNo}' 汇总写入冲突：期望 objectVersion=${task.objectVersion}（并发确认/撤销窗口），须人工对账`,
        );
      }
      refreshed = updated;
    }
    return { task: refreshed, state, totalRequiredQty, totalIssuedQty };
  }

  // ---- 私有辅助 ----

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<IssueCommand>): {
    eventId: EventId;
    tenant: TenantId;
    occurredAt: string;
    provenance: IssueEventProvenance;
  } {
    return {
      eventId: EventId.create(newDomainEventId()),
      tenant: envelope.tenantId,
      occurredAt: this.now(),
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    };
  }

  /** 端口面系统信封（dispatch 同步钩子等兄弟模块联动指令——操作者记系统账号）。 */
  private systemEnvelope(tenant: TenantId, kind: IssueCommandKind, payload: unknown): CommandEnvelope<IssueCommand> {
    const operationId = OperationId.create(`sys-issue-${newDomainEventId()}`);
    return makeCommandEnvelope<IssueCommand>({
      tenantId: tenant,
      issuedBy: UserId.create('u-system-issue'),
      operationId,
      expectedRevision: 'initial',
      issuedAt: this.now(),
      command: { kind, payload },
    });
  }
}

/** 库位分配回执数组形状（issueStock 回执的 allocations 段）。 */
type IssueStockAllocations = readonly {
  readonly locationId: string;
  readonly quantity: number;
  readonly reservedConsumedQty: number;
  readonly availableConsumedQty: number;
}[];

/** 去发料页查询入参（service 面；HTTP 解析见 issue-input parseIssueDetailQuery）。 */
export interface IssueDetailQueryInput {
  readonly lineKind: IssueLineKind | undefined;
  readonly moduleName: string | undefined;
  readonly name: string | undefined;
  readonly pendingFilter: 'partial' | 'all-available' | 'none' | undefined;
  readonly current: number;
  readonly size: number;
}
