/**
 * reporting 五端口的 PG 实现 + 组合根装配工厂（M2-W7，经本包 `./reporting` 子路径
 * 导出——与 `./dispatch` / `./listing` 同模式：主入口保持零 @prisma/client 依赖）。
 * 启动零 DB 依赖：connectReportingStore 只构造 PrismaClient（惰性连接），无
 * DATABASE_URL 时组合根不调用本工厂。
 *
 * 五个实现（表 ↔ 端口分工见 prisma/schema.prisma reporting 节与迁移头注）：
 *  - PgWorkReportStore          → work_reports 投影（五类报工单，advance 乐观
 *                                  可回填核查列；findBySupersedes 支撑修正链
 *                                  导航；list 链尾口径 = 排除被 supersedes 的行）
 *  - PgReportAuditStore         → report_audits 留痕账（append-only 触发器护栏）
 *  - PgReportOperationStore     → reporting_operations 幂等记账（PK=租户|operationId，
 *                                  P2002 = 已落账 → record 返回 null）
 *  - PgReportDomainEventStore   → 域事件 + Outbox 同事务落账（**复用既有
 *                                  event_records / outbox_records**，不建新表）
 *  - PgReportingMachineEventStore → engine-flow ApprovalEventStore（reporting_events
 *                                  账本；work-report 聚合专用，(aggregate_id,
 *                                  aggregate_revision) 唯一 = DB 级乐观锁）
 *
 * 租户解析取舍（同 workorder/listing/dispatch）：engine 机器事件端口不带租户参数
 * ——聚合锚定合同 = 投影行（work_reports），租户经投影行解析（孤儿聚合 fail-fast
 * 拒写）。域事件自带 tenantId，直落 event_records。
 *
 * 已知边界（共享账本既定取舍）：pendingOutbox/markDelivered 作用于全表
 * outbox_records——跨模块共享的投递记账由单例投递器统一扫（口径一致）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import {
  EventId,
  TenantId,
  UserId,
  type BusinessEvent,
  type OutboxRecord,
} from '@smes/business-core';
import {
  makeApprovalEvent,
  type ApprovalEvent,
  type ApprovalEventCursor,
  type ApprovalEventPage,
  type ApprovalEventPayload,
  type ApprovalEventStore,
} from '@smes/engine-flow';
import {
  WORK_REPORT_AGGREGATE_TYPE,
  ReportConflictError,
  type CreateWorkReportInput,
  type ListWorkReportsFilter,
  type ReportAuditRow,
  type ReportAuditStore,
  type ReportDomainEventStore,
  type ReportOperationRecord,
  type ReportOperationStore,
  type WorkReport,
  type WorkReportStore,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';

// ---- 小工具（同 dispatch / listing 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// ---- 行 <-> 领域形状映射 ----

interface WorkReportDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly dispatchId: string;
  readonly kind: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly doneQty: number;
  readonly laborMinutes: number;
  readonly reporter: string;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly supersedes: string | null;
  readonly businessTime: Date;
  readonly verifiedBy: string | null;
  readonly verifiedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
  readonly remark: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToWorkReport(row: WorkReportDbRow): WorkReport {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    dispatchId: row.dispatchId,
    kind: row.kind as WorkReport['kind'],
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    doneQty: row.doneQty,
    laborMinutes: row.laborMinutes,
    reporter: UserId.create(row.reporter),
    workOrderId: row.workOrderId,
    drawingNo: row.drawingNo,
    operationCode: row.operationCode,
    supersedes: row.supersedes,
    businessTime: row.businessTime.toISOString(),
    verifiedBy: row.verifiedBy === null ? null : UserId.create(row.verifiedBy),
    verifiedAt: row.verifiedAt === null ? null : row.verifiedAt.toISOString(),
    revokedBy: row.revokedBy === null ? null : UserId.create(row.revokedBy),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    revokeReason: row.revokeReason,
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface ReportAuditDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly reportId: string;
  readonly action: string;
  readonly actor: string;
  readonly reason: string | null;
  readonly changes: unknown;
  readonly createdAt: Date;
}

export function rowToReportAudit(row: ReportAuditDbRow): ReportAuditRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    reportId: row.reportId,
    action: row.action as ReportAuditRow['action'],
    actor: UserId.create(row.actor),
    reason: row.reason,
    changes: Array.isArray(row.changes)
      ? (row.changes as { field: string; from: unknown; to: unknown }[])
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

interface ReportingEventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToReportingEvent(row: ReportingEventDbRow): ApprovalEvent {
  return makeApprovalEvent({
    eventId: EventId.create(row.eventId),
    eventType: row.eventType,
    aggregate: {
      id: row.aggregateId,
      type: row.aggregateType,
      revision: row.aggregateRevision,
    },
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload as ApprovalEventPayload,
  });
}

// ---- 报工单（application WorkReportStore） ----

export class PgWorkReportStore implements WorkReportStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateWorkReportInput): Promise<WorkReport> {
    try {
      const row = await this.prisma.workReportRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          dispatchId: input.dispatchId,
          kind: input.kind,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          doneQty: input.doneQty,
          laborMinutes: input.laborMinutes,
          reporter: input.reporter,
          workOrderId: input.workOrderId,
          drawingNo: input.drawingNo,
          operationCode: input.operationCode,
          supersedes: input.supersedes,
          businessTime: new Date(input.businessTime),
          remark: input.remark,
        },
      });
      return rowToWorkReport(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReportConflictError(`报工单 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<WorkReport | null> {
    const row = await this.prisma.workReportRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToWorkReport(row);
  }

  async findBySupersedes(tenant: TenantId, supersedesId: string): Promise<readonly WorkReport[]> {
    const rows = await this.prisma.workReportRecord.findMany({
      where: { tenantId: tenant, supersedes: supersedesId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(rowToWorkReport);
  }

  async list(tenant: TenantId, filter?: ListWorkReportsFilter): Promise<readonly WorkReport[]> {
    // 链尾口径（端口合同）：先收同租户被 supersedes 的 id 集，再排除——租户内
    // 修正链密度低（两步取数可接受）；数据量增长后可换 NOT IN 子查询原生 SQL。
    const supersededRows = await this.prisma.workReportRecord.findMany({
      where: { tenantId: tenant, supersedes: { not: null } },
      select: { supersedes: true },
    });
    const supersededIds = [
      ...new Set(supersededRows.map((row) => row.supersedes).filter((value): value is string => value !== null)),
    ];
    const rows = await this.prisma.workReportRecord.findMany({
      where: {
        tenantId: tenant,
        ...(supersededIds.length === 0 ? {} : { id: { notIn: supersededIds } }),
        ...(filter?.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.dispatchId === undefined ? {} : { dispatchId: filter.dispatchId }),
        ...(filter?.reporter === undefined ? {} : { reporter: filter.reporter }),
        ...(filter?.drawingNo === undefined ? {} : { drawingNo: filter.drawingNo }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToWorkReport);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly verifiedBy?: UserId;
      readonly verifiedAt?: string;
      readonly revokedBy?: UserId;
      readonly revokedAt?: string;
      readonly revokeReason?: string | null;
    },
  ): Promise<WorkReport> {
    const updated = await this.prisma.workReportRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.verifiedBy === undefined ? {} : { verifiedBy: extra.verifiedBy }),
        ...(extra?.verifiedAt === undefined ? {} : { verifiedAt: new Date(extra.verifiedAt) }),
        ...(extra?.revokedBy === undefined ? {} : { revokedBy: extra.revokedBy }),
        ...(extra?.revokedAt === undefined ? {} : { revokedAt: new Date(extra.revokedAt) }),
        ...(extra?.revokeReason === undefined ? {} : { revokeReason: extra.revokeReason }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.workReportRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new ReportConflictError(
        `报工单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.workReportRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToWorkReport(row);
  }
}

// ---- 核查留痕（append-only 触发器护栏） ----

export class PgReportAuditStore implements ReportAuditStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(row: ReportAuditRow): Promise<ReportAuditRow> {
    try {
      const appended = await this.prisma.reportAuditRecord.create({
        data: {
          id: row.id,
          tenantId: row.tenant,
          reportId: row.reportId,
          action: row.action,
          actor: row.actor,
          reason: row.reason,
          changes: row.changes === null ? Prisma.DbNull : json(row.changes as readonly unknown[]),
        },
      });
      return rowToReportAudit(appended);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReportConflictError(`核查留痕 '${row.id}' 已存在`);
      }
      throw error;
    }
  }

  async listByReport(tenant: TenantId, reportId: string): Promise<readonly ReportAuditRow[]> {
    const rows = await this.prisma.reportAuditRecord.findMany({
      where: { tenantId: tenant, reportId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(rowToReportAudit);
  }
}

// ---- 命令幂等记账 ----

export class PgReportOperationStore implements ReportOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: ReportOperationRecord): Promise<ReportOperationRecord | null> {
    try {
      await this.prisma.reportingOperationRecord.create({
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

export class PgReportDomainEventStore implements ReportDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, row.tenantId);
    try {
      // 交互式事务共享 tx 句柄：event+outbox 原子双写（RLS 接管见 rls-session.ts）。
      await this.prisma.$transaction(async (tx) => {
        await tx.businessEventRecord.create({
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
        });
        await tx.outboxRecord.create({
          data: {
            eventId: outbox.eventId,
            tenantId: outbox.tenantId,
            createdAt: outbox.createdAt,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReportConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

// ---- 机器事件账本（engine-flow ApprovalEventStore → reporting_events） ----

/**
 * 租户解析：聚合锚定 = 投影行（同 dispatch 取舍）。work-report → work_reports
 * （含修正版——修正版是独立聚合行）；其余类型 / 不存在的聚合 = 孤儿账目
 * fail-fast 拒写（report-batch 无状态机——BatchSubmitted 域事件走 event_records，
 * 不进本账本）。
 */
