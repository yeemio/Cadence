/**
 * baseline P1 端口的内存先行实现（M2-W2；体例同 in-memory-masterdata-stores：
 * 重启即失，PG 实现在 business-store `./baseline`；无 DATABASE_URL / 未注入存储时
 * 组合根回落到这里，零 DB boot 语义完整）。
 *
 * 版本化主数据三端口共用一个泛型内核（链不变量由唯一性检查背书：
 * (tenant, code, objectVersion) 冲突与 (tenant, supersedes) 冲突都抛
 * BaselineConflictError——与 PG 实现同一合同）。
 */
import { randomUUID } from 'node:crypto';
import type { BusinessEvent, TenantId } from '@smes/business-core';
import { BaselineConflictError } from './baseline-errors.js';
import { baselineUuidv7, FaultReportId } from './baseline-ids.js';
import type {
  BaselineEventStore,
  BaselineOperationLedger,
  BaselineStores,
  CreateEquipmentInput,
  CreateFaultReportInput,
  CreateOutsourcingPriceRuleInput,
  CreateProcessDefInput,
  CreateRoutingInput,
  CreateStandardTimeInput,
  EquipmentRow,
  EquipmentStore,
  FaultReport,
  FaultReportAdvanceExtra,
  FaultReportStore,
  ListFaultReportsFilter,
  MaterialValidationRunRow,
  MaterialValidationRunStore,
  MaterialValidationRunSummaryView,
  OutsourcingPriceRuleRow,
  OutsourcingPriceRuleStore,
  ProcessDefRow,
  ProcessDefStore,
  RoutingRow,
  RoutingStore,
  StandardTimeRow,
  StandardTimeStore,
} from './baseline-stores.js';

let memoryCounter = 0;

/** 内存形态 id（端口合同只要求租户内唯一、创建后稳定）。 */
function nextMemoryId(prefix: string): string {
  memoryCounter += 1;
  return `${prefix}-${randomUUID()}-${memoryCounter.toString(36)}`;
}

interface MasterInsertInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

/** 版本化主数据内存内核（三端口共用）。 */
class InMemoryVersionedMasterStore<Row extends { readonly tenant: TenantId; readonly id: string; readonly code: string; readonly objectVersion: number; readonly supersedes: string | null }> {
  private readonly rows = new Map<string, Row>(); // key: `${tenant}|${id}`
  private readonly byCode = new Map<string, Row[]>(); // key: `${tenant}|${code}`

  constructor(private readonly label: string) {}

  async insert(input: MasterInsertInput & Omit<Row, 'id' | 'tenant' | 'code' | 'objectVersion' | 'supersedes' | 'createdAt'>): Promise<Row> {
    const versions = this.byCode.get(`${input.tenant}|${input.code}`) ?? [];
    if (versions.some((row) => row.objectVersion === input.objectVersion)) {
      throw new BaselineConflictError(
        `${this.label} '${input.code}' 版本 ${input.objectVersion} 已存在（并发写入竞态）`,
      );
    }
    if (input.supersedes !== null && versions.some((row) => row.supersedes === input.supersedes)) {
      throw new BaselineConflictError(
        `${this.label} '${input.code}' 的前任行已被取代（supersedes 链分叉，并发写入竞态）`,
      );
    }
    const row = {
      ...input,
      id: nextMemoryId('bl'),
    } as unknown as Row; // 内核不做形状收窄：类型由三个薄壳端口约束
    this.rows.set(`${row.tenant}|${row.id}`, row);
    const bucket = this.byCode.get(`${input.tenant}|${input.code}`);
    if (bucket === undefined) this.byCode.set(`${input.tenant}|${input.code}`, [row]);
    else bucket.push(row);
    return row;
  }

  async versions(tenant: TenantId, code: string): Promise<readonly Row[]> {
    return [...(this.byCode.get(`${tenant}|${code}`) ?? [])].sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listAll(tenant: TenantId): Promise<readonly Row[]> {
    const all: Row[] = [];
    for (const bucket of this.byCode.values()) {
      for (const row of bucket) if (row.tenant === tenant) all.push(row);
    }
    return all.sort((a, b) => a.code.localeCompare(b.code) || a.objectVersion - b.objectVersion);
  }
}

function withCreatedAt<Fields extends object>(fields: Fields): Fields & { createdAt: string } {
  return { ...fields, createdAt: new Date().toISOString() };
}

export class InMemoryProcessDefStore extends InMemoryVersionedMasterStore<ProcessDefRow> implements ProcessDefStore {
  constructor() {
    super('工序');
  }

  override insert(input: CreateProcessDefInput): Promise<ProcessDefRow> {
    return super.insert(withCreatedAt(input));
  }
}

export class InMemoryEquipmentStore extends InMemoryVersionedMasterStore<EquipmentRow> implements EquipmentStore {
  constructor() {
    super('设备');
  }

  override insert(input: CreateEquipmentInput): Promise<EquipmentRow> {
    return super.insert(withCreatedAt(input));
  }
}

export class InMemoryOutsourcingPriceRuleStore
  extends InMemoryVersionedMasterStore<OutsourcingPriceRuleRow>
  implements OutsourcingPriceRuleStore
{
  constructor() {
    super('外协计价规则');
  }

  override insert(input: CreateOutsourcingPriceRuleInput): Promise<OutsourcingPriceRuleRow> {
    return super.insert(withCreatedAt(input));
  }
}

export class InMemoryRoutingStore extends InMemoryVersionedMasterStore<RoutingRow> implements RoutingStore {
  constructor() {
    super('工艺路线');
  }

