/**
 * drawing 五端口的 PG 实现 + 组合根装配工厂（M3，m3-drafts/03-drawing.md v1.0；
 * 经本包 `./drawing` 子路径导出——与 `./payroll` / `./metric-pack` 同模式：主
 * 入口保持零 @prisma/client 依赖）。启动零 DB 依赖：connectDrawingStore 只构造
 * PrismaClient（惰性连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * **结构同形取舍（pro-pack-tier-edges 推论，写明）**：dep-cruiser 禁止
 * business-store import @smes/drawing（专业包不在 store-tier-edges 白名单），
 * 故本文件不 import 其类型，改用**本地结构化镜像类型**（与
 * packages/drawing/src/drawing-stores.ts / ports.ts 的行/端口形状逐字段同形——
 * 品牌化 id 用 business-core defineId 以同名品牌声明，类型统一于同一 Brand
 * 符号）。组合根注入时由 TypeScript 结构校验兼容（Pg* 类可直接喂
 * DrawingService 的 DrawingStores 槽位）。冲突信号用同名错误类承载
 * （name === 'DrawingConflictError'），drawing 侧 isDrawingConflict 按 name
 * 识别——跨包可观察行为等价。
 *
 * 派生口径（与内存实现同合同）：supersedesVersion = version−1（链连续由
 * (tenant, drawing_id, version) 唯一 + 链尾+1 构造保证），首发缺省不落。
 *
 * 实现：
 *  - PgDrawingRevisionStore → 修订链（drawing_revisions；(tenant, drawingId,
 *    version) 与 (tenant, supersedes) 唯一，P2002 → DrawingConflictError）+
 *    图号索引读面（P1-c：DISTINCT ON 可见集聚合 + groupBy 计数/真链尾）
 *  - PgDrawingChangeNoticeStore → 变更通知（drawing_change_notices；(tenant,
 *    drawingId, toVersion) 唯一 = 发布联动幂等锚点；sinceVersion 游标读）
 *  - PgDrawingViewTrailStore → 查看留痕（drawing_view_trails；append-only
 *    审计事实；seq bigserial）
 *  - PgDrawingDomainEventStore → 事件 + Outbox 同事务落账（复用
 *    event_records / outbox_records 与既有行映射；eventId 幂等锚点）
 *  - PgDrawingOperationLedger → 命令幂等账本（drawing_operations；(tenant,
 *    operationId) 唯一，P2002 = 已落账 → claim false）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, UserId, defineId, type BusinessEvent } from '@smes/business-core';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

// ---- 本地结构同形镜像（与 @smes/drawing 同名品牌/同形行；不 import 该包） ----

const DrawingId = defineId('DrawingId');
type DrawingId = ReturnType<typeof DrawingId.create>;
const DrawingRevisionId = defineId('DrawingRevisionId');
type DrawingRevisionId = ReturnType<typeof DrawingRevisionId.create>;
const DrawingChangeNoticeId = defineId('DrawingChangeNoticeId');
type DrawingChangeNoticeId = ReturnType<typeof DrawingChangeNoticeId.create>;

interface DrawingRevisionRow {
  readonly id: DrawingRevisionId;
  readonly tenant: TenantId;
  readonly drawingId: DrawingId;
  readonly version: number;
  readonly fileRef: string;
  readonly changeNote: string;
  readonly classification: string;
  readonly changedBy: UserId;
  readonly changedAt: string;
  readonly supersedes: string | null;
  readonly supersedesVersion?: number;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

type CreateDrawingRevisionInput = Omit<DrawingRevisionRow, 'id' | 'createdAt' | 'supersedesVersion'>;

interface DrawingRevisionStore {
  insert(input: CreateDrawingRevisionInput): Promise<DrawingRevisionRow>;
  find(tenant: TenantId, drawingId: DrawingId, version: number): Promise<DrawingRevisionRow | null>;
  chain(tenant: TenantId, drawingId: DrawingId): Promise<readonly DrawingRevisionRow[]>;
  listIndex(tenant: TenantId, query: DrawingIndexQuery): Promise<DrawingIndexPage>;
}

/** 图号索引查询/行/分页（drawing 侧 P1-c 读面镜像：可见集聚合+前缀+分页）。 */
interface DrawingIndexQuery {
  readonly drawingIdPrefix?: string | undefined;
  readonly visibleClassifications: readonly string[];
  readonly limit: number;
  readonly offset: number;
}

