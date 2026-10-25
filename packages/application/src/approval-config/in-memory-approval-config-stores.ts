/**
 * InMemoryApprovalFlowConfigStore —— 审批配置端口先行实现（T 波 #102 +
 * T1 接线 history/activate）。
 *
 * 重启即失；PG 实现在 business-store（`./approval-config` 子路径，导出登记归
 * 合流）。与 InMemoryItemStore 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。
 */
import { randomUUID } from 'node:crypto';
import { TenantId } from '@smes/business-core';
import type { ApprovalFlowConfig } from '@smes/engine-flow';
import { ApprovalConfigConflictError } from './approval-config-errors.js';
import { parseFlowConfig } from './approval-config-input.js';
import type {
  ApprovalFlowConfigRecord,
  ApprovalFlowConfigStore,
  ApprovalFlowConfigVersion,
  CreateApprovalFlowConfigInput,
  UpdateApprovalFlowConfigInput,
} from './approval-config-stores.js';

/** 历史版本封顶（超出丢最旧；正常配置演进远低于此）。 */
export const APPROVAL_CONFIG_HISTORY_LIMIT = 20;

interface ConfigRow {
  readonly tenant: string;
  readonly id: string;
  readonly flowId: string;
  name: string;
  config: ApprovalFlowConfig;
  active: boolean;
  history: ApprovalFlowConfigVersion[];
  readonly createdAt: string;
  updatedAt: string;
}

let memoryCounter = 0;

function nextMemoryId(): string {
  memoryCounter += 1;
  return `ac-${randomUUID()}-${memoryCounter.toString(36)}`;
}

/** 整文档替换的历史维护：先前 config 快照压行尾，封顶丢最旧（端口合同）。 */
function pushHistory(row: ConfigRow): void {
  row.history = [...row.history, { config: row.config, savedAt: row.updatedAt }];
  if (row.history.length > APPROVAL_CONFIG_HISTORY_LIMIT) {
    row.history = row.history.slice(row.history.length - APPROVAL_CONFIG_HISTORY_LIMIT);
  }
}

export class InMemoryApprovalFlowConfigStore implements ApprovalFlowConfigStore {
  private readonly rows = new Map<string, ConfigRow>(); // key: `${tenant}|${id}`

  async create(input: CreateApprovalFlowConfigInput): Promise<ApprovalFlowConfigRecord> {
    const conflict = [...this.rows.values()].find(
      (row) => row.tenant === input.tenant && row.flowId === input.flowId,
    );
    if (conflict !== undefined) {
      throw new ApprovalConfigConflictError(
        `流标识 '${input.flowId}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const now = new Date().toISOString();
    const row: ConfigRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      flowId: input.flowId,
      name: input.name,
      config: input.config,
      active: input.active ?? true,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(`${row.tenant}|${row.id}`, row);
    return toRecord(row);
  }

  async list(tenant: TenantId): Promise<readonly ApprovalFlowConfigRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.flowId.localeCompare(b.flowId))
      .map(toRecord);
  }

  async find(tenant: TenantId, id: string): Promise<ApprovalFlowConfigRecord | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toRecord(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateApprovalFlowConfigInput,
  ): Promise<ApprovalFlowConfigRecord | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.config !== undefined && input.config !== row.config) {
      pushHistory(row); // 整文档替换才压历史（非 config 更新不动，端口合同）
    }
    if (input.name !== undefined) row.name = input.name;
    if (input.config !== undefined) row.config = input.config;
    if (input.active !== undefined) row.active = input.active;
    row.updatedAt = new Date().toISOString();
    return toRecord(row);
  }

  async activate(tenant: TenantId, id: string): Promise<ApprovalFlowConfigRecord | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    for (const other of this.rows.values()) {
      if (other.tenant === tenant && other.id !== id) other.active = false;
    }
    row.active = true;
    row.updatedAt = new Date().toISOString();
    return toRecord(row);
  }
}

function toRecord(row: ConfigRow): ApprovalFlowConfigRecord {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    flowId: row.flowId,
    name: row.name,
    // 读出复核：行内配置再走一次固化校验（与 PG JSON 列读出同一合同——损坏 fail-fast）
    config: parseFlowConfig(row.config),
    active: row.active,
    history: row.history.map((entry) => ({ config: parseFlowConfig(entry.config), savedAt: entry.savedAt })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
