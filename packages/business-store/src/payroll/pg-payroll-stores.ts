/**
 * payroll 五端口的 PG 实现 + 组合根装配工厂（M3，经本包 `./payroll` 子路径
 * 导出——与 `./hours` / `./costing` 同模式：主入口保持零 @prisma/client 依赖）。
 * 启动零 DB 依赖：connectPayrollStore 只构造 PrismaClient（惰性连接），无
 * DATABASE_URL 时组合根不调用本工厂。
 *
 * **结构同形取舍（pro-pack-tier-edges 推论，写明）**：dep-cruiser 禁止
 * business-store import @smes/payroll（专业包不在 store-tier-edges 白名单），
 * 故本文件不 import 其类型，改用**本地结构化镜像类型**（与
 * packages/payroll/src/payroll-stores.ts 的行/端口形状逐字段同形——品牌化
 * id 用 business-core defineId 以同名品牌声明，类型统一于同一 Brand 符号）。
 * 组合根注入时由 TypeScript 结构校验兼容（Pg* 类可直接喂 PayrollService 的
 * PayrollStores 槽位）。冲突信号用同名错误类承载（name === 'PayrollConflictError'），
 * payroll 侧 isPayrollConflict 按 name 识别——跨包可观察行为等价。
 *
 * 实现：
 *  - PgPayrollRuleStore → 计薪规则版本（payroll_rules；(tenant, ruleId,
 *    objectVersion) 与 (tenant, supersedes) 唯一，P2002 → PayrollConflictError）
 *  - PgPayRunStore → 核算批次快照（pay_runs；链线性不变量由
 *    (tenant, periodKey, personId, objectVersion) 与 (tenant, supersedes) 唯一约束背书）
 *  - PgEarningsRecordStore → 薪酬记录事实（earnings_records；(tenant,
 *    sourceKey) 唯一 = 核算行幂等锚点；seq bigserial）
 *  - PgPayrollDomainEventStore → 事件 + Outbox 同事务落账（复用 event_records /
 *    outbox_records 与既有行映射；eventId 幂等锚点）
 *  - PgPayrollOperationLedger → 命令幂等账本（payroll_operations；(tenant,
 *    operationId) 唯一，P2002 = 已落账 → claim false）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, UserId, defineId, type BusinessEvent } from '@smes/business-core';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

// ---- 本地结构同形镜像（与 @smes/payroll 同名品牌/同形行；不 import 该包） ----

const PayrollRuleId = defineId('PayrollRuleId');
type PayrollRuleId = ReturnType<typeof PayrollRuleId.create>;
const PayRunId = defineId('PayRunId');
type PayRunId = ReturnType<typeof PayRunId.create>;
const EarningsRecordId = defineId('EarningsRecordId');
type EarningsRecordId = ReturnType<typeof EarningsRecordId.create>;

type EarningsBasis = 'hours' | 'output';
type PayPeriodKind = 'month' | 'week' | 'custom';
type LaborKind = 'part' | 'assembly' | 'electrical' | 'aftermarket' | 'oddjob';

interface PayrollRuleScope {
  readonly personId?: UserId;
  readonly laborKind?: LaborKind;
  readonly projectId?: string;
}

interface PayrollRuleRow {
  readonly id: string;
  readonly tenant: TenantId;
  readonly ruleId: PayrollRuleId;
  readonly name: string | null;
  readonly basis: EarningsBasis;
  readonly rateMinor: number;
  readonly coefficient: number;
  readonly scope: PayrollRuleScope;
  readonly objectVersion: number;
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

type CreatePayrollRuleInput = Omit<PayrollRuleRow, 'id' | 'createdAt'>;

interface PayRunRuleRef {
  readonly ruleId: PayrollRuleId;
  readonly ruleVersion: number;
}

interface PayRunRow {
  readonly id: PayRunId;
  readonly tenant: TenantId;
  readonly personId: UserId;
  readonly periodKey: string;
  readonly periodKind: PayPeriodKind;
  readonly ruleVersions: readonly PayRunRuleRef[];
  readonly totalQuantity: number;
  readonly totalAmountMinor: number;
  readonly lineCount: number;
  readonly computedBy: string;
  readonly computedAt: string;
  readonly objectVersion: number;
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

type AppendPayRunInput = Omit<PayRunRow, 'id' | 'createdAt'>;

interface EarningsRecordRow {
  readonly id: EarningsRecordId;
  readonly tenant: TenantId;
  readonly seq: number;
  readonly personId: UserId;
  readonly periodKey: string;
  readonly ruleId: PayrollRuleId;
  readonly ruleVersion: number;
  readonly basis: EarningsBasis;
  readonly laborKind: LaborKind;
  readonly quantity: number;
  readonly rateMinor: number;
  readonly coefficient: number;
  readonly amountMinor: number;
  readonly payRunId: PayRunId;
  readonly sourceRefs: readonly string[];
  readonly sourceKey: string;
  readonly occurredAt: string;
  readonly recordedBy: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

type AppendEarningsRecordInput = Omit<
  EarningsRecordRow,
  'id' | 'seq' | 'objectVersion' | 'availableTime'
> & { readonly availableTime?: string };

interface ListEarningsRecordsFilter {
  readonly periodKey?: string | undefined;
  readonly personId?: UserId | undefined;
  readonly payRunId?: PayRunId | undefined;
  readonly laborKind?: LaborKind | undefined;
  readonly ruleId?: PayrollRuleId | undefined;
}

/** 冲突错误镜像（name 同形——payroll 侧 isPayrollConflict 按 name 识别）。 */
class PayrollConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollConflictError';
  }
}

