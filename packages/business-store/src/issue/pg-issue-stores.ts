/**
 * issue 六端口的 PG 实现 + 组合根装配工厂（U1，经本包 `./issue` 子路径导出
 * ——与 `./listing` 同模式：主入口保持零 @prisma/client 依赖；子路径登记归
 * 总控合流）。启动零 DB 依赖：connectIssueStore 只构造 PrismaClient（惰性
 * 连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 六个实现（表 ↔ 端口分工见 prisma/schema.prisma issue 节与迁移头注）：
 *  - PgIssueTaskStore         → issue_tasks 投影（(tenant, dimension_key) 唯一，
 *                               P2002 → IssueConflictError；refreshSummary 乐观）
 *  - PgIssueTaskLineStore     → issue_task_lines 投影（appendMissing 按
 *                               (tenant, task, source_line_id) 去重续排）
 *  - PgIssueRecordStore       → issue_records 投影（lines JSONB 快照；revoke 乐观）
 *  - PgIssueExpressStore      → issue_expresses 投影（(工作令空值收敛, 单号)
 *                               唯一性由 Service 层 find-or-create 收口）
 *  - PgIssueOperationStore    → issue_operations 幂等记账（PK=租户|operationId，
 *                               P2002 = 已落账 → record 返回 null）
 *  - PgIssueDomainEventStore  → 域事件 + Outbox 同事务落账（**复用既有
 *                               event_records / outbox_records**，不建新表）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  EventId,
  TenantId,
  UserId,
  type BusinessEvent,
  type OutboxRecord,
} from '@smes/business-core';
import {
  IssueConflictError,
  type AppendIssueTaskLineInput,
  type CreateIssueExpressInput,
  type CreateIssueRecordInput,
  type CreateIssueTaskInput,
  type IssueDomainEventStore,
  type IssueExpress,
  type IssueExpressStore,
  type IssueOperationRecord,
  type IssueOperationStore,
  type IssueRecord,
  type IssueRecordLineSnapshot,
  type IssueRecordStore,
  type IssueTask,
  type IssueTaskLine,
  type IssueTaskLineStore,
  type IssueTaskStore,
  type ListIssueRecordsFilter,
  type ListIssueTasksFilter,
  type RefreshIssueTaskSummaryInput,
  type IssueTriggerRef,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { uuidv7 } from '../ids/uuidv7.js';

// ---- 小工具（同 listing 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** 维度拼键（工作令|派工类型|归拢|设备引用——归拢行空值收敛，见 schema 节注）。 */
function dimensionKeyOf(dimension: {
  readonly workOrderId: string;
  readonly dispatchKind: string;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
}): string {
  return `${dimension.workOrderId}|${dimension.dispatchKind}|${dimension.rollup ? 'rollup' : dimension.equipmentRef ?? ''}`;
}

// ---- 发料任务（投影） ----

