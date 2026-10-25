/**
 * maintenance 存储端口的内存先行实现（M3；体例同 in-memory-payroll-stores：
 * 重启即失，PG 实现在 business-store `./maintenance`（结构同形镜像类型——
 * pro-pack-tier-edges，不 import 本包）；无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，零 DB boot 语义完整）。
 *
 * 唯一约束防线与 PG 同合同：plans 按 (tenant, planId, objectVersion) 与
 * (tenant, supersedes)；tasks 按 (tenant, sourceKey)（sourceKey 非空的
 * plan-due 任务）；activities 恒追加；events 按 eventId 幂等。
 */
import { randomUUID } from 'node:crypto';
import type { BusinessEvent, TenantId } from '@smes/business-core';
import { MaintenanceConflictError } from './maintenance-errors.js';
import {
  newCheckpointRecordId,
  newMaintenanceTaskId,
  newRepairRecordId,
  newUpkeepRecordId,
  type MaintenanceTaskId,
} from './maintenance-ids.js';
import type {
  AppendMaintenanceActivityInput,
  CreateMaintenancePlanInput,
  CreateMaintenanceTaskInput,
  ListMaintenanceTasksFilter,
  MaintenanceActivityQuery,
  MaintenanceActivityRow,
  MaintenanceActivityStore,
  MaintenanceDomainEventStore,
  MaintenanceOperationStore,
  MaintenancePlanRow,
  MaintenancePlanStore,
  MaintenanceStores,
  MaintenanceTaskAdvance,
  MaintenanceTaskRow,
  MaintenanceTaskStore,
} from './maintenance-stores.js';

/** 维保计划版本行内存实现（版本化主数据；链线性不变量由两组唯一检查背书）。 */
export class InMemoryMaintenancePlanStore implements MaintenancePlanStore {
  private readonly rows: MaintenancePlanRow[] = [];

