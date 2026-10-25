/**
 * issue 存储端口的内存先行实现（U1）。
 *
 * 重启即失；PG 实现在 business-store（`./issue` 子路径，总控合流接线）。与
 * in-memory-listing-stores 同一形态：无 DATABASE_URL / 未注入存储时组合根回落
 * 到这里，保证零 DB boot 语义完整。全部读操作按租户收口；appendMissing 按
 * (tenant, taskId, sourceLineId) 去重；refreshSummary/revoke 带乐观版本检查
 * （与 PG 实现同一合同）。
 */
import {
  TenantId,
  UserId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import { IssueConflictError } from './issue-errors.js';
import type {
  AppendIssueTaskLineInput,
  CreateIssueExpressInput,
  CreateIssueRecordInput,
  CreateIssueTaskInput,
  IssueDomainEventStore,
  IssueExpress,
  IssueExpressStore,
  IssueOperationRecord,
  IssueOperationStore,
  IssueRecord,
  IssueRecordStore,
  IssueTask,
  IssueTaskLine,
  IssueTaskLineStore,
  IssueTaskStore,
  ListIssueRecordsFilter,
  ListIssueTasksFilter,
  RefreshIssueTaskSummaryInput,
} from './issue-stores.js';

// ---- 发料任务（投影，乐观 refreshSummary） ----

interface TaskRow {
  readonly tenant: string;
  readonly id: string;
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: string;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  state: string;
  objectVersion: number;
  readonly plannedStartAt: string | null;
  readonly plannedEndAt: string | null;
  readonly operators: string[];
  readonly triggerRefs: { type: string; id: string }[];
  totalRequiredQty: number;
  totalIssuedQty: number;
  finishedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
  /** 内存形态插入序号：同毫秒并列时的稳定 tiebreak。 */
  readonly seq: number;
}

let taskSeq = 0;

function dimensionKeyOf(dimension: {
  workOrderId: string;
  dispatchKind: string;
  rollup: boolean;
  equipmentRef: string | null;
}): string {
  return `${dimension.workOrderId}|${dimension.dispatchKind}|${dimension.rollup ? 'rollup' : dimension.equipmentRef ?? ''}`;
}

function toTask(row: TaskRow): IssueTask {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    taskNo: row.taskNo,
    workOrderId: row.workOrderId,
    workOrderLabel: row.workOrderLabel,
    dispatchKind: row.dispatchKind as IssueTask['dispatchKind'],
    rollup: row.rollup,
    equipmentRef: row.equipmentRef,
    state: row.state as IssueTask['state'],
    objectVersion: row.objectVersion,
    plannedStartAt: row.plannedStartAt,
    plannedEndAt: row.plannedEndAt,
    operators: [...row.operators],
    triggerRefs: row.triggerRefs.map((ref) => ({ ...ref })),
    totalRequiredQty: row.totalRequiredQty,
    totalIssuedQty: row.totalIssuedQty,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryIssueTaskStore implements IssueTaskStore {
  private readonly rows = new Map<string, TaskRow>(); // key: `${tenant}|${id}`

  async create(input: CreateIssueTaskInput): Promise<IssueTask> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new IssueConflictError(`发料任务 '${input.id}' 已存在`);
    }
    const dimensionKey = dimensionKeyOf(input);
    for (const row of this.rows.values()) {
      if (row.tenant === input.tenant && dimensionKeyOf(row) === dimensionKey) {
        throw new IssueConflictError(
          `同维度发料任务已存在（${row.taskNo}）：工作令 '${input.workOrderId}' + ${input.dispatchKind}${input.rollup ? ' + 归拢' : ` + 设备 '${input.equipmentRef}'`}`,
        );
      }
    }
    const now = new Date().toISOString();
    taskSeq += 1;
    const row: TaskRow = {
      tenant: input.tenant,
      id: input.id,
      taskNo: input.taskNo,
      workOrderId: input.workOrderId,
      workOrderLabel: input.workOrderLabel,
      dispatchKind: input.dispatchKind,
      rollup: input.rollup,
      equipmentRef: input.equipmentRef,
      state: 'not-started',
      objectVersion: 1,
      plannedStartAt: input.plannedStartAt,
      plannedEndAt: input.plannedEndAt,
      operators: [...input.operators],
      triggerRefs: input.triggerRefs.map((ref) => ({ ...ref })),
      totalRequiredQty: 0,
      totalIssuedQty: 0,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      seq: taskSeq,
    };
    this.rows.set(key, row);
    return toTask(row);
  }

  async find(tenant: TenantId, id: string): Promise<IssueTask | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toTask(row);
  }

  async findByDimension(
    tenant: TenantId,
    dimension: {
      readonly workOrderId: string;
      readonly dispatchKind: IssueTask['dispatchKind'];
      readonly rollup: boolean;
      readonly equipmentRef: string | null;
    },
  ): Promise<IssueTask | null> {
    const dimensionKey = dimensionKeyOf(dimension);
    for (const row of this.rows.values()) {
      if (row.tenant === tenant && dimensionKeyOf(row) === dimensionKey) return toTask(row);
    }
    return null;
  }

  async list(tenant: TenantId, filter?: ListIssueTasksFilter): Promise<readonly IssueTask[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant)
      .filter(
        (row) =>
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId) &&
          (filter?.dispatchKind === undefined || row.dispatchKind === filter.dispatchKind) &&
          (filter?.equipmentRef === undefined || row.equipmentRef === filter.equipmentRef) &&
          (filter?.rollup === undefined || row.rollup === filter.rollup),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq)
      .map(toTask);
  }

  async refreshSummary(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    summary: RefreshIssueTaskSummaryInput,
  ): Promise<IssueTask | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    row.state = summary.state;
    row.totalRequiredQty = summary.totalRequiredQty;
    row.totalIssuedQty = summary.totalIssuedQty;
    row.finishedAt = summary.finishedAt;
    row.objectVersion += 1;
    row.updatedAt = new Date().toISOString();
    return toTask(row);
  }

  async delete(tenant: TenantId, id: string): Promise<boolean> {
    return this.rows.delete(`${tenant}|${id}`);
  }
}

