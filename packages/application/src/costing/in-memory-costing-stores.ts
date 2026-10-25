/**
 * costing 存储端口的内存先行实现（M2-W6；体例同 in-memory-baseline-stores）。
 * 唯一约束防线与 PG 同合同：entries 按 (tenant, sourceKey)、models 按
 * (tenant, code, objectVersion) 与 (tenant, supersedes)、snapshots 按
 * (tenant, workOrderId, modelCode, modelVersion, objectVersion) 与
 * (tenant, supersedes) 拒重复插入（抛 CostingConflictError）。
 */
import { randomUUID } from 'node:crypto';
import type { BusinessEvent, TenantId } from '@smes/business-core';
import { CostingConflictError } from './costing-errors.js';
import type {
  AppendCostEntryInput,
  AppendCostSnapshotInput,
  CostEntryRow,
  CostEntryStore,
  CostSnapshotRow,
  CostSnapshotStore,
  CostingDomainEventStore,
  CostingModelRow,
  CostingModelStore,
  CostingOperationStore,
  CostingStores,
  CreateCostingModelInput,
  ListCostEntriesFilter,
} from './costing-stores.js';

/** 成本条目内存实现（append-only；seq = 追加序）。 */
export class InMemoryCostEntryStore implements CostEntryStore {
  private readonly rows: CostEntryRow[] = [];
  private readonly bySourceKey = new Map<string, CostEntryRow>(); // key: `${tenant}|${sourceKey}`

  async insert(input: AppendCostEntryInput): Promise<CostEntryRow> {
    const key = `${input.tenant}|${input.sourceKey}`;
    if (this.bySourceKey.has(key)) {
      throw new CostingConflictError(`成本条目 sourceKey '${input.sourceKey}' 已落账（联动幂等锚点）`);
    }
    const row: CostEntryRow = { ...input, id: `ce-${randomUUID()}`, seq: this.rows.length + 1, objectVersion: 1 };
    this.rows.push(row);
    this.bySourceKey.set(key, row);
    return row;
  }

  async find(tenant: TenantId, id: string): Promise<CostEntryRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<CostEntryRow | null> {
    return this.bySourceKey.get(`${tenant}|${sourceKey}`) ?? null;
  }

  async listByBaseSourceKey(tenant: TenantId, baseSourceKey: string): Promise<readonly CostEntryRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && (row.sourceKey === baseSourceKey || row.deltaOf === baseSourceKey))
      .sort((a, b) => a.seq - b.seq);
  }

  async list(tenant: TenantId, filter?: ListCostEntriesFilter): Promise<readonly CostEntryRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.workOrderId !== undefined && row.workOrderId !== filter.workOrderId) return false;
        if (filter.category !== undefined && row.category !== filter.category) return false;
        if (filter.sourceType !== undefined && row.sourceType !== filter.sourceType) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 口径版本内存实现（版本化主数据内核——同 in-memory-baseline-stores 体例）。 */
export class InMemoryCostingModelStore implements CostingModelStore {
  private readonly rows: CostingModelRow[] = [];

  async insert(input: CreateCostingModelInput): Promise<CostingModelRow> {
    const chain = this.rows.filter((row) => row.tenant === input.tenant && row.code === input.code);
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new CostingConflictError(
        `口径版本 '${input.code}' 版本 ${input.objectVersion} 已存在（并发写入竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new CostingConflictError(`口径版本 '${input.code}' 的前任行已被取代（supersedes 链分叉）`);
    }
    const row: CostingModelRow = { ...input, id: `csm-${randomUUID()}`, createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async versions(tenant: TenantId, code: string): Promise<readonly CostingModelRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.code === code)
      .sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listAll(tenant: TenantId): Promise<readonly CostingModelRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code) || a.objectVersion - b.objectVersion);
  }
}

/** 成本快照内存实现（supersedes 链不变量）。 */
export class InMemoryCostSnapshotStore implements CostSnapshotStore {
  private readonly rows: CostSnapshotRow[] = [];

  async insert(input: AppendCostSnapshotInput): Promise<CostSnapshotRow> {
    const chain = this.rows.filter(
      (row) =>
        row.tenant === input.tenant &&
        row.workOrderId === input.workOrderId &&
        row.modelCode === input.modelCode &&
        row.modelVersion === input.modelVersion,
    );
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new CostingConflictError(
        `成本快照 ${input.workOrderId}@${input.modelCode}v${input.modelVersion} 版本 ${input.objectVersion} 已存在（并发重算竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new CostingConflictError(
        `成本快照 ${input.workOrderId}@${input.modelCode}v${input.modelVersion} 的前任行已被取代（supersedes 链分叉）`,
      );
    }
    const row: CostSnapshotRow = { ...input, id: `cs-${randomUUID()}`, createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async chain(
    tenant: TenantId,
    workOrderId: string,
    modelCode: string,
    modelVersion: number,
  ): Promise<readonly CostSnapshotRow[]> {
    return this.rows
      .filter(
        (row) =>
          row.tenant === tenant &&
          row.workOrderId === workOrderId &&
          row.modelCode === modelCode &&
          row.modelVersion === modelVersion,
      )
      .sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostSnapshotRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.workOrderId === workOrderId)
      .sort(
        (a, b) =>
          a.modelCode.localeCompare(b.modelCode) ||
          a.modelVersion - b.modelVersion ||
          a.objectVersion - b.objectVersion,
      );
  }
}

/** 域事件内存实现（append-only + 保序）。 */
export class InMemoryCostingDomainEventStore implements CostingDomainEventStore {
  private readonly events: BusinessEvent[] = [];

  async append(event: BusinessEvent): Promise<void> {
    if (this.events.some((existing) => existing.eventId === event.eventId)) {
      throw new CostingConflictError(`事件 '${String(event.eventId)}' 已落账（eventId 幂等锚点）`);
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
export class InMemoryCostingOperationStore implements CostingOperationStore {
  private readonly claimed = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

/** 全内存端口集（模块缺省装配 / 测试直取）。 */
export function createInMemoryCostingStores(): CostingStores {
  return {
    entries: new InMemoryCostEntryStore(),
    models: new InMemoryCostingModelStore(),
    snapshots: new InMemoryCostSnapshotStore(),
    events: new InMemoryCostingDomainEventStore(),
    operations: new InMemoryCostingOperationStore(),
  };
}