async function tenantOfReportingAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === WORK_REPORT_AGGREGATE_TYPE) {
    const row = await prisma.workReportRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `reporting aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = work_reports）`,
  );
}

export class PgReportingMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfReportingAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.reportingEventRecord.create({
        data: {
          eventId: event.eventId,
          tenantId,
          eventType: event.eventType,
          aggregateId: event.aggregate.id,
          aggregateType: event.aggregate.type,
          aggregateRevision: event.aggregate.revision,
          occurredAt: new Date(event.occurredAt),
          payload: event.payload as object,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? (error.meta.target as string[]) : [];
        if (target.includes('aggregate_id')) {
          // 版本乐观锁：另一迁移已占该 (aggregate, revision)——并发推进必拒其一。
          throw new ReportConflictError(
            `聚合 '${event.aggregate.id}' 版本 ${event.aggregate.revision} 已被另一迁移占用（并发推进冲突）`,
          );
        }
        // eventId 主键冲突 = 幂等去重纪律（与引擎内存实现同一合同）。
        throw new Error(`append-only violation: eventId "${event.eventId}" is already stored`);
      }
      throw error;
    }
  }

  async readByAggregate(
    aggregate: { readonly id: string; readonly type: string },
    options?: { readonly afterCursor?: ApprovalEventCursor },
  ): Promise<ApprovalEventPage> {
    const tenantId = await tenantOfReportingAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.reportingEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToReportingEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 ./dispatch） ----

export interface ReportingStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：五端口实现（可直接喂 ReportingModule.register）+ 优雅断连。 */
export interface ReportingStoreHandle {
  readonly reportStore: WorkReportStore;
  readonly auditStore: ReportAuditStore;
  readonly operationStore: ReportOperationStore;
  readonly domainEventStore: ReportDomainEventStore;
  readonly machineEventStore: ApprovalEventStore;
  disconnect(): Promise<void>;
}

/** 构造 reporting PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectReportingStore(options: ReportingStoreOptions = {}): ReportingStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    reportStore: new PgWorkReportStore(client),
    auditStore: new PgReportAuditStore(client),
    operationStore: new PgReportOperationStore(client),
    domainEventStore: new PgReportDomainEventStore(client),
    machineEventStore: new PgReportingMachineEventStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