// ---- 工具 ----

function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new PayrollConflictError(message);
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

function scopeToJson(scope: PayrollRuleScope): Prisma.InputJsonObject {
  return {
    ...(scope.personId === undefined ? {} : { personId: scope.personId }),
    ...(scope.laborKind === undefined ? {} : { laborKind: scope.laborKind }),
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
  };
}

function scopeFromJson(raw: unknown): PayrollRuleScope {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record['personId'] === 'string' ? { personId: UserId.create(record['personId']) } : {}),
    ...(typeof record['laborKind'] === 'string' ? { laborKind: record['laborKind'] as LaborKind } : {}),
    ...(typeof record['projectId'] === 'string' ? { projectId: record['projectId'] } : {}),
  };
}

function ruleVersionsToJson(refs: readonly PayRunRuleRef[]): Prisma.InputJsonValue {
  return refs.map((ref) => ({ ruleId: ref.ruleId, ruleVersion: ref.ruleVersion }));
}

function ruleVersionsFromJson(raw: unknown): readonly PayRunRuleRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record['ruleId'] !== 'string' || typeof record['ruleVersion'] !== 'number') return [];
    return [{ ruleId: PayrollRuleId.create(record['ruleId']), ruleVersion: record['ruleVersion'] }];
  });
}

function sourceRefsToJson(refs: readonly string[]): Prisma.InputJsonValue {
  return [...refs];
}

