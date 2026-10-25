/**
 * maintenance 五端口的 PG 实现 + 组合根装配工厂（M3，经本包 `./maintenance`
 * 子路径导出——与 `./payroll` / `./drawing` 同模式：主入口保持零 @prisma/client
 * 依赖）。启动零 DB 依赖：connectMaintenanceStore 只构造 PrismaClient（惰性
 * 连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * **结构同形取舍（pro-pack-tier-edges 推论，写明）**：dep-cruiser 禁止
 * business-store import @smes/maintenance（专业包不在 store-tier-edges 白名单），
 * 故本文件不 import 其类型，改用**本地结构化镜像类型**（与
 * packages/maintenance/src/maintenance-stores.ts 的行/端口形状逐字段同形——品牌化
 * id 用 business-core defineId 以同名品牌声明，类型统一于同一 Brand 符号）。
 * 组合根注入时由 TypeScript 结构校验兼容（Pg* 类可直接喂 MaintenanceService 的
 * MaintenanceStores 槽位）。冲突信号用同名错误类承载（name ===
 * 'MaintenanceConflictError'），maintenance 侧 isMaintenanceConflict 按 name 识别
 * ——跨包可观察行为等价。
 *
 * 实现：
 *  - PgMaintenancePlanStore → 计划版本（maintenance_plans；(tenant, planId,
 *    objectVersion) 与 (tenant, supersedes) 唯一，P2002 → MaintenanceConflictError）
 *  - PgMaintenanceTaskStore → 任务投影（maintenance_tasks；(tenant, sourceKey)
 *    唯一 = due-scan 到期锚点；advance = 行级乐观锁条件更新，失配返回 null）
 *  - PgMaintenanceActivityStore → 三态记录事实（maintenance_activities；append-only
 *    触发器背书；seq bigserial；id 前缀按 kind ckr-/upr-/rpr-）
 *  - PgMaintenanceDomainEventStore → 事件 + Outbox 同事务落账（复用 event_records /
 *    outbox_records 与既有行映射；eventId 幂等锚点）
 *  - PgMaintenanceOperationLedger → 命令幂等账本（maintenance_operations；(tenant,
 *    operationId) 唯一，P2002 = 已落账 → claim false）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantId, UserId, defineId, type BusinessEvent } from '@smes/business-core';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

// ---- 本地结构同形镜像（与 @smes/maintenance 同名品牌/同形行；不 import 该包） ----

const MaintenancePlanId = defineId('MaintenancePlanId');
type MaintenancePlanId = ReturnType<typeof MaintenancePlanId.create>;
const MaintenanceTaskId = defineId('MaintenanceTaskId');
type MaintenanceTaskId = ReturnType<typeof MaintenanceTaskId.create>;
const CheckpointRecordId = defineId('CheckpointRecordId');
type CheckpointRecordId = ReturnType<typeof CheckpointRecordId.create>;
const UpkeepRecordId = defineId('UpkeepRecordId');
type UpkeepRecordId = ReturnType<typeof UpkeepRecordId.create>;
const RepairRecordId = defineId('RepairRecordId');
type RepairRecordId = ReturnType<typeof RepairRecordId.create>;

type MaintenanceCycle = { readonly kind: 'daily' } | { readonly kind: 'interval'; readonly days: number };
type MaintenanceTaskSource = 'plan-due' | 'fault' | 'manual';
type MaintenanceTaskKind = 'repair' | 'upkeep' | 'checkpoint';

interface CheckpointDef {
  readonly checkpointId: string;
  readonly label: string;
  readonly expectation?: string;
}

interface MaintenancePlanRow {
  readonly id: string;
  readonly tenant: TenantId;
  readonly planId: MaintenancePlanId;
  readonly name: string | null;
  readonly resourceRef: string;
  readonly cycle: MaintenanceCycle;
  readonly checkpoints: readonly CheckpointDef[];
  readonly upkeepActions: readonly string[];
  readonly objectVersion: number;
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

type CreateMaintenancePlanInput = Omit<MaintenancePlanRow, 'id' | 'createdAt'>;

interface MaintenanceTaskRow {
  readonly id: MaintenanceTaskId;
  readonly tenant: TenantId;
  readonly flowConfigId: string;
  readonly source: MaintenanceTaskSource;
  readonly kind: MaintenanceTaskKind;
  readonly resourceRef: string;
  readonly faultRef?: string;
  readonly planId?: MaintenancePlanId;
  readonly planVersion?: number;
  readonly dueKey?: string;
  readonly dueAt?: string;
  readonly assignee?: UserId;
  readonly state: string;
  readonly objectVersion: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  readonly sourceKey?: string;
}

type CreateMaintenanceTaskInput = Omit<MaintenanceTaskRow, 'id' | 'createdAt'>;

interface MaintenanceTaskAdvance {
  readonly state: string;
  readonly objectVersion: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

interface ListMaintenanceTasksFilter {
  readonly source?: MaintenanceTaskSource | undefined;
  readonly kind?: MaintenanceTaskKind | undefined;
  readonly state?: string | undefined;
  readonly assignee?: UserId | undefined;
  readonly resourceRef?: string | undefined;
  readonly planId?: MaintenancePlanId | undefined;
}

interface MaintenanceActivityCommon {
  readonly tenant: TenantId;
  readonly seq: number;
  readonly resourceRef: string;
  readonly planId?: MaintenancePlanId;
  readonly planVersion?: number;
  readonly taskId?: MaintenanceTaskId;
  readonly performedBy: UserId;
  readonly performedAt: string;
  readonly note?: string;
  readonly occurredAt: string;
  readonly recordedBy: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

interface CheckpointActivityRow extends MaintenanceActivityCommon {
  readonly kind: 'checkpoint';
  readonly id: CheckpointRecordId;
  readonly checkpointId: string;
  readonly result: 'pass' | 'fail';
}

interface UpkeepActivityRow extends MaintenanceActivityCommon {
  readonly kind: 'upkeep';
  readonly id: UpkeepRecordId;
  readonly actionsDone?: readonly string[];
}

interface RepairActivityRow extends MaintenanceActivityCommon {
  readonly kind: 'repair';
  readonly id: RepairRecordId;
  readonly faultRef?: string;
  readonly restored: boolean;
}

type MaintenanceActivityRow = CheckpointActivityRow | UpkeepActivityRow | RepairActivityRow;

/** 分布式 Omit（Omit 直接套联合会坍缩成公共键——判别联合必须逐成员裁剪）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type AppendMaintenanceActivityInput = DistributiveOmit<MaintenanceActivityRow, 'id' | 'seq' | 'objectVersion'>;

interface MaintenanceActivityQuery {
  readonly resourceRef?: string;
  readonly kind?: MaintenanceActivityRow['kind'];
  readonly taskId?: MaintenanceTaskId;
  readonly planId?: MaintenancePlanId;
  readonly from?: string;
  readonly to?: string;
}

/** 冲突错误镜像（name 同形——maintenance 侧 isMaintenanceConflict 按 name 识别）。 */
class MaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConflictError';
  }
}