interface DrawingIndexRow {
  readonly drawingId: string;
  readonly latestVisibleVersion: number;
  readonly latestVisibleClassification: string;
  readonly tailVersion: number;
}

interface DrawingIndexPage {
  readonly rows: readonly DrawingIndexRow[];
  readonly total: number;
}

interface DrawingChangeNotice {
  readonly noticeId: DrawingChangeNoticeId;
  readonly tenant: TenantId;
  readonly drawingId: DrawingId;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changeNote: string;
  readonly publishedAt: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

interface DrawingChangeQuery {
  readonly sinceVersion?: number;
}

type AppendDrawingChangeNoticeInput = Omit<DrawingChangeNotice, 'noticeId' | 'createdAt'>;

/** 变更通知端口镜像（drawing 侧 DrawingChangeNoticePort 同形）。 */
interface DrawingChangeNoticePort {
  publish(input: AppendDrawingChangeNoticeInput): Promise<DrawingChangeNotice>;
  readByDrawing(
    tenant: TenantId,
    drawingId: DrawingId,
    query?: DrawingChangeQuery,
  ): Promise<readonly DrawingChangeNotice[]>;
}

interface DrawingViewTrailRow {
  readonly id: string;
  readonly tenant: TenantId;
  readonly seq: number;
  readonly drawingId: DrawingId;
  readonly version: number;
  readonly viewedBy: UserId;
  readonly viewedAt: string;
  readonly classification: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

type AppendDrawingViewInput = Omit<DrawingViewTrailRow, 'id' | 'seq' | 'objectVersion'> & {
  readonly availableTime?: string;
};

interface ListDrawingViewsFilter {
  readonly drawingId?: DrawingId | undefined;
  readonly viewedBy?: UserId | undefined;
}

interface DrawingViewTrailStore {
  insert(input: AppendDrawingViewInput): Promise<DrawingViewTrailRow>;
  list(tenant: TenantId, filter?: ListDrawingViewsFilter): Promise<readonly DrawingViewTrailRow[]>;
}

/** 冲突错误镜像（name 同形——drawing 侧 isDrawingConflict 按 name 识别）。 */
class DrawingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawingConflictError';
  }
}

// ---- 工具 ----

function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new DrawingConflictError(message);
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function jsonInput(value: Readonly<Record<string, unknown>>): Prisma.InputJsonObject {
  return value as unknown as Prisma.InputJsonObject;
}

function isoToDate(value: string | undefined | null): Date | undefined {
  return value === undefined || value === null ? undefined : new Date(value);
}

// ---- 图纸修订链（append-only） ----