interface TaskDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: string;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  readonly state: string;
  readonly objectVersion: number;
  readonly plannedStartAt: Date | null;
  readonly plannedEndAt: Date | null;
  readonly operators: unknown;
  readonly triggerRefs: unknown;
  readonly totalRequiredQty: number;
  readonly totalIssuedQty: number;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toTask(row: TaskDbRow): IssueTask {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    taskNo: row.taskNo,
    workOrderId: row.workOrderId,
    workOrderLabel: row.workOrderLabel,
    dispatchKind: row.dispatchKind as IssueTask['dispatchKind'],
    rollup: row.rollup,
    equipmentRef: row.equipmentRef,
    state: row.state as IssueTask['state'],
    objectVersion: row.objectVersion,
    plannedStartAt: row.plannedStartAt === null ? null : row.plannedStartAt.toISOString(),
    plannedEndAt: row.plannedEndAt === null ? null : row.plannedEndAt.toISOString(),
    operators: (row.operators as string[]) ?? [],
    triggerRefs: ((row.triggerRefs as IssueTriggerRef[]) ?? []).map((ref) => ({ ...ref })),
    totalRequiredQty: row.totalRequiredQty,
    totalIssuedQty: row.totalIssuedQty,
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgIssueTaskStore implements IssueTaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateIssueTaskInput): Promise<IssueTask> {
    try {
      const row = await this.prisma.issueTaskRecord.create({
        data: {
          id: uuidv7(), // 应用侧权威生成（本包 id 策略）
          tenantId: input.tenant,
          taskNo: input.taskNo,
          workOrderId: input.workOrderId,
          workOrderLabel: input.workOrderLabel,
          dispatchKind: input.dispatchKind,
          rollup: input.rollup,
          equipmentRef: input.equipmentRef,
          dimensionKey: dimensionKeyOf(input),
          state: 'not-started',
          objectVersion: 1,
          ...(input.plannedStartAt === null ? {} : { plannedStartAt: new Date(input.plannedStartAt) }),
          ...(input.plannedEndAt === null ? {} : { plannedEndAt: new Date(input.plannedEndAt) }),
          operators: json([...input.operators]),
          triggerRefs: json(input.triggerRefs.map((ref) => ({ ...ref }))),
        },
      });
      return toTask(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IssueConflictError(
          `同维度发料任务已存在（工作令 '${input.workOrderId}' + ${input.dispatchKind}${input.rollup ? ' + 归拢' : ` + 设备 '${input.equipmentRef}'`}）`,
        );
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<IssueTask | null> {
    const row = await this.prisma.issueTaskRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toTask(row);
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
    const row = await this.prisma.issueTaskRecord.findFirst({
      where: {
        tenantId: tenant,
        dimensionKey: dimensionKeyOf(dimension),
      },
    });
    return row === null ? null : toTask(row);
  }

  async list(tenant: TenantId, filter?: ListIssueTasksFilter): Promise<readonly IssueTask[]> {
    const rows = await this.prisma.issueTaskRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
        ...(filter?.dispatchKind === undefined ? {} : { dispatchKind: filter.dispatchKind }),
        ...(filter?.equipmentRef === undefined ? {} : { equipmentRef: filter.equipmentRef }),
        ...(filter?.rollup === undefined ? {} : { rollup: filter.rollup }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // 新的在前（id tiebreak，与内存实现同序口径）
    });
    return rows.map(toTask);
  }

  async refreshSummary(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    summary: RefreshIssueTaskSummaryInput,
  ): Promise<IssueTask | null> {
    const updated = await this.prisma.issueTaskRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: summary.state,
        totalRequiredQty: summary.totalRequiredQty,
        totalIssuedQty: summary.totalIssuedQty,
        ...(summary.finishedAt === null ? { finishedAt: null } : { finishedAt: new Date(summary.finishedAt) }),
        objectVersion: expectedObjectVersion + 1,
      },
    });
    if (updated.count === 0) {
      // 端口合同：乐观写未命中（不存在/版本不符/并发窗口）返回 null——不读回
      // 旧行（旧 objectVersion 会让上层误判为成功写入）；与内存实现同口径。
      return null;
    }
    const row = await this.prisma.issueTaskRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toTask(row);
  }

  async delete(tenant: TenantId, id: string): Promise<boolean> {
    const deleted = await this.prisma.issueTaskRecord.deleteMany({ where: { tenantId: tenant, id } });
    return deleted.count > 0;
  }
}

// ---- 任务明细行（投影，去重补全） ----

interface TaskLineDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly lineNo: number;
  readonly kind: string;
  readonly sourceLineId: string;
  readonly itemId: string | null;
  readonly moduleName: string | null;
  readonly name: string | null;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly createdAt: Date;
}