// ---- 工具 ----

function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new MaintenanceConflictError(message);
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

function cycleToJson(cycle: MaintenanceCycle): Prisma.InputJsonObject {
  return cycle.kind === 'daily'
    ? { kind: 'daily' }
    : { kind: 'interval', days: cycle.days };
}

function cycleFromJson(raw: unknown): MaintenanceCycle {
  if (typeof raw !== 'object' || raw === null) return { kind: 'daily' };
  const record = raw as Record<string, unknown>;
  if (record['kind'] === 'daily') return { kind: 'daily' };
  if (record['kind'] === 'interval' && typeof record['days'] === 'number') {
    return { kind: 'interval', days: record['days'] };
  }
  return { kind: 'daily' };
}

function checkpointsToJson(defs: readonly CheckpointDef[]): Prisma.InputJsonValue {
  return defs.map((def) => ({
    checkpointId: def.checkpointId,
    label: def.label,
    ...(def.expectation === undefined ? {} : { expectation: def.expectation }),
  }));
}

function checkpointsFromJson(raw: unknown): readonly CheckpointDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record['checkpointId'] !== 'string' || typeof record['label'] !== 'string') return [];
    return [
      {
        checkpointId: record['checkpointId'],
        label: record['label'],
        ...(typeof record['expectation'] === 'string' ? { expectation: record['expectation'] } : {}),
      },
    ];
  });
}

function stringListToJson(values: readonly string[]): Prisma.InputJsonValue {
  return [...values];
}

