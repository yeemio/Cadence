/**
 * baseline 六端口 + P2/P3 件四端口的 PG 实现 + 组合根装配工厂（M2-W2 / M2-W7，
 * 经本包 `./baseline` 子路径导出——与 `./org` / `./masterdata` / `./approval`
 * 同模式：主入口保持零 @prisma/client 依赖）。启动零 DB 依赖：connectBaselineStore
 * 只构造 PrismaClient（惰性连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 实现：
 *  - PgProcessDefStore / PgEquipmentStore / PgOutsourcingPriceRuleStore
 *    → 版本化主数据三端口（process_defs / equipment_records /
 *    outsourcing_price_rules；(tenant, code, objectVersion) 唯一 = 并发竞态
 *    防线，P2002 → BaselineConflictError；id 用 uuidv7 应用侧权威生成）
 *  - PgRoutingStore / PgStandardTimeStore → P2/P3 版本化主数据端口
 *    （routings——业务键 code = 图号、steps JSONB 工序序列；
 *    standard_times——秒整数量纲；同上唯一约束防线与 append-only 触发器）
 *  - PgFaultReportStore → 故障单投影行（fault_reports；advance =
 *    object_version 条件更新 + assignee/闭环字段，体例同 inspections）
 *  - PgFaultMachineEventStore → engine-flow ApprovalEventStore（fault_events
 *    账本；(aggregate_id, aggregate_revision) 唯一 = DB 级乐观锁；租户经
 *    fault_reports 行解析——聚合锚定合同 = 投影行，孤儿聚合 fail-fast 拒写）
 *  - PgMaterialValidationRunStore → 校验运行事实（material_validation_runs；
 *    summary/lines JSONB 载荷）
 *  - PgBaselineEventStore → 事件 + Outbox 同事务落账（复用 event_records /
 *    outbox_records 两张既有表与 event-row/outbox-row 映射；eventId 幂等锚点）
 *  - PgBaselineOperationLedger → 命令幂等账本（baseline_command_operations；
 *    P1 主数据与 P2/P3 件（含故障命令）共用同一账本；(tenant, operationId)
 *    唯一，P2002 = 已落账 → claim false）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantId, type BusinessEvent } from '@smes/business-core';
import {
  makeApprovalEvent,
  type ApprovalEvent,
  type ApprovalEventCursor,
  type ApprovalEventPage,
  type ApprovalEventPayload,
  type ApprovalEventStore,
} from '@smes/engine-flow';
import {
  BASELINE_AGGREGATE_TYPES,
  BaselineConflictError,
  FaultReportId,
  type BaselineEventStore,
  type BaselineOperationLedger,
  type CreateEquipmentInput,
  type CreateFaultReportInput,
  type CreateOutsourcingPriceRuleInput,
  type CreateProcessDefInput,
  type CreateRoutingInput,
  type CreateStandardTimeInput,
  type EquipmentRow,
  type EquipmentStore,
  type FaultReport,
  type FaultReportAdvanceExtra,
  type FaultReportStore,
  type ListFaultReportsFilter,
  type MaterialLineJudgment,
  type MaterialValidationRunRow,
  type MaterialValidationRunStore,
  type MaterialValidationRunSummaryView,
  type MaterialValidationSummary,
  type OutsourcingPriceRuleRow,
  type OutsourcingPriceRuleStore,
  type ProcessDefRow,
  type ProcessDefStore,
  type RoutingRow,
  type RoutingStep,
  type RoutingStore,
  type StandardTimeRow,
  type StandardTimeStore,
} from '@smes/application';
import { EventId } from '@smes/business-core';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

/** 唯一键冲突（P2002）→ 域冲突错误；其余原样上抛（不吞连接错误）。 */
function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new BaselineConflictError(message);
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷 → Prisma JSON 输入（结构同构，类型面窄化唯一换算点；缺省由调用点条件展开）。 */
function jsonInput(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonObject {
  return value as unknown as Prisma.InputJsonObject;
}

/** ISO 字串（可缺省）→ Date（可空列）。 */
function isoToDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

// ---- 版本化主数据：行映射 ----

interface MasterDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly objectVersion: number;
  readonly status: string;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
  readonly createdAt: Date;
}