// ---- 任务明细行（投影，(taskId, sourceLineId) 去重补全） ----

interface TaskLineRow {
  readonly tenant: string;
  readonly id: string;
  readonly taskId: string;
  readonly lineNo: number;
  readonly kind: string;
  readonly sourceLineId: string;
  readonly itemId: string | null;
  readonly moduleName: string | null;
  readonly name: string | null;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly createdAt: string;
}

function toTaskLine(row: TaskLineRow): IssueTaskLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    taskId: row.taskId,
    lineNo: row.lineNo,
    kind: row.kind as IssueTaskLine['kind'],
    sourceLineId: row.sourceLineId,
    itemId: row.itemId,
    moduleName: row.moduleName,
    name: row.name,
    drawingNo: row.drawingNo,
    requiredQty: row.requiredQty,
    createdAt: row.createdAt,
  };
}

export class InMemoryIssueTaskLineStore implements IssueTaskLineStore {
  private readonly rows = new Map<string, TaskLineRow>(); // key: `${tenant}|${id}`

  private sourceKeyOf(tenant: TenantId, taskId: string, sourceLineId: string): string {
    return `${tenant}|${taskId}|${sourceLineId}`;
  }

  async appendMissing(
    tenant: TenantId,
    taskId: string,
    lines: readonly AppendIssueTaskLineInput[],
  ): Promise<{ readonly appended: readonly IssueTaskLine[]; readonly all: readonly IssueTaskLine[] }> {
    const existingSourceKeys = new Set(
      [...this.rows.values()]
        .filter((row) => row.tenant === tenant && row.taskId === taskId)
        .map((row) => this.sourceKeyOf(tenant, taskId, row.sourceLineId)),
    );
    let nextLineNo =
      [...this.rows.values()].filter((row) => row.tenant === tenant && row.taskId === taskId).length + 1;
    const appended: TaskLineRow[] = [];
    const now = new Date().toISOString();
    for (const line of lines) {
      const sourceKey = this.sourceKeyOf(tenant, taskId, line.sourceLineId);
      if (existingSourceKeys.has(sourceKey)) continue; // 既有行不动（幂等补全）
      existingSourceKeys.add(sourceKey);
      const row: TaskLineRow = {
        tenant,
        id: line.id,
        taskId,
        lineNo: nextLineNo,
        kind: line.kind,
        sourceLineId: line.sourceLineId,
        itemId: line.itemId,
        moduleName: line.moduleName,
        name: line.name,
        drawingNo: line.drawingNo,
        requiredQty: line.requiredQty,
        createdAt: now,
      };
      nextLineNo += 1;
      appended.push(row);
      this.rows.set(`${tenant}|${line.id}`, row);
    }
    const all = await this.listByTask(tenant, taskId);
    return { appended: appended.map(toTaskLine), all };
  }