function stringListFromJson(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

// ---- 维保计划版本 ----

type MaintenancePlanDbRow = {
  id: string;
  tenantId: string;
  planId: string;
  name: string | null;
  resourceRef: string;
  cycle: unknown;
  checkpoints: unknown;
  upkeepActions: unknown;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toPlanRow(row: MaintenancePlanDbRow): MaintenancePlanRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    planId: MaintenancePlanId.create(row.planId),
    name: row.name,
    resourceRef: row.resourceRef,
    cycle: cycleFromJson(row.cycle),
    checkpoints: checkpointsFromJson(row.checkpoints),
    upkeepActions: stringListFromJson(row.upkeepActions),
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

export class PgMaintenancePlanStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: CreateMaintenancePlanInput): Promise<MaintenancePlanRow> {
    try {
      const row = await this.prisma.maintenancePlanRecord.create({
        data: {
          id: `mpl-${uuidv7()}`,
          tenantId: input.tenant,
          planId: input.planId,
          name: input.name,
          resourceRef: input.resourceRef,
          cycle: cycleToJson(input.cycle),
          checkpoints: checkpointsToJson(input.checkpoints),
          upkeepActions: stringListToJson(input.upkeepActions),
          objectVersion: input.objectVersion,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toPlanRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `维保计划 ${input.planId} 版本 ${input.objectVersion} 唯一约束冲突（并发发布竞态或 supersedes 链分叉）`,
      );
    }
  }

  async versions(tenant: TenantId, planId: MaintenancePlanId): Promise<readonly MaintenancePlanRow[]> {
    const rows = await this.prisma.maintenancePlanRecord.findMany({
      where: { tenantId: tenant, planId },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toPlanRow(row));
  }

  async listAll(tenant: TenantId): Promise<readonly MaintenancePlanRow[]> {
    const rows = await this.prisma.maintenancePlanRecord.findMany({
      where: { tenantId: tenant },
      orderBy: [{ planId: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toPlanRow(row));
  }
}

// ---- 维保任务（状态机投影行） ----

type MaintenanceTaskDbRow = {
  id: string;
  tenantId: string;
  flowConfigId: string;
  source: string;
  kind: string;
  resourceRef: string;
  faultRef: string | null;
  planId: string | null;
  planVersion: number | null;
  dueKey: string | null;
  dueAt: Date | null;
  assignee: string | null;
  state: string;
  objectVersion: number;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  sourceKey: string | null;
};

function toTaskRow(row: MaintenanceTaskDbRow): MaintenanceTaskRow {
  return {
    id: MaintenanceTaskId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    flowConfigId: row.flowConfigId,
    source: row.source as MaintenanceTaskSource,
    kind: row.kind as MaintenanceTaskKind,
    resourceRef: row.resourceRef,
    ...(row.faultRef === null ? {} : { faultRef: row.faultRef }),
    ...(row.planId === null ? {} : { planId: MaintenancePlanId.create(row.planId) }),
    ...(row.planVersion === null ? {} : { planVersion: row.planVersion }),
    ...(row.dueKey === null ? {} : { dueKey: row.dueKey }),
    ...(row.dueAt === null ? {} : { dueAt: row.dueAt.toISOString() }),
    ...(row.assignee === null ? {} : { assignee: UserId.create(row.assignee) }),
    state: row.state,
    objectVersion: row.objectVersion,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt.toISOString() }),
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt.toISOString() }),
    ...(row.cancelReason === null ? {} : { cancelReason: row.cancelReason }),
    ...(row.sourceKey === null ? {} : { sourceKey: row.sourceKey }),
  };
}

export class PgMaintenanceTaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: CreateMaintenanceTaskInput): Promise<MaintenanceTaskRow> {
    try {
      const row = await this.prisma.maintenanceTaskRecord.create({
        data: {
          id: `mtk-${uuidv7()}`,
          tenantId: input.tenant,
          flowConfigId: input.flowConfigId,
          source: input.source,
          kind: input.kind,
          resourceRef: input.resourceRef,
          ...(input.faultRef === undefined ? {} : { faultRef: input.faultRef }),
          ...(input.planId === undefined ? {} : { planId: input.planId }),
          ...(input.planVersion === undefined ? {} : { planVersion: input.planVersion }),
          ...(input.dueKey === undefined ? {} : { dueKey: input.dueKey }),
          ...(input.dueAt === undefined ? {} : { dueAt: new Date(input.dueAt) }),
          ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
          state: input.state,
          objectVersion: input.objectVersion,
          createdBy: input.createdBy,
          ...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
        },
      });
      return toTaskRow(row);
    } catch (error) {
      throw toConflict(
        error,
        input.sourceKey === undefined
          ? `维保任务落账冲突：${error instanceof Error ? error.message : String(error)}`
          : `任务到期锚点 '${input.sourceKey}' 已落账（due-scan 幂等去重）`,
      );
    }
  }

  async find(tenant: TenantId, id: MaintenanceTaskId): Promise<MaintenanceTaskRow | null> {
    const row = await this.prisma.maintenanceTaskRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toTaskRow(row);
  }

  async advance(
    tenant: TenantId,
    id: MaintenanceTaskId,
    expectedObjectVersion: number,
    next: MaintenanceTaskAdvance,
  ): Promise<MaintenanceTaskRow | null> {
    const updated = await this.prisma.maintenanceTaskRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: next.state,
        objectVersion: next.objectVersion,
        ...(next.startedAt === undefined ? {} : { startedAt: new Date(next.startedAt) }),
        ...(next.completedAt === undefined ? {} : { completedAt: new Date(next.completedAt) }),
        ...(next.cancelledAt === undefined ? {} : { cancelledAt: new Date(next.cancelledAt) }),
        ...(next.cancelReason === undefined ? {} : { cancelReason: next.cancelReason }),
      },
    });
    if (updated.count !== 1) return null; // 乐观锁失配或行不存在
    const row = await this.prisma.maintenanceTaskRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toTaskRow(row);
  }

  async list(tenant: TenantId, filter?: ListMaintenanceTasksFilter): Promise<readonly MaintenanceTaskRow[]> {
    const rows = await this.prisma.maintenanceTaskRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter === undefined
          ? {}
          : {
              ...(filter.source === undefined ? {} : { source: filter.source }),
              ...(filter.kind === undefined ? {} : { kind: filter.kind }),
              ...(filter.state === undefined ? {} : { state: filter.state }),
              ...(filter.assignee === undefined ? {} : { assignee: filter.assignee }),
              ...(filter.resourceRef === undefined ? {} : { resourceRef: filter.resourceRef }),
              ...(filter.planId === undefined ? {} : { planId: filter.planId }),
            }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => toTaskRow(row));
  }
}

