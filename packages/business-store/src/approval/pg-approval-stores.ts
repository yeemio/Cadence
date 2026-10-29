/**
 * 审批三端口的 PG 实现 + 组合根装配工厂（M1 收尾波-①，经本包 `./approval`
 * 子路径导出——与 `./org` / `./masterdata` / `./workbench` 同模式）。
 *
 * 三个实现：
 *  - PgApprovalCaseStore      → application ApprovalCaseStore（approval_cases 投影行；
 *                               advance 带乐观版本检查：updateMany 按 object_version
 *                               条件更新，零行命中 → ApprovalConflictError）
 *  - PgApprovalRecordStore    → engine-flow ApprovalRecordStore（approval_records，
 *                               append-only 触发器护栏）
 *  - PgApprovalEventStore     → engine-flow ApprovalEventStore（approval_events，
 *                               seq 大单调游标；(aggregate_id, aggregate_revision)
 *                               唯一索引 = DB 级乐观锁，P2002 → ApprovalConflictError）
 *
 * 租户解析取舍：engine 端口（记录/事件）不带租户参数——本适配层的聚合锚定
 * 合同 = 案件聚合（application ApprovalService 恒以 aggregate.type='approval-case'、
 * aggregate.id=案件 id 写入），租户经案件行解析（一次 findUnique；案件不存在 =
 * 孤儿账目，fail-fast 拒写）。ADR-0005 全表纪律由该解析满足（每行 tenant_id 齐备）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { EventId, TenantId, UserId } from '@smes/business-core';
import {
  makeApprovalEvent,
  makeApprovalRecord,
  type ApprovalEvent,
  type ApprovalEventCursor,
  type ApprovalEventPage,
  type ApprovalEventPayload,
  type ApprovalEventStore,
  type ApprovalRecord,
  type ApprovalRecordStore,
  type ApprovalRecordStoreEntry,
  type EvidenceRef,
} from '@smes/engine-flow';
import {
  ApprovalConflictError,
  type ApprovalCase,
  type ApprovalCaseStore,
  type CreateApprovalCaseInput,
  type ListApprovalCasesFilter,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

// ---- 行 <-> 领域形状映射 ----

interface CaseDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly submitterId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToApprovalCase(row: CaseDbRow): ApprovalCase {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    subjectRef: { type: row.subjectType, id: row.subjectId },
    submitter: UserId.create(row.submitterId),
    createdAt: row.createdAt.toISOString(),
  };
}

interface DecisionDbRow {
  readonly id: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly reviewerId: string;
  readonly decision: string;
  readonly reason: string;
  readonly evidence: unknown;
  readonly objectVersion: number;
  readonly decidedAt: Date;
}

export function rowToApprovalRecordEntry(row: DecisionDbRow): ApprovalRecordStoreEntry {
  const record: ApprovalRecord = makeApprovalRecord({
    reviewer: UserId.create(row.reviewerId),
    decision: row.decision as ApprovalRecord['decision'],
    reason: row.reason,
    evidence: (Array.isArray(row.evidence) ? row.evidence : []) as readonly EvidenceRef[],
    objectVersion: row.objectVersion,
    decidedAt: row.decidedAt.toISOString(),
  });
  return {
    aggregate: { id: row.aggregateId, type: row.aggregateType },
    record,
  };
}

interface EventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToApprovalEvent(row: EventDbRow): ApprovalEvent {
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

/** 唯一键冲突（P2002）分类：返回冲突错误或原样上抛（不吞连接错误）。 */
function classifyConflict(error: unknown, onVersion: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ApprovalConflictError(onVersion);
  }
  return error;
}

// ---- 案件行（application ApprovalCaseStore） ----