  async insert(input: CreateMaintenancePlanInput): Promise<MaintenancePlanRow> {
    const chain = this.rows.filter(
      (row) => row.tenant === input.tenant && row.planId === input.planId,
    );
    if (chain.some((row) => row.objectVersion === input.objectVersion)) {
      throw new MaintenanceConflictError(
        `维保计划 ${input.planId} 版本 ${input.objectVersion} 已存在（并发发布竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new MaintenanceConflictError(`维保计划 ${input.planId} 的前任行已被取代（supersedes 链分叉）`);
    }
    const row: MaintenancePlanRow = { ...input, id: `mpl-${randomUUID()}`, createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async versions(
    tenant: TenantId,
    planId: MaintenancePlanRow['planId'],
  ): Promise<readonly MaintenancePlanRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.planId === planId)
      .sort((a, b) => a.objectVersion - b.objectVersion);
  }

  async listAll(tenant: TenantId): Promise<readonly MaintenancePlanRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.planId.localeCompare(b.planId) || a.objectVersion - b.objectVersion);
  }
}

/** 维保任务投影行内存实现（状态机行级条件更新 = 乐观锁）。 */
export class InMemoryMaintenanceTaskStore implements MaintenanceTaskStore {
  private readonly rows: MaintenanceTaskRow[] = [];
  private readonly bySourceKey = new Map<string, MaintenanceTaskRow>(); // key: `${tenant}|${sourceKey}`

  async insert(input: CreateMaintenanceTaskInput): Promise<MaintenanceTaskRow> {
    if (input.sourceKey !== undefined) {
      const key = `${input.tenant}|${input.sourceKey}`;
      if (this.bySourceKey.has(key)) {
        throw new MaintenanceConflictError(`任务到期锚点 '${input.sourceKey}' 已落账（due-scan 幂等去重）`);
      }
    }
    const row: MaintenanceTaskRow = { ...input, id: newMaintenanceTaskId(), createdAt: new Date().toISOString() };
    this.rows.push(row);
    if (input.sourceKey !== undefined) {
      this.bySourceKey.set(`${input.tenant}|${input.sourceKey}`, row);
    }
    return row;
  }

  async find(tenant: TenantId, id: MaintenanceTaskId): Promise<MaintenanceTaskRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async advance(
    tenant: TenantId,
    id: MaintenanceTaskId,
    expectedObjectVersion: number,
    next: MaintenanceTaskAdvance,
  ): Promise<MaintenanceTaskRow | null> {
    const index = this.rows.findIndex(
      (row) => row.tenant === tenant && row.id === id && row.objectVersion === expectedObjectVersion,
    );
    if (index === -1) return null; // 乐观锁失配或行不存在
    const before = this.rows[index]!;
    const updated: MaintenanceTaskRow = {
      ...before,
      state: next.state,
      objectVersion: next.objectVersion,
      ...(next.startedAt === undefined ? {} : { startedAt: next.startedAt }),
      ...(next.completedAt === undefined ? {} : { completedAt: next.completedAt }),
      ...(next.cancelledAt === undefined ? {} : { cancelledAt: next.cancelledAt }),
      ...(next.cancelReason === undefined ? {} : { cancelReason: next.cancelReason }),
    };
    this.rows[index] = updated;
    return updated;
  }

  async list(tenant: TenantId, filter?: ListMaintenanceTasksFilter): Promise<readonly MaintenanceTaskRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.source !== undefined && row.source !== filter.source) return false;
        if (filter.kind !== undefined && row.kind !== filter.kind) return false;
        if (filter.state !== undefined && row.state !== filter.state) return false;
        if (filter.assignee !== undefined && row.assignee !== filter.assignee) return false;
        if (filter.resourceRef !== undefined && row.resourceRef !== filter.resourceRef) return false;
        if (filter.planId !== undefined && row.planId !== filter.planId) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}

/** 三态记录内存实现（append-only；seq = 追加序；id 前缀按 kind）。 */
export class InMemoryMaintenanceActivityStore implements MaintenanceActivityStore {
  private readonly rows: MaintenanceActivityRow[] = [];

  async insert(input: AppendMaintenanceActivityInput): Promise<MaintenanceActivityRow> {
    const base = {
      tenant: input.tenant,
      seq: this.rows.length + 1,
      resourceRef: input.resourceRef,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.planVersion === undefined ? {} : { planVersion: input.planVersion }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      performedBy: input.performedBy,
      performedAt: input.performedAt,
      ...(input.note === undefined ? {} : { note: input.note }),
      occurredAt: input.occurredAt,
      recordedBy: input.recordedBy,
      objectVersion: 1,
      auditStatus: input.auditStatus,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
      ...(input.businessTime === undefined ? {} : { businessTime: input.businessTime }),
      ...(input.availableTime === undefined ? {} : { availableTime: input.availableTime }),
    };
    const row: MaintenanceActivityRow =
      input.kind === 'checkpoint'
        ? { ...base, kind: 'checkpoint', id: newCheckpointRecordId(), checkpointId: input.checkpointId, result: input.result }
        : input.kind === 'upkeep'
          ? { ...base, kind: 'upkeep', id: newUpkeepRecordId(), ...(input.actionsDone === undefined ? {} : { actionsDone: input.actionsDone }) }
          : { ...base, kind: 'repair', id: newRepairRecordId(), ...(input.faultRef === undefined ? {} : { faultRef: input.faultRef }), restored: input.restored };
    this.rows.push(row);
    return row;
  }

  async list(tenant: TenantId, query?: MaintenanceActivityQuery): Promise<readonly MaintenanceActivityRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (query === undefined) return true;
        if (query.resourceRef !== undefined && row.resourceRef !== query.resourceRef) return false;
        if (query.kind !== undefined && row.kind !== query.kind) return false;
        if (query.taskId !== undefined && row.taskId !== query.taskId) return false;
        if (query.planId !== undefined && row.planId !== query.planId) return false;
        if (query.from !== undefined && Date.parse(row.performedAt) < Date.parse(query.from)) return false;
        if (query.to !== undefined && Date.parse(row.performedAt) > Date.parse(query.to)) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 域事件内存实现（保序保存；eventId 去重防线）。 */
export class InMemoryMaintenanceDomainEventStore implements MaintenanceDomainEventStore {
  private readonly events: BusinessEvent[] = [];
  private readonly seen = new Set<string>();

  async append(event: BusinessEvent): Promise<void> {
    if (this.seen.has(event.eventId)) {
      throw new MaintenanceConflictError(`事件 '${event.eventId}' 已落账（eventId 幂等锚点）`);
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
export class InMemoryMaintenanceOperationStore implements MaintenanceOperationStore {
  private readonly claimedKeys = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimedKeys.has(key)) return false;
    this.claimedKeys.add(key);
    return true;
  }
}

/** 内存端口全集（零 DB boot 装配）。 */
export function inMemoryMaintenanceStores(): MaintenanceStores {
  return {
    plans: new InMemoryMaintenancePlanStore(),
    tasks: new InMemoryMaintenanceTaskStore(),
    activities: new InMemoryMaintenanceActivityStore(),
    events: new InMemoryMaintenanceDomainEventStore(),
    operations: new InMemoryMaintenanceOperationStore(),
  };
}