// ---- 三态记录（append-only 事实） ----

type MaintenanceActivityDbRow = {
  id: string;
  tenantId: string;
  seq: bigint;
  kind: string;
  resourceRef: string;
  planId: string | null;
  planVersion: number | null;
  taskId: string | null;
  checkpointId: string | null;
  result: string | null;
  actionsDone: unknown;
  faultRef: string | null;
  restored: boolean | null;
  performedBy: string;
  performedAt: Date;
  note: string | null;
  occurredAt: Date;
  recordedBy: string;
  objectVersion: number;
  auditStatus: string;
  provenance: unknown;
  supersedes: string | null;
  businessTime: Date | null;
  availableTime: Date | null;
};

function toActivityRow(row: MaintenanceActivityDbRow): MaintenanceActivityRow {
  const common = {
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    resourceRef: row.resourceRef,
    ...(row.planId === null ? {} : { planId: MaintenancePlanId.create(row.planId) }),
    ...(row.planVersion === null ? {} : { planVersion: row.planVersion }),
    ...(row.taskId === null ? {} : { taskId: MaintenanceTaskId.create(row.taskId) }),
    performedBy: UserId.create(row.performedBy),
    performedAt: row.performedAt.toISOString(),
    ...(row.note === null ? {} : { note: row.note }),
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
  if (row.kind === 'checkpoint') {
    return {
      ...common,
      kind: 'checkpoint',
      id: CheckpointRecordId.create(row.id),
      checkpointId: row.checkpointId ?? '',
      result: (row.result === 'fail' ? 'fail' : 'pass') as 'pass' | 'fail',
    };
  }
  if (row.kind === 'upkeep') {
    return {
      ...common,
      kind: 'upkeep',
      id: UpkeepRecordId.create(row.id),
      ...(stringListFromJson(row.actionsDone).length === 0
        ? {}
        : { actionsDone: stringListFromJson(row.actionsDone) }),
    };
  }
  return {
    ...common,
    kind: 'repair',
    id: RepairRecordId.create(row.id),
    ...(row.faultRef === null ? {} : { faultRef: row.faultRef }),
    restored: row.restored === true,
  };
}

export class PgMaintenanceActivityStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendMaintenanceActivityInput): Promise<MaintenanceActivityRow> {
    const base = {
      tenantId: input.tenant,
      resourceRef: input.resourceRef,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.planVersion === undefined ? {} : { planVersion: input.planVersion }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      performedBy: input.performedBy,
      performedAt: new Date(input.performedAt),
      ...(input.note === undefined ? {} : { note: input.note }),
      occurredAt: new Date(input.occurredAt),
      recordedBy: input.recordedBy,
      objectVersion: 1,
      auditStatus: input.auditStatus,
      ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
      ...(input.businessTime === undefined ? {} : { businessTime: new Date(input.businessTime) }),
      ...(input.availableTime === undefined ? {} : { availableTime: new Date(input.availableTime) }),
    };
    try {
      const row =
        input.kind === 'checkpoint'
          ? await this.prisma.maintenanceActivityRecord.create({
              data: {
                ...base,
                id: `ckr-${uuidv7()}`,
                kind: 'checkpoint',
                checkpointId: input.checkpointId,
                result: input.result,
              },
            })
          : input.kind === 'upkeep'
            ? await this.prisma.maintenanceActivityRecord.create({
                data: {
                  ...base,
                  id: `upr-${uuidv7()}`,
                  kind: 'upkeep',
                  ...(input.actionsDone === undefined || input.actionsDone.length === 0
                    ? {}
                    : { actionsDone: stringListToJson(input.actionsDone) }),
                },
              })
            : await this.prisma.maintenanceActivityRecord.create({
                data: {
                  ...base,
                  id: `rpr-${uuidv7()}`,
                  kind: 'repair',
                  ...(input.faultRef === undefined ? {} : { faultRef: input.faultRef }),
                  restored: input.restored,
                },
              });
      return toActivityRow(row);
    } catch (error) {
      throw toConflict(error, `三态记录落账冲突：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async list(tenant: TenantId, query?: MaintenanceActivityQuery): Promise<readonly MaintenanceActivityRow[]> {
    const rows = await this.prisma.maintenanceActivityRecord.findMany({
      where: {
        tenantId: tenant,
        ...(query === undefined
          ? {}
          : {
              ...(query.resourceRef === undefined ? {} : { resourceRef: query.resourceRef }),
              ...(query.kind === undefined ? {} : { kind: query.kind }),
              ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
              ...(query.planId === undefined ? {} : { planId: query.planId }),
              ...(query.from === undefined ? {} : { performedAt: { gte: new Date(query.from) } }),
              ...(query.to === undefined
                ? {}
                : {
                    performedAt: query.from === undefined ? { lte: new Date(query.to) } : { gte: new Date(query.from), lte: new Date(query.to) },
                  }),
            }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toActivityRow(row));
  }
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgMaintenanceDomainEventStore {
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
        throw new MaintenanceConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

export class PgMaintenanceOperationLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.maintenanceOperationRecord.create({
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

export interface MaintenanceStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/**
 * 组合根装配句柄：五端口实现。结构同形兼容 @smes/maintenance 的
 * MaintenanceStores 槽位（组合根注入时结构校验），可直接喂 MaintenanceService
 * 构造函数。
 */
export interface MaintenanceStoreHandle {
  readonly planStore: PgMaintenancePlanStore;
  readonly taskStore: PgMaintenanceTaskStore;
  readonly activityStore: PgMaintenanceActivityStore;
  readonly eventStore: PgMaintenanceDomainEventStore;
  readonly operationStore: PgMaintenanceOperationLedger;
  readonly stores: {
    readonly plans: PgMaintenancePlanStore;
    readonly tasks: PgMaintenanceTaskStore;
    readonly activities: PgMaintenanceActivityStore;
    readonly events: PgMaintenanceDomainEventStore;
    readonly operations: PgMaintenanceOperationLedger;
  };
  disconnect(): Promise<void>;
}

/** 构造 maintenance PG 存储装配（惰性连接：见文件头）。 */
export function connectMaintenanceStore(options: MaintenanceStoreOptions = {}): MaintenanceStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const planStore = new PgMaintenancePlanStore(prisma);
  const taskStore = new PgMaintenanceTaskStore(prisma);
  const activityStore = new PgMaintenanceActivityStore(prisma);
  const eventStore = new PgMaintenanceDomainEventStore(prisma);
  const operationStore = new PgMaintenanceOperationLedger(prisma);
  return {
    planStore,
    taskStore,
    activityStore,
    eventStore,
    operationStore,
    stores: {
      plans: planStore,
      tasks: taskStore,
      activities: activityStore,
      events: eventStore,
      operations: operationStore,
    },
    async disconnect(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