  async listByTask(tenant: TenantId, taskId: string): Promise<readonly IssueTaskLine[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.taskId === taskId)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(toTaskLine);
  }

  async deleteByTask(tenant: TenantId, taskId: string): Promise<number> {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (row.tenant === tenant && row.taskId === taskId) {
        this.rows.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

// ---- 发料记录（投影：快照载荷 + 撤销态） ----

interface RecordRow {
  readonly tenant: string;
  readonly id: string;
  readonly recordNo: string;
  readonly taskId: string;
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: string;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  readonly lineKind: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly totalQty: number;
  readonly expressId: string | null;
  state: string;
  revokedAt: string | null;
  revokedBy: string | null;
  readonly lines: IssueRecord['lines'];
  objectVersion: number;
  readonly createdAt: string;
  updatedAt: string;
  /** 内存形态插入序号：同毫秒并列时的稳定 tiebreak。 */
  readonly seq: number;
}

let recordSeq = 0;

function toRecord(row: RecordRow): IssueRecord {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    recordNo: row.recordNo,
    taskId: row.taskId,
    taskNo: row.taskNo,
    workOrderId: row.workOrderId,
    workOrderLabel: row.workOrderLabel,
    dispatchKind: row.dispatchKind as IssueRecord['dispatchKind'],
    rollup: row.rollup,
    equipmentRef: row.equipmentRef,
    lineKind: row.lineKind as IssueRecord['lineKind'],
    issuedAt: row.issuedAt,
    issuedBy: UserId.create(row.issuedBy),
    totalQty: row.totalQty,
    expressId: row.expressId,
    state: row.state as IssueRecord['state'],
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy === null ? null : UserId.create(row.revokedBy),
    lines: row.lines.map((line) => ({
      ...line,
      allocations: line.allocations.map((allocation) => ({ ...allocation })),
    })),
    objectVersion: row.objectVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryIssueRecordStore implements IssueRecordStore {
  private readonly rows = new Map<string, RecordRow>(); // key: `${tenant}|${id}`

  async create(input: CreateIssueRecordInput): Promise<IssueRecord> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new IssueConflictError(`发料记录 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    recordSeq += 1;
    const row: RecordRow = {
      tenant: input.tenant,
      id: input.id,
      recordNo: input.recordNo,
      taskId: input.taskId,
      taskNo: input.taskNo,
      workOrderId: input.workOrderId,
      workOrderLabel: input.workOrderLabel,
      dispatchKind: input.dispatchKind,
      rollup: input.rollup,
      equipmentRef: input.equipmentRef,
      lineKind: input.lineKind,
      issuedAt: input.issuedAt,
      issuedBy: input.issuedBy,
      totalQty: input.totalQty,
      expressId: input.expressId,
      state: 'active',
      revokedAt: null,
      revokedBy: null,
      lines: input.lines,
      objectVersion: 1,
      createdAt: now,
      updatedAt: now,
      seq: recordSeq,
    };
    this.rows.set(key, row);
    return toRecord(row);
  }

  async find(tenant: TenantId, id: string): Promise<IssueRecord | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toRecord(row);
  }

  async list(tenant: TenantId, filter?: ListIssueRecordsFilter): Promise<readonly IssueRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant)
      .filter(
        (row) =>
          (filter?.taskId === undefined || row.taskId === filter.taskId) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId) &&
          (filter?.state === undefined || row.state === filter.state),
      )
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.seq - a.seq)
      .map(toRecord);
  }

  async revoke(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    revokedAt: string,
    revokedBy: UserId,
  ): Promise<IssueRecord | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion || row.state !== 'active') return null;
    row.state = 'revoked';
    row.revokedAt = revokedAt;
    row.revokedBy = revokedBy;
    row.objectVersion += 1;
    row.updatedAt = new Date().toISOString();
    return toRecord(row);
  }
}

// ---- 快递单（发货头元数据投影） ----

interface ExpressRow {
  readonly tenant: string;
  readonly id: string;
  readonly trackingNo: string;
  readonly shipper: string;
  readonly shipTime: string;
  readonly imageRefs: string[];
  readonly workOrderId: string | null;
  readonly taskId: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toExpress(row: ExpressRow): IssueExpress {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    trackingNo: row.trackingNo,
    shipper: row.shipper,
    shipTime: row.shipTime,
    imageRefs: [...row.imageRefs],
    workOrderId: row.workOrderId,
    taskId: row.taskId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryIssueExpressStore implements IssueExpressStore {
  private readonly rows = new Map<string, ExpressRow>(); // key: `${tenant}|${id}`

  async create(input: CreateIssueExpressInput): Promise<IssueExpress> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new IssueConflictError(`快递单 '${input.id}' 已存在`);
    }
    for (const row of this.rows.values()) {
      if (
        row.tenant === input.tenant &&
        row.trackingNo === input.trackingNo &&
        (row.workOrderId ?? '') === (input.workOrderId ?? '')
      ) {
        throw new IssueConflictError(
          `快递单号 '${input.trackingNo}' 已存在（工作令 '${input.workOrderId ?? '无'}' 下唯一）`,
        );
      }
    }
    const now = new Date().toISOString();
    const row: ExpressRow = {
      tenant: input.tenant,
      id: input.id,
      trackingNo: input.trackingNo,
      shipper: input.shipper,
      shipTime: input.shipTime,
      imageRefs: [...input.imageRefs],
      workOrderId: input.workOrderId,
      taskId: input.taskId,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toExpress(row);
  }

  async find(tenant: TenantId, id: string): Promise<IssueExpress | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toExpress(row);
  }

  async findByNo(tenant: TenantId, workOrderId: string | null, trackingNo: string): Promise<IssueExpress | null> {
    for (const row of this.rows.values()) {
      if (
        row.tenant === tenant &&
        row.trackingNo === trackingNo &&
        (row.workOrderId ?? '') === (workOrderId ?? '')
      ) {
        return toExpress(row);
      }
    }
    return null;
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly IssueExpress[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.workOrderId === workOrderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toExpress);
  }

  async delete(tenant: TenantId, id: string): Promise<boolean> {
    return this.rows.delete(`${tenant}|${id}`);
  }
}

// ---- 命令幂等记账 ----

export class InMemoryIssueOperationStore implements IssueOperationStore {
  private readonly rows = new Map<string, IssueOperationRecord>(); // key: `${tenant}|${operationId}`

  async record(entry: IssueOperationRecord): Promise<IssueOperationRecord | null> {
    const key = `${entry.tenant}|${entry.operationId}`;
    if (this.rows.has(key)) return null; // 已落账 → 幂等拒绝（端口合同）
    this.rows.set(key, entry);
    return entry;
  }
}

// ---- 域事件（BusinessEvent + Outbox） ----

interface StoredDomainEvent {
  readonly seq: number;
  readonly event: BusinessEvent;
}

export class InMemoryIssueDomainEventStore implements IssueDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new IssueConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
    }
    this.events.push({ seq: this.events.length + 1, event });
    const record: OutboxRecord = {
      eventId: event.eventId,
      createdAt: event.occurredAt,
      attempts: 0,
      deliveredAt: null,
    };
    this.outbox.set(event.eventId, record);
    return record;
  }

  async byAggregate(
    aggregate: { readonly id: string; readonly type: string },
  ): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter(({ event }) => event.aggregate.id === aggregate.id && event.aggregate.type === aggregate.type)
      .sort((a, b) => a.seq - b.seq)
      .map(({ event }) => event);
  }

  async pendingOutbox(): Promise<readonly OutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((row) => row.deliveredAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async markDelivered(eventId: EventId, deliveredAt: string): Promise<void> {
    const row = this.outbox.get(eventId);
    if (row === undefined) return;
    this.outbox.set(eventId, { ...row, deliveredAt });
  }
}

/** 组装全套内存存储（测试/零 DB boot 组合根便捷面）。 */
export function createInMemoryIssueStores(): {
  readonly taskStore: InMemoryIssueTaskStore;
  readonly taskLineStore: InMemoryIssueTaskLineStore;
  readonly recordStore: InMemoryIssueRecordStore;
  readonly expressStore: InMemoryIssueExpressStore;
  readonly operationStore: InMemoryIssueOperationStore;
  readonly domainEventStore: InMemoryIssueDomainEventStore;
} {
  return {
    taskStore: new InMemoryIssueTaskStore(),
    taskLineStore: new InMemoryIssueTaskLineStore(),
    recordStore: new InMemoryIssueRecordStore(),
    expressStore: new InMemoryIssueExpressStore(),
    operationStore: new InMemoryIssueOperationStore(),
    domainEventStore: new InMemoryIssueDomainEventStore(),
  };
}