export class PgApprovalCaseStore implements ApprovalCaseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateApprovalCaseInput): Promise<ApprovalCase> {
    try {
      const row = await this.prisma.approvalCaseRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          subjectType: input.subjectRef.type,
          subjectId: input.subjectRef.id,
          submitterId: input.submitter,
        },
      });
      return rowToApprovalCase(row);
    } catch (error) {
      throw classifyConflict(error, `审批案件 '${input.id}' 已存在`);
    }
  }

  async find(tenant: TenantId, id: string): Promise<ApprovalCase | null> {
    const row = await this.prisma.approvalCaseRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : rowToApprovalCase(row);
  }

  async list(tenant: TenantId, filter?: ListApprovalCasesFilter): Promise<readonly ApprovalCase[]> {
    const rows = await this.prisma.approvalCaseRecord.findMany({
      where: { tenantId: tenant, ...(filter?.state === undefined ? {} : { state: filter.state }) },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToApprovalCase);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<ApprovalCase> {
    // 乐观推进：按 (tenant, id, object_version=expected) 条件更新，零行 = 版本不符或不存在。
    const updated = await this.prisma.approvalCaseRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: { state: nextState, objectVersion: nextObjectVersion, updatedAt: new Date() },
    });
    if (updated.count === 0) {
      const current = await this.prisma.approvalCaseRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new ApprovalConflictError(
        `案件 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.approvalCaseRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToApprovalCase(row);
  }
}

// ---- 记录 / 事件（engine-flow 端口） ----

/** 租户解析：聚合锚定 = 案件行（见文件头取舍注释）。孤儿聚合 fail-fast 拒写。 */
async function tenantOfCase(prisma: PrismaClient, aggregateId: string): Promise<string> {
  const row = await prisma.approvalCaseRecord.findUnique({ where: { id: aggregateId } });
  if (row === null) {
    throw new Error(
      `approval aggregate '${aggregateId}' 不存在于 approval_cases：拒绝写入孤儿账目（聚合锚定合同 = 案件）`,
    );
  }
  return row.tenantId;
}

export class PgApprovalRecordStore implements ApprovalRecordStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: ApprovalRecordStoreEntry): Promise<void> {
    const tenantId = await tenantOfCase(this.prisma, entry.aggregate.id);
    await this.prisma.approvalDecisionRecord.create({
      data: {
        id: uuidv7(),
        tenantId,
        aggregateId: entry.aggregate.id,
        aggregateType: entry.aggregate.type,
        reviewerId: entry.record.reviewer,
        decision: entry.record.decision,
        reason: entry.record.reason,
        evidence: entry.record.evidence.slice() as unknown as Prisma.InputJsonValue,
        objectVersion: entry.record.objectVersion,
        decidedAt: new Date(entry.record.decidedAt),
      },
    });
  }

  async byAggregate(aggregate: { id: string; type: string }): Promise<readonly ApprovalRecordStoreEntry[]> {
    const tenantId = await tenantOfCase(this.prisma, aggregate.id);
    const rows = await this.prisma.approvalDecisionRecord.findMany({
      where: { tenantId, aggregateId: aggregate.id, aggregateType: aggregate.type },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }], // id=uuidv7 时间序，同毫秒稳定
    });
    return rows.map(rowToApprovalRecordEntry);
  }
}

export class PgApprovalEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfCase(this.prisma, event.aggregate.id);
    try {
      await this.prisma.approvalEventRecord.create({
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
          // 版本乐观锁：另一迁移已占该 (aggregate, revision)——并发决策必拒其一。
          throw new ApprovalConflictError(
            `案件 '${event.aggregate.id}' 版本 ${event.aggregate.revision} 已被另一迁移占用（并发决策冲突）`,
          );
        }
        // eventId 主键冲突 = 幂等去重纪律（与引擎内存实现同一合同）。
        throw new Error(`append-only violation: eventId "${event.eventId}" is already stored`);
      }
      throw error;
    }
  }

  async readByAggregate(
    aggregate: { id: string; type: string },
    options?: { readonly afterCursor?: ApprovalEventCursor },
  ): Promise<ApprovalEventPage> {
    const tenantId = await tenantOfCase(this.prisma, aggregate.id);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.approvalEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToApprovalEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 `./org`） ----

export interface ApprovalStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：三端口实现 + 优雅断连。 */
export interface ApprovalStoreHandle {
  readonly caseStore: ApprovalCaseStore;
  readonly recordStore: ApprovalRecordStore;
  readonly eventStore: ApprovalEventStore;
  disconnect(): Promise<void>;
}

/** 构造审批 PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectApprovalStore(options: ApprovalStoreOptions = {}): ApprovalStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    caseStore: new PgApprovalCaseStore(client),
    recordStore: new PgApprovalRecordStore(client),
    eventStore: new PgApprovalEventStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