function toTaskLine(row: TaskLineDbRow): IssueTaskLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    taskId: row.taskId,
    lineNo: row.lineNo,
    kind: row.kind as IssueTaskLine['kind'],
    sourceLineId: row.sourceLineId,
    itemId: row.itemId,
    moduleName: row.moduleName,
    name: row.name,
    drawingNo: row.drawingNo,
    requiredQty: row.requiredQty,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgIssueTaskLineStore implements IssueTaskLineStore {
  constructor(private readonly prisma: PrismaClient) {}

  async appendMissing(
    tenant: TenantId,
    taskId: string,
    lines: readonly AppendIssueTaskLineInput[],
  ): Promise<{ readonly appended: readonly IssueTaskLine[]; readonly all: readonly IssueTaskLine[] }> {
    const existing = await this.prisma.issueTaskLineRecord.findMany({
      where: { tenantId: tenant, taskId },
      select: { sourceLineId: true },
    });
    const existingSourceIds = new Set(existing.map((row) => row.sourceLineId));
    const fresh = lines.filter((line) => !existingSourceIds.has(line.sourceLineId));
    if (fresh.length > 0) {
      await this.prisma.issueTaskLineRecord.createMany({
        data: fresh.map((line, index) => ({
          id: line.id, // 应用侧生成（itl-<uuidv7>）
          tenantId: tenant,
          taskId,
          lineNo: existing.length + index + 1, // 续排
          kind: line.kind,
          sourceLineId: line.sourceLineId,
          itemId: line.itemId,
          moduleName: line.moduleName,
          name: line.name,
          drawingNo: line.drawingNo,
          requiredQty: line.requiredQty,
        })),
      });
    }
    const all = await this.listByTask(tenant, taskId);
    const appendedIds = new Set(fresh.map((line) => line.id));
    return { appended: all.filter((line) => appendedIds.has(line.id)), all };
  }

  async listByTask(tenant: TenantId, taskId: string): Promise<readonly IssueTaskLine[]> {
    const rows = await this.prisma.issueTaskLineRecord.findMany({
      where: { tenantId: tenant, taskId },
      orderBy: [{ lineNo: 'asc' }],
    });
    return rows.map(toTaskLine);
  }

  async deleteByTask(tenant: TenantId, taskId: string): Promise<number> {
    const deleted = await this.prisma.issueTaskLineRecord.deleteMany({
      where: { tenantId: tenant, taskId },
    });
    return deleted.count;
  }
}

// ---- 发料记录（投影：快照 + 撤销态） ----

