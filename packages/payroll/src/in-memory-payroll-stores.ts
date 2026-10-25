/**
 * payroll 存储端口的内存先行实现（M3；体例同 in-memory-hours-stores /
 * in-memory-costing-stores：重启即失，PG 实现在 business-store `./payroll`
 * （结构同形镜像类型——pro-pack-tier-edges，不 import 本包）；无
 * DATABASE_URL / 未注入存储时组合根回落到这里，零 DB boot 语义完整）。
 *
 * 唯一约束防线与 PG 同合同：rules 按 (tenant, ruleId, objectVersion) 与
 * (tenant, supersedes)；runs 按 (tenant, periodKey, personId, objectVersion)
 * 与 (tenant, supersedes)；records 按 (tenant, sourceKey) 拒重复插入
 * （抛 PayrollConflictError）。
 */
import { randomUUID } from 'node:crypto';
import type { BusinessEvent, TenantId, UserId } from '@smes/business-core';
import { PayrollConflictError } from './payroll-errors.js';
import { EarningsRecordId, PayRunId, newEarningsRecordId, newPayRunId } from './payroll-ids.js';
import type {
  AppendEarningsRecordInput,
  CreatePayrollRuleInput,
  EarningsRecordRow,
  EarningsRecordStore,
  ListEarningsRecordsFilter,
  AppendPayRunInput,
  PayrollDomainEventStore,
  PayrollOperationStore,
  PayrollRuleRow,
  PayrollRuleStore,
  PayRunRow,
  PayRunStore,
  PayrollStores,
} from './payroll-stores.js';

/** 计薪规则版本行内存实现（版本化主数据；链线性不变量由两组唯一检查背书）。 */
export class InMemoryPayrollRuleStore implements PayrollRuleStore {
  private readonly rows: PayrollRuleRow[] = [];

  async insert(input: CreatePayrollRuleInput): Promise<PayrollRuleRow> {
    const chain = this.rows.filter(
      (row) => row.tenant === input.tenant && row.ruleId === input.ruleId,
    );
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new PayrollConflictError(
        `计薪规则 ${input.ruleId} 版本 ${input.objectVersion} 已存在（并发发布竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new PayrollConflictError(`计薪规则 ${input.ruleId} 的前任行已被取代（supersedes 链分叉）`);
    }
    const row: PayrollRuleRow = { ...input, id: `prl-${randomUUID()}`, createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async versions(tenant: TenantId, ruleId: PayrollRuleRow['ruleId']): Promise<readonly PayrollRuleRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.ruleId === ruleId)
      .sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listAll(tenant: TenantId): Promise<readonly PayrollRuleRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.objectVersion - b.objectVersion);
  }
}

/** 核算批次快照内存实现（supersedes 链不变量由两组唯一检查背书）。 */
export class InMemoryPayRunStore implements PayRunStore {
  private readonly rows: PayRunRow[] = [];

  async insert(input: AppendPayRunInput): Promise<PayRunRow> {
    const chain = this.rows.filter(
      (row) =>
        row.tenant === input.tenant &&
        row.periodKey === input.periodKey &&
        row.personId === input.personId,
    );
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new PayrollConflictError(
        `核算批次 ${input.personId} ${input.periodKey} 版本 ${input.objectVersion} 已存在（并发重算竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new PayrollConflictError(`核算批次 ${input.personId} ${input.periodKey} 的前任行已被取代（supersedes 链分叉）`);
    }
    const row: PayRunRow = { ...input, id: newPayRunId(), createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async find(tenant: TenantId, id: PayRunId): Promise<PayRunRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async chain(tenant: TenantId, periodKey: string, personId: UserId): Promise<readonly PayRunRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.periodKey === periodKey && row.personId === personId)
      .sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listByPeriod(tenant: TenantId, periodKey: string, personId?: UserId): Promise<readonly PayRunRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.periodKey === periodKey)
      .filter((row) => personId === undefined || row.personId === personId)
      .sort((a, b) => a.personId.localeCompare(b.personId) || a.objectVersion - b.objectVersion);
  }

  async listByPerson(tenant: TenantId, personId: UserId): Promise<readonly PayRunRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.personId === personId)
      .sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.objectVersion - b.objectVersion);
  }
}

/** 薪酬记录内存实现（append-only；seq = 追加序）。 */
export class InMemoryEarningsRecordStore implements EarningsRecordStore {
  private readonly rows: EarningsRecordRow[] = [];
  private readonly bySourceKey = new Map<string, EarningsRecordRow>(); // key: `${tenant}|${sourceKey}`

  async insert(input: AppendEarningsRecordInput): Promise<EarningsRecordRow> {
    const key = `${input.tenant}|${input.sourceKey}`;
    if (this.bySourceKey.has(key)) {
      throw new PayrollConflictError(`薪酬记录 sourceKey '${input.sourceKey}' 已落账（核算行幂等锚点）`);
    }
    const row: EarningsRecordRow = {
      ...input,
      id: newEarningsRecordId(),
      seq: this.rows.length + 1,
      objectVersion: 1,
    };
    this.rows.push(row);
    this.bySourceKey.set(key, row);
    return row;
  }

  async find(tenant: TenantId, id: EarningsRecordId): Promise<EarningsRecordRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<EarningsRecordRow | null> {
    return this.bySourceKey.get(`${tenant}|${sourceKey}`) ?? null;
  }

  async list(tenant: TenantId, filter?: ListEarningsRecordsFilter): Promise<readonly EarningsRecordRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.periodKey !== undefined && row.periodKey !== filter.periodKey) return false;
        if (filter.personId !== undefined && row.personId !== filter.personId) return false;
        if (filter.payRunId !== undefined && row.payRunId !== filter.payRunId) return false;
        if (filter.laborKind !== undefined && row.laborKind !== filter.laborKind) return false;
        if (filter.ruleId !== undefined && row.ruleId !== filter.ruleId) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 域事件内存实现（保序保存；eventId 去重防线）。 */
export class InMemoryPayrollDomainEventStore implements PayrollDomainEventStore {
  private readonly events: BusinessEvent[] = [];
  private readonly seen = new Set<string>();

  async append(event: BusinessEvent): Promise<void> {
    if (this.seen.has(event.eventId)) {
      throw new PayrollConflictError(`事件 '${event.eventId}' 已落账（eventId 幂等锚点）`);
    }
    this.seen.add(event.eventId);
    this.events.push(event);
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter((event) => event.tenantId === tenant)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

/** 命令幂等账本内存实现。 */
export class InMemoryPayrollOperationStore implements PayrollOperationStore {
  private readonly claimedKeys = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimedKeys.has(key)) return false;
    this.claimedKeys.add(key);
    return true;
  }
}

/** 内存端口全集（零 DB boot 装配）。 */
export function inMemoryPayrollStores(): PayrollStores {
  return {
    rules: new InMemoryPayrollRuleStore(),
    runs: new InMemoryPayRunStore(),
    records: new InMemoryEarningsRecordStore(),
    events: new InMemoryPayrollDomainEventStore(),
    operations: new InMemoryPayrollOperationStore(),
  };
}