type DrawingRevisionDbRow = {
  id: string;
  tenantId: string;
  drawingId: string;
  version: number;
  fileRef: string;
  changeNote: string;
  classification: string;
  changedBy: string;
  changedAt: Date;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toRevisionRow(row: DrawingRevisionDbRow): DrawingRevisionRow {
  return {
    id: DrawingRevisionId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    drawingId: DrawingId.create(row.drawingId),
    version: row.version,
    fileRef: row.fileRef,
    changeNote: row.changeNote,
    classification: row.classification,
    changedBy: UserId.create(row.changedBy),
    changedAt: row.changedAt.toISOString(),
    supersedes: row.supersedes,
    ...(row.version > 1 ? { supersedesVersion: row.version - 1 } : {}),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgDrawingRevisionStore implements DrawingRevisionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: CreateDrawingRevisionInput): Promise<DrawingRevisionRow> {
    try {
      const row = await this.prisma.drawingRevisionRecord.create({
        data: {
          id: `dr-${uuidv7()}`,
          tenantId: input.tenant,
          drawingId: input.drawingId,
          version: input.version,
          fileRef: input.fileRef,
          changeNote: input.changeNote,
          classification: input.classification,
          changedBy: input.changedBy,
          changedAt: new Date(input.changedAt),
          objectVersion: 1,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toRevisionRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `图纸 ${input.drawingId} 修订 v${input.version} 唯一约束冲突（并发发布竞态或 supersedes 链分叉）`,
      );
    }
  }

  async find(tenant: TenantId, drawingId: DrawingId, version: number): Promise<DrawingRevisionRow | null> {
    const row = await this.prisma.drawingRevisionRecord.findFirst({
      where: { tenantId: tenant, drawingId, version },
    });
    return row === null ? null : toRevisionRow(row);
  }

  async chain(tenant: TenantId, drawingId: DrawingId): Promise<readonly DrawingRevisionRow[]> {
    const rows = await this.prisma.drawingRevisionRecord.findMany({
      where: { tenantId: tenant, drawingId },
      orderBy: { version: 'asc' },
    });
    return rows.map((row) => toRevisionRow(row));
  }

  /**
   * 租户级图号索引（P1-c）：三查询最小实现——
   *  1) DISTINCT ON (drawing_id) 取每图可见集内最大 version（orderBy
   *     drawingId asc/version desc + distinct）+ skip/take 分页；
   *  2) groupBy 计可见图纸总数（与 rows 同过滤口径）；
   *  3) 页内图纸真链尾（groupBy _max(version)——status 判定专用）。
   * 全链超许可的图纸自然不进前两查询（不泄漏存在性，端口合同）。
   */
  async listIndex(tenant: TenantId, query: DrawingIndexQuery): Promise<DrawingIndexPage> {
    const visibleWhere = {
      tenantId: tenant,
      ...(query.drawingIdPrefix === undefined ? {} : { drawingId: { startsWith: query.drawingIdPrefix } }),
      classification: { in: [...query.visibleClassifications] },
    };
    const prefixWhere = {
      tenantId: tenant,
      ...(query.drawingIdPrefix === undefined
        ? {}
        : { drawingId: { startsWith: query.drawingIdPrefix } }),
    };
    const [latestVisible, groups] = await Promise.all([
      this.prisma.drawingRevisionRecord.findMany({
        where: visibleWhere,
        orderBy: [{ drawingId: 'asc' }, { version: 'desc' }],
        distinct: ['drawingId'],
        skip: query.offset,
        take: query.limit,
        select: { drawingId: true, version: true, classification: true },
      }),
      this.prisma.drawingRevisionRecord.groupBy({ by: ['drawingId'], where: visibleWhere }),
    ]);
    const pageIds = latestVisible.map((row) => row.drawingId);
    const tailGroups =
      pageIds.length === 0
        ? []
        : await this.prisma.drawingRevisionRecord.groupBy({
            by: ['drawingId'],
            where: { ...prefixWhere, drawingId: { in: pageIds } },
            _max: { version: true },
          });
    const tailByDrawing = new Map(
      tailGroups.map((group) => [group.drawingId, group._max?.version ?? 0]),
    );
    return {
      rows: latestVisible.map((row) => ({
        drawingId: row.drawingId,
        latestVisibleVersion: row.version,
        latestVisibleClassification: row.classification,
        tailVersion: tailByDrawing.get(row.drawingId) ?? row.version,
      })),
      total: groups.length,
    };
  }
}

// ---- 变更通知（发布联动事实） ----

type DrawingChangeNoticeDbRow = {
  id: string;
  tenantId: string;
  drawingId: string;
  fromVersion: number;
  toVersion: number;
  changeNote: string;
  publishedAt: Date;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toNoticeRow(row: DrawingChangeNoticeDbRow): DrawingChangeNotice {
  return {
    noticeId: DrawingChangeNoticeId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    drawingId: DrawingId.create(row.drawingId),
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    changeNote: row.changeNote,
    publishedAt: row.publishedAt.toISOString(),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgDrawingChangeNoticeStore implements DrawingChangeNoticePort {
  constructor(private readonly prisma: PrismaClient) {}

  async publish(input: AppendDrawingChangeNoticeInput): Promise<DrawingChangeNotice> {
    try {
      const row = await this.prisma.drawingChangeNoticeRecord.create({
        data: {
          id: `dnc-${uuidv7()}`,
          tenantId: input.tenant,
          drawingId: input.drawingId,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          changeNote: input.changeNote,
          publishedAt: new Date(input.publishedAt),
          objectVersion: 1,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toNoticeRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `图纸 ${input.drawingId} 的变更通知 to v${input.toVersion} 唯一约束冲突（发布联动幂等锚点）`,
      );
    }
  }

  async readByDrawing(
    tenant: TenantId,
    drawingId: DrawingId,
    query?: DrawingChangeQuery,
  ): Promise<readonly DrawingChangeNotice[]> {
    const rows = await this.prisma.drawingChangeNoticeRecord.findMany({
      where: {
        tenantId: tenant,
        drawingId,
        ...(query?.sinceVersion === undefined ? {} : { toVersion: { gt: query.sinceVersion } }),
      },
      orderBy: { toVersion: 'asc' },
    });
    return rows.map((row) => toNoticeRow(row));
  }
}

// ---- 查看留痕（append-only 审计事实） ----

type DrawingViewTrailDbRow = {
  id: string;
  tenantId: string;
  seq: bigint;
  drawingId: string;
  version: number;
  viewedBy: string;
  viewedAt: Date;
  classification: string;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toViewTrailRow(row: DrawingViewTrailDbRow): DrawingViewTrailRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    drawingId: DrawingId.create(row.drawingId),
    version: row.version,
    viewedBy: UserId.create(row.viewedBy),
    viewedAt: row.viewedAt.toISOString(),
    classification: row.classification,
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
}

export class PgDrawingViewTrailStore implements DrawingViewTrailStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendDrawingViewInput): Promise<DrawingViewTrailRow> {
    const row = await this.prisma.drawingViewTrailRecord.create({
      data: {
        id: `dvt-${uuidv7()}`,
        tenantId: input.tenant,
        drawingId: input.drawingId,
        version: input.version,
        viewedBy: input.viewedBy,
        viewedAt: new Date(input.viewedAt),
        classification: input.classification,
        objectVersion: 1,
        auditStatus: input.auditStatus,
        ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        businessTime: isoToDate(input.businessTime) ?? null,
        ...(input.availableTime === undefined ? {} : { availableTime: isoToDate(input.availableTime) ?? null }),
      },
    });
    return toViewTrailRow(row);
  }

  async list(tenant: TenantId, filter?: ListDrawingViewsFilter): Promise<readonly DrawingViewTrailRow[]> {
    const rows = await this.prisma.drawingViewTrailRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter === undefined
          ? {}
          : {
              ...(filter.drawingId === undefined ? {} : { drawingId: filter.drawingId }),
              ...(filter.viewedBy === undefined ? {} : { viewedBy: filter.viewedBy }),
            }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toViewTrailRow(row));
  }
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgDrawingDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<void> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, event.tenantId);
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
            ...(row.provenance === undefined ? {} : { provenance: row.provenance as Prisma.InputJsonObject }),
            payload: row.payload as Prisma.InputJsonObject,
          },
        });
        await tx.outboxRecord.create({
          data: { eventId: outbox.eventId, tenantId: outbox.tenantId, createdAt: outbox.createdAt },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DrawingConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
      }
      throw error;
    }
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    const rows = await this.prisma.businessEventRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { occurredAt: 'asc' },
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
}

export class PgDrawingOperationLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.drawingOperationRecord.create({
        data: { id: uuidv7(), tenantId: tenant, operationId, commandKind },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // 已落账 → 幂等拒绝
      throw error;
    }
  }
}

