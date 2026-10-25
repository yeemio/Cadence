/**
 * U7 项目成本三端口的内存先行实现（体例同 in-memory-costing-stores：唯一约束
 * 防线与 PG 同合同——entries 按 (tenant, sourceKey)、snapshots 按版本/链、
 * priceEntries 按 (tenant, workOrderId, recordId, taskLineId) upsert）。
 */
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@smes/business-core';
import { CostingConflictError } from './costing-errors.js';
import type {
  AppendCostProjectEntryInput,
  AppendCostProjectSnapshotInput,
  CostPriceEntryRow,
  CostPriceEntryStore,
  CostProjectEntryRow,
  CostProjectEntryStore,
  CostProjectSnapshotRow,
  CostProjectSnapshotStore,
  ListCostProjectEntriesFilter,
  ProjectCostStores,
  UpsertCostPriceEntryInput,
} from './project-cost-stores.js';

/** 段事实内存实现（append-only；seq = 追加序）。 */
export class InMemoryCostProjectEntryStore implements CostProjectEntryStore {
  private readonly rows: CostProjectEntryRow[] = [];
  private readonly bySourceKey = new Map<string, CostProjectEntryRow>(); // key: `${tenant}|${sourceKey}`

  async insert(input: AppendCostProjectEntryInput): Promise<CostProjectEntryRow> {
    const key = `${input.tenant}|${input.sourceKey}`;
    if (this.bySourceKey.has(key)) {
      throw new CostingConflictError(`项目成本段事实 sourceKey '${input.sourceKey}' 已落账（联动幂等锚点）`);
    }
    const row: CostProjectEntryRow = { ...input, id: `cpe-${randomUUID()}`, seq: this.rows.length + 1, objectVersion: 1 };
    this.rows.push(row);
    this.bySourceKey.set(key, row);
    return row;
  }

  async find(tenant: TenantId, id: string): Promise<CostProjectEntryRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<CostProjectEntryRow | null> {
    return this.bySourceKey.get(`${tenant}|${sourceKey}`) ?? null;
  }

  async listByBaseSourceKey(tenant: TenantId, baseSourceKey: string): Promise<readonly CostProjectEntryRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && (row.sourceKey === baseSourceKey || row.deltaOf === baseSourceKey))
      .sort((a, b) => a.seq - b.seq);
  }

  async list(tenant: TenantId, filter?: ListCostProjectEntriesFilter): Promise<readonly CostProjectEntryRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.workOrderId !== undefined && row.workOrderId !== filter.workOrderId) return false;
        if (filter.block !== undefined && row.block !== filter.block) return false;
        if (filter.segment !== undefined && row.segment !== filter.segment) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 六块快照内存实现（supersedes 链不变量）。 */
export class InMemoryCostProjectSnapshotStore implements CostProjectSnapshotStore {
  private readonly rows: CostProjectSnapshotRow[] = [];

  async insert(input: AppendCostProjectSnapshotInput): Promise<CostProjectSnapshotRow> {
    const chain = this.rows.filter(
      (row) =>
        row.tenant === input.tenant &&
        row.workOrderId === input.workOrderId &&
        row.modelCode === input.modelCode &&
        row.modelVersion === input.modelVersion,
    );
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new CostingConflictError(
        `项目成本快照 ${input.workOrderId}@${input.modelCode}v${input.modelVersion} 版本 ${input.objectVersion} 已存在（并发重算竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new CostingConflictError(
        `项目成本快照 ${input.workOrderId}@${input.modelCode}v${input.modelVersion} 的前任行已被取代（supersedes 链分叉）`,
      );
    }
    const row: CostProjectSnapshotRow = { ...input, id: `cps-${randomUUID()}`, createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async chain(
    tenant: TenantId,
    workOrderId: string,
    modelCode: string,
    modelVersion: number,
  ): Promise<readonly CostProjectSnapshotRow[]> {
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

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostProjectSnapshotRow[]> {
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

/** 录入价格内存实现（运营投影 upsert）。 */
export class InMemoryCostPriceEntryStore implements CostPriceEntryStore {
  private readonly rows: CostPriceEntryRow[] = [];

  async upsert(input: UpsertCostPriceEntryInput): Promise<CostPriceEntryRow> {
    const existing = await this.find(input.tenant, input.workOrderId, input.recordId, input.taskLineId);
    if (existing !== null) {
      const updated: CostPriceEntryRow = { ...input, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
      this.rows.splice(this.rows.indexOf(existing), 1, updated);
      return updated;
    }
    const row: CostPriceEntryRow = {
      ...input,
      id: `cpr-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async find(tenant: TenantId, workOrderId: string, recordId: string, taskLineId: string): Promise<CostPriceEntryRow | null> {
    return (
      this.rows.find(
        (row) =>
          row.tenant === tenant && row.workOrderId === workOrderId && row.recordId === recordId && row.taskLineId === taskLineId,
      ) ?? null
    );
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostPriceEntryRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.workOrderId === workOrderId)
      .sort((a, b) => a.recordId.localeCompare(b.recordId) || a.taskLineId.localeCompare(b.taskLineId));
  }
}

/** 全内存端口集（模块缺省装配 / 测试直取）。 */
export function createInMemoryProjectCostStores(): ProjectCostStores {
  return {
    projectEntries: new InMemoryCostProjectEntryStore(),
    projectSnapshots: new InMemoryCostProjectSnapshotStore(),
    priceEntries: new InMemoryCostPriceEntryStore(),
  };
}
