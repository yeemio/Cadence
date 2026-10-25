/**
 * metric-pack 存储端口的内存先行实现（M3；体例同 in-memory-payroll-stores：
 * 重启即失，PG 实现在 business-store `./metric-pack`（结构同形镜像类型——
 * pro-pack-tier-edges，不 import 本包）；无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，零 DB boot 语义完整。
 *
 * 唯一约束防线与 PG 同合同：activations 按 (tenant, packId, packVersion) 与
 * (tenant, supersedes) 拒重复插入（抛 MetricPackConflictError）。
 */
import { randomUUID } from 'node:crypto';
import type { BusinessEvent, TenantId } from '@smes/business-core';
import { MetricPackConflictError } from './metric-pack-errors.js';
import type {
  AppendMetricPackActivationInput,
  MetricPackActivationRow,
  MetricPackActivationStore,
  MetricPackDomainEventStore,
  MetricPackOperationStore,
  MetricPackStores,
} from './metric-pack-stores.js';

/** 装载记录内存实现（append-only；装载链线性不变量由两组唯一检查背书）。 */
export class InMemoryMetricPackActivationStore implements MetricPackActivationStore {
  private readonly rows: MetricPackActivationRow[] = [];

  async insert(input: AppendMetricPackActivationInput): Promise<MetricPackActivationRow> {
    const chain = this.rows.filter(
      (row) => row.tenant === input.tenant && row.packId === input.packId,
    );
    if (chain.some((row) => row.packVersion === input.packVersion)) {
      throw new MetricPackConflictError(
        `口径包 ${input.packId} 版本 ${input.packVersion} 已装载（并发装载竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new MetricPackConflictError(`口径包 ${input.packId} 的前任装载记录已被取代（supersedes 链分叉）`);
    }
    const row: MetricPackActivationRow = {
      ...input,
      id: `mpa-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async chain(tenant: TenantId, packId: string): Promise<readonly MetricPackActivationRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.packId === packId)
      .sort((a, b) => a.packVersion - b.packVersion);
  }

  async listAll(tenant: TenantId): Promise<readonly MetricPackActivationRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.packId.localeCompare(b.packId) || a.packVersion - b.packVersion);
  }
}

/** 域事件内存实现（保序保存；eventId 去重防线）。 */
export class InMemoryMetricPackDomainEventStore implements MetricPackDomainEventStore {
  private readonly events: BusinessEvent[] = [];
  private readonly seen = new Set<string>();

  async append(event: BusinessEvent): Promise<void> {
    if (this.seen.has(event.eventId)) {
      throw new MetricPackConflictError(`事件 '${event.eventId}' 已落账（eventId 幂等锚点）`);
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
export class InMemoryMetricPackOperationStore implements MetricPackOperationStore {
  private readonly claimedKeys = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimedKeys.has(key)) return false;
    this.claimedKeys.add(key);
    return true;
  }
}

/** 内存端口全集（零 DB boot 装配）。 */
export function inMemoryMetricPackStores(): MetricPackStores {
  return {
    activations: new InMemoryMetricPackActivationStore(),
    events: new InMemoryMetricPackDomainEventStore(),
    operations: new InMemoryMetricPackOperationStore(),
  };
}