interface RecordDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly recordNo: string;
  readonly taskId: string;
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: string;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  readonly lineKind: string;
  readonly issuedAt: Date;
  readonly issuedBy: string;
  readonly totalQty: number;
  readonly expressId: string | null;
  readonly state: string;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly lines: unknown;
  readonly objectVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: RecordDbRow): IssueRecord {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    recordNo: row.recordNo,
    taskId: row.taskId,
    taskNo: row.taskNo,
    workOrderId: row.workOrderId,
    workOrderLabel: row.workOrderLabel,
    dispatchKind: row.dispatchKind as IssueRecord['dispatchKind'],
    rollup: row.rollup,
    equipmentRef: row.equipmentRef,
    lineKind: row.lineKind as IssueRecord['lineKind'],
    issuedAt: row.issuedAt.toISOString(),
    issuedBy: UserId.create(row.issuedBy),
    totalQty: row.totalQty,
    expressId: row.expressId,
    state: row.state as IssueRecord['state'],
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    revokedBy: row.revokedBy === null ? null : UserId.create(row.revokedBy),
    lines: ((row.lines as IssueRecordLineSnapshot[]) ?? []).map((line) => ({
      ...line,
      allocations: (line.allocations ?? []).map((allocation) => ({ ...allocation })),
    })),
    objectVersion: row.objectVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgIssueRecordStore implements IssueRecordStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateIssueRecordInput): Promise<IssueRecord> {
    try {
      const row = await this.prisma.issueRecordRecord.create({
        data: {
          id: input.id, // 应用侧生成（irc-<uuidv7>——issueKey 回滚锚点引用其前缀）
          tenantId: input.tenant,
          recordNo: input.recordNo,
          taskId: input.taskId,
          taskNo: input.taskNo,
          workOrderId: input.workOrderId,
          workOrderLabel: input.workOrderLabel,
          dispatchKind: input.dispatchKind,
          rollup: input.rollup,
          equipmentRef: input.equipmentRef,
          lineKind: input.lineKind,
          issuedAt: new Date(input.issuedAt),
          issuedBy: input.issuedBy,
          totalQty: input.totalQty,
          expressId: input.expressId,
          state: 'active',
          lines: json(input.lines.map((line) => ({ ...line, allocations: [...line.allocations] }))),
          objectVersion: 1,
        },
      });
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IssueConflictError(`发料记录 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<IssueRecord | null> {
    const row = await this.prisma.issueRecordRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toRecord(row);
  }

  async list(tenant: TenantId, filter?: ListIssueRecordsFilter): Promise<readonly IssueRecord[]> {
    const rows = await this.prisma.issueRecordRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.taskId === undefined ? {} : { taskId: filter.taskId }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
        ...(filter?.state === undefined ? {} : { state: filter.state }),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], // 新的在前（id tiebreak）
    });
    return rows.map(toRecord);
  }

  async revoke(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    revokedAt: string,
    revokedBy: UserId,
  ): Promise<IssueRecord | null> {
    const updated = await this.prisma.issueRecordRecord.updateMany({
      where: { tenantId: tenant, id, state: 'active', objectVersion: expectedObjectVersion },
      data: {
        state: 'revoked',
        revokedAt: new Date(revokedAt),
        revokedBy,
        objectVersion: expectedObjectVersion + 1,
      },
    });
    if (updated.count === 0) {
      // 端口合同：乐观写未命中（不存在/版本不符/已撤销/并发双撤销窗口）返回
      // null——不读回旧行（service 调用前预检 state、调用后只判 null，读回会让
      // 并发后落者照常走清理/事件路径，污染事件账本）；与内存实现同口径。
      return null;
    }
    const row = await this.prisma.issueRecordRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toRecord(row);
  }
}

// ---- 快递单（发货头元数据投影） ----

interface ExpressDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly trackingNo: string;
  readonly shipper: string;
  readonly shipTime: Date;
  readonly imageRefs: unknown;
  readonly workOrderId: string | null;
  readonly taskId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toExpress(row: ExpressDbRow): IssueExpress {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    trackingNo: row.trackingNo,
    shipper: row.shipper,
    shipTime: row.shipTime.toISOString(),
    imageRefs: (row.imageRefs as string[]) ?? [],
    workOrderId: row.workOrderId,
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgIssueExpressStore implements IssueExpressStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateIssueExpressInput): Promise<IssueExpress> {
    const row = await this.prisma.issueExpressRecord.create({
      data: {
        id: uuidv7(),
        tenantId: input.tenant,
        trackingNo: input.trackingNo,
        shipper: input.shipper,
        shipTime: new Date(input.shipTime),
        imageRefs: json([...input.imageRefs]),
        workOrderId: input.workOrderId,
        taskId: input.taskId,
      },
    });
    return toExpress(row);
  }

  async find(tenant: TenantId, id: string): Promise<IssueExpress | null> {
    const row = await this.prisma.issueExpressRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toExpress(row);
  }

  async findByNo(tenant: TenantId, workOrderId: string | null, trackingNo: string): Promise<IssueExpress | null> {
    // 空值收敛：workOrderId 为 null 时 Prisma 译为 IS NULL（工作令空值收敛匹配）。
    const row = await this.prisma.issueExpressRecord.findFirst({
      where: { tenantId: tenant, workOrderId, trackingNo },
    });
    return row === null ? null : toExpress(row);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly IssueExpress[]> {
    const rows = await this.prisma.issueExpressRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toExpress);
  }

  async delete(tenant: TenantId, id: string): Promise<boolean> {
    const deleted = await this.prisma.issueExpressRecord.deleteMany({ where: { tenantId: tenant, id } });
    return deleted.count > 0;
  }
}

// ---- 命令幂等记账 ----

export class PgIssueOperationStore implements IssueOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: IssueOperationRecord): Promise<IssueOperationRecord | null> {
    try {
      await this.prisma.issueOperationRecord.create({
        data: {
          operationKey: `${entry.tenant}|${entry.operationId}`, // PK = 租户+operationId（应用侧拼键）
          tenantId: entry.tenant,
          operationId: entry.operationId,
          command: entry.command,
          aggregateType: entry.aggregateType,
          aggregateId: entry.aggregateId,
          occurredAt: new Date(entry.occurredAt),
        },
      });
      return entry;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // 已落账 → 幂等拒绝（端口合同）
      throw error;
    }
  }
}

// ---- 域事件（BusinessEvent + Outbox，复用既有 event_records / outbox_records） ----

export class PgIssueDomainEventStore implements IssueDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, row.tenantId);
    try {
      await this.prisma.$transaction([
        this.prisma.businessEventRecord.create({
          data: {
            eventId: row.eventId,
            tenantId: row.tenantId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            aggregateType: row.aggregateType,
            aggregateRevision: row.aggregateRevision,
            occurredAt: row.occurredAt,
            ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
            ...(row.availableTime === undefined ? {} : { availableTime: row.availableTime }),
            ...(row.provenance === undefined ? {} : { provenance: json(row.provenance) }),
            payload: json(row.payload as Readonly<Record<string, unknown>>),
          },
        }),
        this.prisma.outboxRecord.create({
          data: {
            eventId: outbox.eventId,
            tenantId: outbox.tenantId,
            createdAt: outbox.createdAt,
          },
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IssueConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
      }
      throw error;
    }
    return toOutboxRecord(outbox);
  }

  async byAggregate(
    aggregate: { readonly id: string; readonly type: string },
  ): Promise<readonly BusinessEvent[]> {
    // 聚合 id 带模块前缀 uuidv7，全局唯一——端口不带租户参数（发布账本按聚合收口）。
    const rows = await this.prisma.businessEventRecord.findMany({
      where: { aggregateId: aggregate.id, aggregateType: aggregate.type },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }], // eventId=evt-uuidv7 时间序，同毫秒稳定
    });
    return rows.map((row) =>
      fromBusinessEventRow({
        eventId: row.eventId,
        eventType: row.eventType,
        tenantId: TenantId.create(row.tenantId),
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        aggregateRevision: row.aggregateRevision,
        occurredAt: row.occurredAt,
        ...(row.businessTime === null ? {} : { businessTime: row.businessTime }),
        ...(row.availableTime === null ? {} : { availableTime: row.availableTime }),
        ...(row.provenance === null ? {} : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
        payload: row.payload,
      }),
    );
  }

  async pendingOutbox(): Promise<readonly OutboxRecord[]> {
    const rows = await this.prisma.outboxRecord.findMany({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) =>
      toOutboxRecord({
        eventId: row.eventId,
        tenantId: TenantId.create(row.tenantId),
        createdAt: row.createdAt,
        attempts: row.attempts,
        ...(row.lastAttemptAt === null ? {} : { lastAttemptAt: row.lastAttemptAt }),
        ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
        deliveredAt: row.deliveredAt,
      }),
    );
  }

  async markDelivered(eventId: EventId, deliveredAt: string): Promise<void> {
    // Outbox 例外：投递记账可 UPDATE（append-only 触发器对 outbox_records 豁免）。
    await this.prisma.outboxRecord.updateMany({
      where: { eventId },
      data: { deliveredAt: new Date(deliveredAt) },
    });
  }
}

// ---- 组合根装配工厂 ----

export interface IssueStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：issue 六端口实现 + 优雅断连。 */
export interface IssueStoreHandle {
  readonly taskStore: IssueTaskStore;
  readonly taskLineStore: IssueTaskLineStore;
  readonly recordStore: IssueRecordStore;
  readonly expressStore: IssueExpressStore;
  readonly operationStore: IssueOperationStore;
  readonly domainEventStore: IssueDomainEventStore;
  disconnect(): Promise<void>;
}

/** 构造 issue 模块 PG 存储装配（惰性连接：同 `./listing`）。 */
export function connectIssueStore(options: IssueStoreOptions = {}): IssueStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（并入 lane/m4-final 时补齐，与 dispatch/listing 工厂同体例）：
  // 门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    taskStore: new PgIssueTaskStore(client),
    taskLineStore: new PgIssueTaskLineStore(client),
    recordStore: new PgIssueRecordStore(client),
    expressStore: new PgIssueExpressStore(client),
    operationStore: new PgIssueOperationStore(client),
    domainEventStore: new PgIssueDomainEventStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