/** 版本化主数据公共列 → 领域公共字段（ISO 换算点唯一）。 */
function masterCommon(row: MasterDbRow) {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    objectVersion: row.objectVersion,
    status: row.status === 'draft' ? ('draft' as const) : ('active' as const),
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    supersedes: row.supersedes,
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

/** 公共创建列（id/审计/时间戳；available_time 由连接器口径填写，本层恒 null）。 */
function masterCreateData(input: { readonly tenant: TenantId; readonly objectVersion: number; readonly supersedes: string | null; readonly status: string; readonly auditStatus: string; readonly provenance?: Readonly<Record<string, unknown>>; readonly businessTime?: string }) {
  return {
    id: uuidv7(),
    tenantId: input.tenant,
    objectVersion: input.objectVersion,
    supersedes: input.supersedes,
    status: input.status,
    auditStatus: input.auditStatus,
    ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
    businessTime: isoToDate(input.businessTime) ?? null,
  };
}

type PrismaMasterDelegate<DbRow extends MasterDbRow> = {
  create(args: { data: Record<string, unknown> }): Promise<DbRow>;
  // 泛型 delegate 走未类型化运行时：Prisma 6 的 orderBy 只接受数组形态
  // （对象形态报 Expected Input[], provided Object——2026-10-26 S4 基线录制实证）
  findMany(args: { where: { tenantId: string; code?: string }; orderBy: readonly ({ code: 'asc' } | { objectVersion: 'asc' })[] }): Promise<DbRow[]>;
};

/** 版本化主数据 PG 内核（三端口共用；列面差异经 toRow/toData 收窄）。 */
class PgVersionedMasterStore<DbRow extends MasterDbRow, Row, CreateInput> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly delegate: PrismaMasterDelegate<DbRow>,
    private readonly label: string,
    private readonly toRow: (row: DbRow) => Row,
    private readonly toData: (input: CreateInput) => Record<string, unknown>,
  ) {}

  async insert(input: CreateInput & { readonly code: string; readonly objectVersion: number }): Promise<Row> {
    try {
      const row = await this.delegate.create({ data: this.toData(input) });
      return this.toRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `${this.label} '${input.code}' 版本 ${input.objectVersion} 唯一约束冲突（并发写入竞态或 supersedes 链分叉）`,
      );
    }
  }

  async versions(tenant: TenantId, code: string): Promise<readonly Row[]> {
    const rows = await this.delegate.findMany({
      where: { tenantId: tenant, code },
      orderBy: [{ code: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => this.toRow(row));
  }

  async listAll(tenant: TenantId): Promise<readonly Row[]> {
    const rows = await this.delegate.findMany({
      where: { tenantId: tenant },
      orderBy: [{ code: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => this.toRow(row));
  }
}

export class PgProcessDefStore implements ProcessDefStore {
  private readonly core: PgVersionedMasterStore<MasterDbRow & { readonly name: string; readonly category: string | null; readonly description: string | null }, ProcessDefRow, CreateProcessDefInput>;

  constructor(prisma: PrismaClient) {
    this.core = new PgVersionedMasterStore(
      prisma,
      prisma.processDefRecord as unknown as PrismaMasterDelegate<MasterDbRow & { readonly name: string; readonly category: string | null; readonly description: string | null }>,
      '工序',
      (row) => ({ ...masterCommon(row), name: row.name, category: row.category, description: row.description }),
      (input) => ({
        ...masterCreateData(input),
        code: input.code,
        name: input.name,
        category: input.category,
        description: input.description,
      }),
    );
  }

  insert(input: CreateProcessDefInput): Promise<ProcessDefRow> {
    return this.core.insert(input);
  }

  versions(tenant: TenantId, code: string): Promise<readonly ProcessDefRow[]> {
    return this.core.versions(tenant, code);
  }

  listAll(tenant: TenantId): Promise<readonly ProcessDefRow[]> {
    return this.core.listAll(tenant);
  }
}

export class PgEquipmentStore implements EquipmentStore {
  private readonly core: PgVersionedMasterStore<MasterDbRow & { readonly name: string; readonly type: string | null; readonly location: string | null }, EquipmentRow, CreateEquipmentInput>;

  constructor(prisma: PrismaClient) {
    this.core = new PgVersionedMasterStore(
      prisma,
      prisma.equipmentRecord as unknown as PrismaMasterDelegate<MasterDbRow & { readonly name: string; readonly type: string | null; readonly location: string | null }>,
      '设备',
      (row) => ({ ...masterCommon(row), name: row.name, type: row.type, location: row.location }),
      (input) => ({
        ...masterCreateData(input),
        code: input.code,
        name: input.name,
        type: input.type,
        location: input.location,
      }),
    );
  }

  insert(input: CreateEquipmentInput): Promise<EquipmentRow> {
    return this.core.insert(input);
  }

  versions(tenant: TenantId, code: string): Promise<readonly EquipmentRow[]> {
    return this.core.versions(tenant, code);
  }

  listAll(tenant: TenantId): Promise<readonly EquipmentRow[]> {
    return this.core.listAll(tenant);
  }
}

export class PgOutsourcingPriceRuleStore implements OutsourcingPriceRuleStore {
  private readonly core: PgVersionedMasterStore<MasterDbRow & { readonly name: string | null; readonly processCode: string; readonly unitPriceMinor: number; readonly marginPermyriad: number }, OutsourcingPriceRuleRow, CreateOutsourcingPriceRuleInput>;

  constructor(prisma: PrismaClient) {
    this.core = new PgVersionedMasterStore(
      prisma,
      prisma.outsourcingPriceRuleRecord as unknown as PrismaMasterDelegate<MasterDbRow & { readonly name: string | null; readonly processCode: string; readonly unitPriceMinor: number; readonly marginPermyriad: number }>,
      '外协计价规则',
      (row) => ({
        ...masterCommon(row),
        name: row.name,
        processCode: row.processCode,
        unitPriceMinor: row.unitPriceMinor,
        marginPermyriad: row.marginPermyriad,
      }),
      (input) => ({
        ...masterCreateData(input),
        code: input.code,
        name: input.name,
        processCode: input.processCode,
        unitPriceMinor: input.unitPriceMinor,
        marginPermyriad: input.marginPermyriad,
      }),
    );
  }

  insert(input: CreateOutsourcingPriceRuleInput): Promise<OutsourcingPriceRuleRow> {
    return this.core.insert(input);
  }

  versions(tenant: TenantId, code: string): Promise<readonly OutsourcingPriceRuleRow[]> {
    return this.core.versions(tenant, code);
  }

  listAll(tenant: TenantId): Promise<readonly OutsourcingPriceRuleRow[]> {
    return this.core.listAll(tenant);
  }
}

// ---- P2/P3 件：版本化主数据两端口（routings / standard_times） ----

export class PgRoutingStore implements RoutingStore {
  private readonly core: PgVersionedMasterStore<MasterDbRow & { readonly name: string | null; readonly steps: unknown }, RoutingRow, CreateRoutingInput>;

  constructor(prisma: PrismaClient) {
    this.core = new PgVersionedMasterStore(
      prisma,
      prisma.routingRecord as unknown as PrismaMasterDelegate<MasterDbRow & { readonly name: string | null; readonly steps: unknown }>,
      '工艺路线',
      (row) => ({ ...masterCommon(row), name: row.name, steps: row.steps as readonly RoutingStep[] }),
      (input) => ({
        ...masterCreateData(input),
        code: input.code,
        name: input.name,
        steps: jsonInput(input.steps as unknown as Readonly<Record<string, unknown>>)!,
      }),
    );
  }

  insert(input: CreateRoutingInput): Promise<RoutingRow> {
    return this.core.insert(input);
  }

  versions(tenant: TenantId, code: string): Promise<readonly RoutingRow[]> {
    return this.core.versions(tenant, code);
  }

  listAll(tenant: TenantId): Promise<readonly RoutingRow[]> {
    return this.core.listAll(tenant);
  }
}

export class PgStandardTimeStore implements StandardTimeStore {
  private readonly core: PgVersionedMasterStore<MasterDbRow & { readonly scope: string; readonly targetCode: string; readonly standardSeconds: number; readonly preparationSeconds: number }, StandardTimeRow, CreateStandardTimeInput>;

  constructor(prisma: PrismaClient) {
    this.core = new PgVersionedMasterStore(
      prisma,
      prisma.standardTimeRecord as unknown as PrismaMasterDelegate<MasterDbRow & { readonly scope: string; readonly targetCode: string; readonly standardSeconds: number; readonly preparationSeconds: number }>,
      '额定工时',
      (row) => ({
        ...masterCommon(row),
        scope: row.scope as StandardTimeRow['scope'],
        targetCode: row.targetCode,
        standardSeconds: row.standardSeconds,
        preparationSeconds: row.preparationSeconds,
      }),
      (input) => ({
        ...masterCreateData(input),
        code: input.code,
        scope: input.scope,
        targetCode: input.targetCode,
        standardSeconds: input.standardSeconds,
        preparationSeconds: input.preparationSeconds,
      }),
    );
  }

  insert(input: CreateStandardTimeInput): Promise<StandardTimeRow> {
    return this.core.insert(input);
  }

  versions(tenant: TenantId, code: string): Promise<readonly StandardTimeRow[]> {
    return this.core.versions(tenant, code);
  }

  listAll(tenant: TenantId): Promise<readonly StandardTimeRow[]> {
    return this.core.listAll(tenant);
  }
}

// ---- P2 件：故障单投影行（fault_reports） ----

interface FaultReportDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly equipmentCode: string;
  readonly description: string;
  readonly reportedBy: string;
  readonly assignee: string | null;
  readonly assignedAt: Date | null;
  readonly resolutionRemark: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToFaultReport(row: FaultReportDbRow): FaultReport {
  return {
    id: FaultReportId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    equipmentCode: row.equipmentCode,
    description: row.description,
    reportedBy: row.reportedBy,
    assignee: row.assignee,
    assignedAt: row.assignedAt === null ? null : row.assignedAt.toISOString(),
    resolutionRemark: row.resolutionRemark,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgFaultReportStore implements FaultReportStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateFaultReportInput): Promise<FaultReport> {
    try {
      const row = await this.prisma.faultReportRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          equipmentCode: input.equipmentCode,
          description: input.description,
          reportedBy: input.reportedBy,
        },
      });
      return rowToFaultReport(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BaselineConflictError(`故障单 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: FaultReportId): Promise<FaultReport | null> {
    const row = await this.prisma.faultReportRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToFaultReport(row);
  }

  async list(tenant: TenantId, filter?: ListFaultReportsFilter): Promise<readonly FaultReport[]> {
    const rows = await this.prisma.faultReportRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToFaultReport);
  }

  async advance(
    tenant: TenantId,
    id: FaultReportId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: FaultReportAdvanceExtra,
  ): Promise<FaultReport> {
    // 乐观推进：按 (tenant, id, object_version=expected) 条件更新，零行 = 版本不符或不存在。
    const updated = await this.prisma.faultReportRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.assignee === undefined ? {} : { assignee: extra.assignee }),
        ...(extra?.assignedAt === undefined ? {} : { assignedAt: new Date(extra.assignedAt) }),
        ...(extra?.resolutionRemark === undefined ? {} : { resolutionRemark: extra.resolutionRemark }),
        ...(extra?.resolvedBy === undefined ? {} : { resolvedBy: extra.resolvedBy }),
        ...(extra?.resolvedAt === undefined ? {} : { resolvedAt: new Date(extra.resolvedAt) }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.faultReportRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new BaselineConflictError(
        `故障单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.faultReportRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToFaultReport(row);
  }
}

// ---- P2 件：故障状态机事件账本（engine-flow ApprovalEventStore → fault_events） ----

/** 租户解析：聚合锚定 = 投影行（同 ./inspection 取舍）；孤儿聚合 fail-fast 拒写。 */
async function tenantOfFaultAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === BASELINE_AGGREGATE_TYPES.faultReport) {
    const row = await prisma.faultReportRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `baseline fault aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = fault_reports）`,
  );
}

export class PgFaultMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfFaultAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.faultEventRecord.create({
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
          throw new BaselineConflictError(
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
    const tenantId = await tenantOfFaultAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.faultEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map((row) =>
        makeApprovalEvent({
          eventId: EventId.create(row.eventId),
          eventType: row.eventType,
          aggregate: { id: row.aggregateId, type: row.aggregateType, revision: row.aggregateRevision },
          occurredAt: row.occurredAt.toISOString(),
          payload: row.payload as unknown as ApprovalEventPayload,
        }),
      ),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 物料校验运行（执行事实） ----

/** 校验运行表行形状（证据公共列 + 事实载荷；无 code/status 业务键列）。 */
interface ValidationDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly issuedBy: string;
  readonly summary: unknown;
  readonly lines: unknown;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
  readonly createdAt: Date;
}

function toRunRow(row: ValidationDbRow): MaterialValidationRunRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    issuedBy: row.issuedBy,
    createdAt: row.createdAt.toISOString(),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    summary: row.summary as MaterialValidationSummary,
    lines: row.lines as readonly MaterialLineJudgment[],
  };
}

function toRunSummaryView(row: ValidationDbRow): MaterialValidationRunSummaryView {
  const { lines: _lines, ...summary } = toRunRow(row);
  return summary;
}

export class PgMaterialValidationRunStore implements MaterialValidationRunStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(run: Omit<MaterialValidationRunRow, 'id' | 'createdAt'>): Promise<MaterialValidationRunRow> {
    try {
      const row = await this.prisma.materialValidationRunRecord.create({
        data: {
          id: uuidv7(),
          tenantId: run.tenant,
          issuedBy: run.issuedBy,
          summary: jsonInput(run.summary as unknown as Readonly<Record<string, unknown>>)!,
          lines: jsonInput(run.lines as unknown as readonly unknown[])!,
          objectVersion: run.objectVersion,
          auditStatus: run.auditStatus,
          ...(run.provenance === undefined ? {} : { provenance: jsonInput(run.provenance) }),
          businessTime: isoToDate(run.businessTime) ?? null,
        },
      });
      return toRunRow(row);
    } catch (error) {
      throw toConflict(error, `校验运行 '${run.tenant}' 落账唯一约束冲突`);
    }
  }

  async get(tenant: TenantId, runId: string): Promise<MaterialValidationRunRow | null> {
    const row = await this.prisma.materialValidationRunRecord.findFirst({
      where: { tenantId: tenant, id: runId },
    });
    return row === null ? null : toRunRow(row);
  }

  async list(tenant: TenantId): Promise<readonly MaterialValidationRunSummaryView[]> {
    const rows = await this.prisma.materialValidationRunRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map((row) => toRunSummaryView(row));
  }
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgBaselineEventStore implements BaselineEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<void> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, event.tenantId);
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
            ...(row.provenance === undefined ? {} : { provenance: jsonInput(row.provenance) }),
            payload: jsonInput(row.payload as Readonly<Record<string, unknown>>)!,
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
        throw new BaselineConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

export class PgBaselineOperationLedger implements BaselineOperationLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.baselineOperationRecord.create({
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

export interface BaselineStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：六端口 + P2/P3 件四端口实现（可直接喂 BaselineModule.register）+ 优雅断连。 */
export interface BaselineStoreHandle {
  readonly processStore: ProcessDefStore;
  readonly equipmentStore: EquipmentStore;
  readonly outsourcingRuleStore: OutsourcingPriceRuleStore;
  readonly validationRunStore: MaterialValidationRunStore;
  readonly eventStore: BaselineEventStore;
  readonly operationLedger: BaselineOperationLedger;
  /** P2/P3 件（M2-W7；加法式字段——组合根按需接线，缺省不装配回落内存） */
  readonly routingStore: RoutingStore;
  readonly standardTimeStore: StandardTimeStore;
  readonly faultReportStore: FaultReportStore;
  readonly faultEventStore: ApprovalEventStore;
  disconnect(): Promise<void>;
}

/** 构造 baseline PG 存储装配（惰性连接：见文件头）。 */
export function connectBaselineStore(options: BaselineStoreOptions = {}): BaselineStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  return {
    processStore: new PgProcessDefStore(prisma),
    equipmentStore: new PgEquipmentStore(prisma),
    outsourcingRuleStore: new PgOutsourcingPriceRuleStore(prisma),
    validationRunStore: new PgMaterialValidationRunStore(prisma),
    eventStore: new PgBaselineEventStore(prisma),
    operationLedger: new PgBaselineOperationLedger(prisma),
    routingStore: new PgRoutingStore(prisma),
    standardTimeStore: new PgStandardTimeStore(prisma),
    faultReportStore: new PgFaultReportStore(prisma),
    faultEventStore: new PgFaultMachineEventStore(prisma),
    async disconnect(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