  override insert(input: CreateRoutingInput): Promise<RoutingRow> {
    return super.insert(withCreatedAt(input));
  }
}

export class InMemoryStandardTimeStore
  extends InMemoryVersionedMasterStore<StandardTimeRow>
  implements StandardTimeStore
{
  constructor() {
    super('额定工时');
  }

  override insert(input: CreateStandardTimeInput): Promise<StandardTimeRow> {
    return super.insert(withCreatedAt(input));
  }
}

// ---- 故障单投影（P2：体例同 InMemoryNonconformStore） ----

interface FaultReportRow {
  readonly tenant: TenantId;
  readonly id: string;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly equipmentCode: string;
  readonly description: string;
  readonly reportedBy: string;
  assignee: string | null;
  assignedAt: string | null;
  resolutionRemark: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toFaultReport(row: FaultReportRow): FaultReport {
  return {
    id: FaultReportId.create(row.id),
    tenant: row.tenant,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    equipmentCode: row.equipmentCode,
    description: row.description,
    reportedBy: row.reportedBy,
    assignee: row.assignee,
    assignedAt: row.assignedAt,
    resolutionRemark: row.resolutionRemark,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryFaultReportStore implements FaultReportStore {
  private readonly rows = new Map<string, FaultReportRow>(); // key: `${tenant}|${id}`

  async create(input: CreateFaultReportInput): Promise<FaultReport> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new BaselineConflictError(`故障单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: FaultReportRow = {
      tenant: input.tenant,
      id: input.id,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      equipmentCode: input.equipmentCode,
      description: input.description,
      reportedBy: input.reportedBy,
      assignee: null,
      assignedAt: null,
      resolutionRemark: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toFaultReport(row);
  }

  async find(tenant: TenantId, id: FaultReportId): Promise<FaultReport | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toFaultReport(row);
  }

  async list(tenant: TenantId, filter?: ListFaultReportsFilter): Promise<readonly FaultReport[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && (filter?.state === undefined || row.state === filter.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toFaultReport);
  }

  async advance(
    tenant: TenantId,
    id: FaultReportId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: FaultReportAdvanceExtra,
  ): Promise<FaultReport> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new BaselineConflictError(
        `故障单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.assignee !== undefined) row.assignee = extra.assignee;
    if (extra?.assignedAt !== undefined) row.assignedAt = extra.assignedAt;
    if (extra?.resolutionRemark !== undefined) row.resolutionRemark = extra.resolutionRemark;
    if (extra?.resolvedBy !== undefined) row.resolvedBy = extra.resolvedBy;
    if (extra?.resolvedAt !== undefined) row.resolvedAt = extra.resolvedAt;
    row.updatedAt = new Date().toISOString();
    return toFaultReport(row);
  }
}

/** 校验运行内存实现（执行事实：单行、无修正链）。 */
export class InMemoryMaterialValidationRunStore implements MaterialValidationRunStore {
  private readonly runs = new Map<string, MaterialValidationRunRow>(); // key: `${tenant}|${id}`

  async insert(run: Omit<MaterialValidationRunRow, 'id' | 'createdAt'>): Promise<MaterialValidationRunRow> {
    // id 与 PG 形态同口径（裸 uuidv7，列 @db.Uuid）：service 读路径按 uuid 字面量
    // 形状短路非 uuid id（D-7），内存形态 id 须同为裸 uuid 才不会被误短路。
    const row: MaterialValidationRunRow = { ...run, id: baselineUuidv7(), createdAt: new Date().toISOString() };
    this.runs.set(`${row.tenant}|${row.id}`, row);
    return row;
  }

  async get(tenant: TenantId, runId: string): Promise<MaterialValidationRunRow | null> {
    const row = this.runs.get(`${tenant}|${runId}`);
    return row === undefined ? null : row;
  }

  async list(tenant: TenantId): Promise<readonly MaterialValidationRunSummaryView[]> {
    return [...this.runs.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(({ lines: _lines, ...summary }) => summary);
  }
}

/** 事件内存实现（append-only + 保序；无 Outbox 投递语义，重启即失）。 */
export class InMemoryBaselineEventStore implements BaselineEventStore {
  private readonly events: BusinessEvent[] = [];

  async append(event: BusinessEvent): Promise<void> {
    if (this.events.some((existing) => existing.eventId === event.eventId)) {
      throw new BaselineConflictError(`事件 '${String(event.eventId)}' 已落账（eventId 幂等锚点）`);
    }
    this.events.push(event);
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter((event) => event.tenantId === tenant)
      // 同 occurredAt（同毫秒连发）时依赖 sort 稳定性保持插入序（=因果序）——
      // eventId 为 uuidv4 随机串，作次级键会让事件顺序掷骰子（versioned-masters flaky 根因）。
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

/** 幂等账本内存实现。 */
export class InMemoryBaselineOperationLedger implements BaselineOperationLedger {
  private readonly claimed = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

/** 全内存端口集（模块缺省装配 / 测试直取；P2/P3 件三存储随缺省补齐）。 */
export function createInMemoryBaselineStores(): BaselineStores {
  return {
    processes: new InMemoryProcessDefStore(),
    equipment: new InMemoryEquipmentStore(),
    outsourcingRules: new InMemoryOutsourcingPriceRuleStore(),
    validationRuns: new InMemoryMaterialValidationRunStore(),
    events: new InMemoryBaselineEventStore(),
    operations: new InMemoryBaselineOperationLedger(),
    routings: new InMemoryRoutingStore(),
    standardTimes: new InMemoryStandardTimeStore(),
    faultReports: new InMemoryFaultReportStore(),
  };
}