// ---- 组合根装配工厂 ----

export interface DrawingStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/**
 * 组合根装配句柄：五端口实现。结构同形兼容 @smes/drawing 的 DrawingStores
 * 槽位（组合根注入时结构校验），可直接喂 DrawingService 构造函数。
 */
export interface DrawingStoreHandle {
  readonly revisionStore: PgDrawingRevisionStore;
  readonly noticeStore: PgDrawingChangeNoticeStore;
  readonly viewTrailStore: PgDrawingViewTrailStore;
  readonly eventStore: PgDrawingDomainEventStore;
  readonly operationStore: PgDrawingOperationLedger;
  readonly stores: {
    readonly revisions: PgDrawingRevisionStore;
    readonly notices: PgDrawingChangeNoticeStore;
    readonly views: PgDrawingViewTrailStore;
    readonly events: PgDrawingDomainEventStore;
    readonly operations: PgDrawingOperationLedger;
  };
  disconnect(): Promise<void>;
}

/** 构造 drawing PG 存储装配（惰性连接：见文件头）。 */
export function connectDrawingStore(options: DrawingStoreOptions = {}): DrawingStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  const revisionStore = new PgDrawingRevisionStore(client);
  const noticeStore = new PgDrawingChangeNoticeStore(client);
  const viewTrailStore = new PgDrawingViewTrailStore(client);
  const eventStore = new PgDrawingDomainEventStore(client);
  const operationStore = new PgDrawingOperationLedger(client);
  return {
    revisionStore,
    noticeStore,
    viewTrailStore,
    eventStore,
    operationStore,
    stores: {
      revisions: revisionStore,
      notices: noticeStore,
      views: viewTrailStore,
      events: eventStore,
      operations: operationStore,
    },
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
