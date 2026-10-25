/**
 * hours 存储端口的内存先行实现（M2-W6；体例同 in-memory-baseline-stores /
 * in-memory-inventory-stores：重启即失，PG 实现在 business-store `./hours`；
 * 无 DATABASE_URL / 未注入存储时组合根回落到这里，零 DB boot 语义完整）。
 *
 * 唯一约束防线与 PG 同合同：entries 按 (tenant, sourceKey)、months 按
 * (tenant, worker, month, trade, objectVersion) 与 (tenant, supersedes) 拒
 * 重复插入（抛 HoursConflictError）。
 */
import { randomUUID } from 'node:crypto';
import type { BusinessEvent, TenantId } from '@smes/business-core';
import { HoursConflictError } from './hours-errors.js';
import { monthOfDate } from './hours-config.js';
import type {
  AppendLaborEntryInput,
  AppendLaborLedgerMonthInput,
  HoursDomainEventStore,
  HoursOperationStore,
  HoursStores,
  LaborEntryRow,
  LaborEntryStore,
  LaborLedgerMonthRow,
  LaborLedgerMonthStore,
  ListLaborEntriesFilter,
} from './hours-stores.js';

/** 工时账目内存实现（append-only；seq = 追加序）。 */
export class InMemoryLaborEntryStore implements LaborEntryStore {
  private readonly rows: LaborEntryRow[] = [];
  private readonly bySourceKey = new Map<string, LaborEntryRow>(); // key: `${tenant}|${sourceKey}`

  async insert(input: AppendLaborEntryInput): Promise<LaborEntryRow> {
    const key = `${input.tenant}|${input.sourceKey}`;
    if (this.bySourceKey.has(key)) {
      throw new HoursConflictError(`工时条目 sourceKey '${input.sourceKey}' 已落账（联动幂等锚点）`);
    }
    const row: LaborEntryRow = {
      ...input,
      id: `le-${randomUUID()}`,
      seq: this.rows.length + 1,
      objectVersion: 1,
    };
    this.rows.push(row);
    this.bySourceKey.set(key, row);
    return row;
  }

  async find(tenant: TenantId, id: string): Promise<LaborEntryRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<LaborEntryRow | null> {
    return this.bySourceKey.get(`${tenant}|${sourceKey}`) ?? null;
  }

  async list(tenant: TenantId, filter?: ListLaborEntriesFilter): Promise<readonly LaborEntryRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.workerId !== undefined && row.workerId !== filter.workerId) return false;
        if (filter.month !== undefined && monthOfDate(row.workDate) !== filter.month) return false;
        if (filter.trade !== undefined && row.trade !== filter.trade) return false;
        if (filter.workOrderId !== undefined && row.workOrderId !== filter.workOrderId) return false;
        if (filter.sourceReportId !== undefined && row.sourceReportId !== filter.sourceReportId) return false;
        if (filter.direction !== undefined && row.direction !== filter.direction) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 月度归集内存实现（supersedes 链不变量由两组唯一检查背书）。 */
export class InMemoryLaborLedgerMonthStore implements LaborLedgerMonthStore {
  private readonly rows: LaborLedgerMonthRow[] = [];

  async insert(input: AppendLaborLedgerMonthInput): Promise<LaborLedgerMonthRow> {
    const chain = this.rows.filter(
      (row) =>
        row.tenant === input.tenant &&
        row.workerId === input.workerId &&
        row.month === input.month &&
        row.trade === input.trade,
    );
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new HoursConflictError(
        `月度归集 ${input.workerId} ${input.month} ${input.trade} 版本 ${input.objectVersion} 已存在（并发重算竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new HoursConflictError(
        `月度归集 ${input.workerId} ${input.month} ${input.trade} 的前任行已被取代（supersedes 链分叉）`,
      );
    }
    const row: LaborLedgerMonthRow = { ...input, id: `hlm-${randomUUID()}`, createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async chain(
    tenant: TenantId,
    workerId: string,
    month: string,
    trade: LaborLedgerMonthRow['trade'],
  ): Promise<readonly LaborLedgerMonthRow[]> {
    return this.rows
      .filter(
        (row) => row.tenant === tenant && row.workerId === workerId && row.month === month && row.trade === trade,
      )
      .sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listByMonth(tenant: TenantId, month: string, workerId?: string): Promise<readonly LaborLedgerMonthRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.month === month)
      .filter((row) => workerId === undefined || row.workerId === workerId)
      .sort(
        (a, b) =>
          a.workerId.localeCompare(b.workerId) || a.trade.localeCompare(b.trade) || a.objectVersion - b.objectVersion,
      );
  }
}

/** 域事件内存实现（append-only + 保序；无 Outbox 投递语义，重启即失）。 */
export class InMemoryHoursDomainEventStore implements HoursDomainEventStore {
  private readonly events: BusinessEvent[] = [];

  async append(event: BusinessEvent): Promise<void> {
    if (this.events.some((existing) => existing.eventId === event.eventId)) {
      throw new HoursConflictError(`事件 '${String(event.eventId)}' 已落账（eventId 幂等锚点）`);
    }
    this.events.push(event);
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter((event) => event.tenantId === tenant)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || String(a.eventId).localeCompare(String(b.eventId)));
  }
}

/** 幂等账本内存实现。 */
export class InMemoryHoursOperationStore implements HoursOperationStore {
  private readonly claimed = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

/** 全内存端口集（模块缺省装配 / 测试直取）。 */
export function createInMemoryHoursStores(): HoursStores {
  return {
    entries: new InMemoryLaborEntryStore(),
    months: new InMemoryLaborLedgerMonthStore(),
    events: new InMemoryHoursDomainEventStore(),
    operations: new InMemoryHoursOperationStore(),
  };
}