function sourceRefsFromJson(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

// ---- 计薪规则版本 ----

type PayrollRuleDbRow = {
  id: string;
  tenantId: string;
  ruleId: string;
  name: string | null;
  basis: string;
  rateMinor: number;
  coefficient: number;
  scope: unknown;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toRuleRow(row: PayrollRuleDbRow): PayrollRuleRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    ruleId: PayrollRuleId.create(row.ruleId),
    name: row.name,
    basis: row.basis as EarningsBasis,
    rateMinor: row.rateMinor,
    coefficient: row.coefficient,
    scope: scopeFromJson(row.scope),
    objectVersion: row.objectVersion,
    supersedes: row.supersedes,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgPayrollRuleStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: CreatePayrollRuleInput): Promise<PayrollRuleRow> {
    try {
      const row = await this.prisma.payrollRuleRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          ruleId: input.ruleId,
          name: input.name,
          basis: input.basis,
          rateMinor: input.rateMinor,
          coefficient: input.coefficient,
          scope: scopeToJson(input.scope),
          objectVersion: input.objectVersion,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toRuleRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `计薪规则 ${input.ruleId} 版本 ${input.objectVersion} 唯一约束冲突（并发发布竞态或 supersedes 链分叉）`,
      );
    }
  }

  async versions(tenant: TenantId, ruleId: PayrollRuleId): Promise<readonly PayrollRuleRow[]> {
    const rows = await this.prisma.payrollRuleRecord.findMany({
      where: { tenantId: tenant, ruleId },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toRuleRow(row));
  }

  async listAll(tenant: TenantId): Promise<readonly PayrollRuleRow[]> {
    const rows = await this.prisma.payrollRuleRecord.findMany({
      where: { tenantId: tenant },
      orderBy: [{ ruleId: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toRuleRow(row));
  }
}

// ---- 核算批次快照 ----

type PayRunDbRow = {
  id: string;
  tenantId: string;
  personId: string;
  periodKey: string;
  periodKind: string;
  ruleVersions: unknown;
  totalQuantity: number;
  totalAmountMinor: number;
  lineCount: number;
  computedBy: string;
  computedAt: Date;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  createdAt: Date;
};

function toRunRow(row: PayRunDbRow): PayRunRow {
  return {
    id: PayRunId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    personId: UserId.create(row.personId),
    periodKey: row.periodKey,
    periodKind: row.periodKind as PayPeriodKind,
    ruleVersions: ruleVersionsFromJson(row.ruleVersions),
    totalQuantity: row.totalQuantity,
    totalAmountMinor: row.totalAmountMinor,
    lineCount: row.lineCount,
    computedBy: row.computedBy,
    computedAt: row.computedAt.toISOString(),
    objectVersion: row.objectVersion,
    supersedes: row.supersedes,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgPayRunStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendPayRunInput): Promise<PayRunRow> {
    try {
      const row = await this.prisma.payRunRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          personId: input.personId,
          periodKey: input.periodKey,
          periodKind: input.periodKind,
          ruleVersions: ruleVersionsToJson(input.ruleVersions),
          totalQuantity: input.totalQuantity,
          totalAmountMinor: input.totalAmountMinor,
          lineCount: input.lineCount,
          computedBy: input.computedBy,
          computedAt: new Date(input.computedAt),
          objectVersion: input.objectVersion,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toRunRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `核算批次 ${input.personId} ${input.periodKey} 版本 ${input.objectVersion} 唯一约束冲突（并发重算竞态或 supersedes 链分叉）`,
      );
    }
  }

  async find(tenant: TenantId, id: PayRunId): Promise<PayRunRow | null> {
    const row = await this.prisma.payRunRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toRunRow(row);
  }

  async chain(tenant: TenantId, periodKey: string, personId: UserId): Promise<readonly PayRunRow[]> {
    const rows = await this.prisma.payRunRecord.findMany({
      where: { tenantId: tenant, periodKey, personId },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toRunRow(row));
  }

  async listByPeriod(tenant: TenantId, periodKey: string, personId?: UserId): Promise<readonly PayRunRow[]> {
    const rows = await this.prisma.payRunRecord.findMany({
      where: { tenantId: tenant, periodKey, ...(personId === undefined ? {} : { personId }) },
      orderBy: [{ personId: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toRunRow(row));
  }

  async listByPerson(tenant: TenantId, personId: UserId): Promise<readonly PayRunRow[]> {
    const rows = await this.prisma.payRunRecord.findMany({
      where: { tenantId: tenant, personId },
      orderBy: [{ periodKey: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toRunRow(row));
  }
}

// ---- 薪酬记录（append-only 事实） ----

type EarningsRecordDbRow = {
  id: string;
  tenantId: string;
  seq: bigint;
  personId: string;
  periodKey: string;
  ruleId: string;
  ruleVersion: number;
  basis: string;
  laborKind: string;
  quantity: number;
  rateMinor: number;
  coefficient: number;
  amountMinor: number;
  payRunId: string;
  sourceRefs: unknown;
  sourceKey: string;
  occurredAt: Date;
  recordedBy: string;
  objectVersion: number;
  auditStatus: string;
  provenance: unknown;
  supersedes: string | null;
  businessTime: Date | null;
  availableTime: Date | null;
};

function toEarningsRow(row: EarningsRecordDbRow): EarningsRecordRow {
  return {
    id: EarningsRecordId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    personId: UserId.create(row.personId),
    periodKey: row.periodKey,
    ruleId: PayrollRuleId.create(row.ruleId),
    ruleVersion: row.ruleVersion,
    basis: row.basis as EarningsBasis,
    laborKind: row.laborKind as LaborKind,
    quantity: row.quantity,
    rateMinor: row.rateMinor,
    coefficient: row.coefficient,
    amountMinor: row.amountMinor,
    payRunId: PayRunId.create(row.payRunId),
    sourceRefs: sourceRefsFromJson(row.sourceRefs),
    sourceKey: row.sourceKey,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
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

export class PgEarningsRecordStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendEarningsRecordInput): Promise<EarningsRecordRow> {
    try {
      const row = await this.prisma.earningsRecordRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          personId: input.personId,
          periodKey: input.periodKey,
          ruleId: input.ruleId,
          ruleVersion: input.ruleVersion,
          basis: input.basis,
          laborKind: input.laborKind,
          quantity: input.quantity,
          rateMinor: input.rateMinor,
          coefficient: input.coefficient,
          amountMinor: input.amountMinor,
          payRunId: input.payRunId,
          sourceRefs: sourceRefsToJson(input.sourceRefs),
          sourceKey: input.sourceKey,
          occurredAt: new Date(input.occurredAt),
          recordedBy: input.recordedBy,
          objectVersion: 1,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
          businessTime: isoToDate(input.businessTime) ?? null,
          ...(input.availableTime === undefined ? {} : { availableTime: isoToDate(input.availableTime) ?? null }),
        },
      });
      return toEarningsRow(row);
    } catch (error) {
      throw toConflict(error, `薪酬记录 sourceKey '${input.sourceKey}' 已落账（核算行幂等锚点）`);
    }
  }

  async find(tenant: TenantId, id: EarningsRecordId): Promise<EarningsRecordRow | null> {
    const row = await this.prisma.earningsRecordRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toEarningsRow(row);
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<EarningsRecordRow | null> {
    const row = await this.prisma.earningsRecordRecord.findFirst({ where: { tenantId: tenant, sourceKey } });
    return row === null ? null : toEarningsRow(row);
  }

  async list(tenant: TenantId, filter?: ListEarningsRecordsFilter): Promise<readonly EarningsRecordRow[]> {
    const rows = await this.prisma.earningsRecordRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter === undefined
          ? {}
          : {
              ...(filter.periodKey === undefined ? {} : { periodKey: filter.periodKey }),
              ...(filter.personId === undefined ? {} : { personId: filter.personId }),
              ...(filter.payRunId === undefined ? {} : { payRunId: filter.payRunId }),
              ...(filter.laborKind === undefined ? {} : { laborKind: filter.laborKind }),
              ...(filter.ruleId === undefined ? {} : { ruleId: filter.ruleId }),
            }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toEarningsRow(row));
  }
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgPayrollDomainEventStore {
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
            ...(row.provenance === undefined ? {} : { provenance: row.provenance as Prisma.InputJsonObject }),
            payload: row.payload as Prisma.InputJsonObject,
          },
        }),
        this.prisma.outboxRecord.create({
          data: { eventId: outbox.eventId, tenantId: outbox.tenantId, createdAt: outbox.createdAt },
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PayrollConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

export class PgPayrollOperationLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.payrollOperationRecord.create({
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

export interface PayrollStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/**
 * 组合根装配句柄：五端口实现。结构同形兼容 @smes/payroll 的 PayrollStores
 * 槽位（组合根注入时结构校验），可直接喂 PayrollService 构造函数。
 */
export interface PayrollStoreHandle {
  readonly ruleStore: PgPayrollRuleStore;
  readonly runStore: PgPayRunStore;
  readonly recordStore: PgEarningsRecordStore;
  readonly eventStore: PgPayrollDomainEventStore;
  readonly operationStore: PgPayrollOperationLedger;
  readonly stores: {
    readonly rules: PgPayrollRuleStore;
    readonly runs: PgPayRunStore;
    readonly records: PgEarningsRecordStore;
    readonly events: PgPayrollDomainEventStore;
    readonly operations: PgPayrollOperationLedger;
  };
  disconnect(): Promise<void>;
}

/** 构造 payroll PG 存储装配（惰性连接：见文件头）。 */
export function connectPayrollStore(options: PayrollStoreOptions = {}): PayrollStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  const ruleStore = new PgPayrollRuleStore(client);
  const runStore = new PgPayRunStore(client);
  const recordStore = new PgEarningsRecordStore(client);
  const eventStore = new PgPayrollDomainEventStore(client);
  const operationStore = new PgPayrollOperationLedger(client);
  return {
    ruleStore,
    runStore,
    recordStore,
    eventStore,
    operationStore,
    stores: {
      rules: ruleStore,
      runs: runStore,
      records: recordStore,
      events: eventStore,
      operations: operationStore,
    },
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
