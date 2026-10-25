/**
 * 审批配置薄数据层（T1 #102：approval-config 模块控制器实态）：
 *   GET  /approval-config/flows             approval-config:read  → { flows: [...] }
 *   POST /approval-config/flows             approval-config:write → 流行（缺省即启用）
 *   GET  /approval-config/flows/:id         approval-config:read  → 流行
 *   PUT  /approval-config/flows/:id         approval-config:write → 流行（期望态更新）
 *   POST /approval-config/flows/:id/activate approval-config:write → 流行（单启用收口）
 *   POST /approval-config/validate          approval-config:write → { valid, flowId }（试写预检）
 *
 * 流行含 config（engine-flow 配置全文）与 history（版本快照，新的在后）。
 * 配置文档的结构校验权威在后端（engine-flow defineApprovalFlowConfig）——本层
 * 只做行形状归一；管理页编辑走 JSON 文本域 + validate 预检。
 */
import { request } from './apiClient';
import { ModuleApiError } from './commandClient';

/** engine-flow 配置文档的编辑视图（结构权威在后端；前端以 JSON 文本编辑）。 */
export interface FlowConfigDocument {
  readonly schemaVersion: number;
  readonly flowId: string;
  readonly initial: string;
  readonly states: readonly { id: string; final?: boolean }[];
  readonly transitions: readonly {
    from: string;
    event: string;
    to: string;
    decision?: string;
  }[];
}

/** 历史版本快照行。 */
export interface FlowConfigVersionView {
  readonly config: FlowConfigDocument;
  readonly savedAt: string;
}

/** 审批流配置行（approval-config-stores.ts ApprovalFlowConfigRecord 视图形状）。 */
export interface ApprovalFlowRowView {
  readonly id: string;
  readonly flowId: string;
  readonly name: string;
  readonly config: FlowConfigDocument;
  readonly active: boolean;
  readonly history: readonly FlowConfigVersionView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseFlowDocument(value: unknown, what: string): FlowConfigDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModuleApiError(undefined, `${what} 配置文档非对象`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['schemaVersion'] !== 'number' ||
    typeof record['flowId'] !== 'string' ||
    typeof record['initial'] !== 'string' ||
    !Array.isArray(record['states']) ||
    !Array.isArray(record['transitions'])
  ) {
    throw new ModuleApiError(undefined, `${what} 配置文档缺核心字段（schemaVersion/flowId/initial/states/transitions）`);
  }
  return value as FlowConfigDocument;
}

function parseFlowRow(row: unknown): ApprovalFlowRowView {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new ModuleApiError(undefined, '审批流配置行非对象');
  }
  const record = row as Record<string, unknown>;
  for (const field of ['id', 'flowId', 'name', 'createdAt', 'updatedAt'] as const) {
    if (typeof record[field] !== 'string') {
      throw new ModuleApiError(undefined, `审批流配置行缺 '${field}' 字符串字段`);
    }
  }
  if (typeof record['active'] !== 'boolean') {
    throw new ModuleApiError(undefined, '审批流配置行缺 active 布尔字段');
  }
  const historyRaw = record['history'];
  if (!Array.isArray(historyRaw)) {
    throw new ModuleApiError(undefined, '审批流配置行缺 history 数组');
  }
  return {
    id: record['id'] as string,
    flowId: record['flowId'] as string,
    name: record['name'] as string,
    config: parseFlowDocument(record['config'], '审批流配置行'),
    active: record['active'] as boolean,
    history: historyRaw.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ModuleApiError(undefined, `history[${index}] 非对象`);
      }
      const item = entry as Record<string, unknown>;
      if (typeof item['savedAt'] !== 'string') {
        throw new ModuleApiError(undefined, `history[${index}] 缺 savedAt`);
      }
      return { config: parseFlowDocument(item['config'], `history[${index}]`), savedAt: item['savedAt'] as string };
    }),
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
  };
}

/** 列出流配置（approval-config:read；按 flowId 升序——后端 store 实态）。 */
export async function fetchApprovalFlows(): Promise<readonly ApprovalFlowRowView[]> {
  const body: unknown = await request('/approval-config/flows');
  const rows = (body as Record<string, unknown>)['flows'];
  if (!Array.isArray(rows)) {
    throw new ModuleApiError(undefined, "流配置列表响应缺 'flows' 数组");
  }
  return rows.map(parseFlowRow);
}

/** 读单条流配置（approval-config:read）。 */
export async function fetchApprovalFlow(id: string): Promise<ApprovalFlowRowView> {
  return parseFlowRow(await request(`/approval-config/flows/${encodeURIComponent(id)}`));
}

/** 试写预检（approval-config:write；不落库，保存前探测）。 */
export async function validateFlowConfig(config: unknown): Promise<{ valid: true; flowId: string }> {
  const body: unknown = await request('/approval-config/validate', {
    method: 'POST',
    body: JSON.stringify(config),
  });
  const record = (body ?? {}) as Record<string, unknown>;
  if (record['valid'] !== true || typeof record['flowId'] !== 'string') {
    throw new ModuleApiError(undefined, '校验响应形状非法（期望 { valid: true, flowId }）');
  }
  return { valid: true, flowId: record['flowId'] as string };
}

/** 创建流配置（approval-config:write；active 缺省 true = 创建即启用，租户内单启用收口）。 */
export async function createApprovalFlow(input: {
  name?: string;
  config: unknown;
  active?: boolean;
}): Promise<ApprovalFlowRowView> {
  return parseFlowRow(
    await request('/approval-config/flows', { method: 'POST', body: JSON.stringify(input) }),
  );
}

/** 期望态更新（approval-config:write；config 提供即整文档替换，先前配置入 history）。 */
export async function updateApprovalFlow(
  id: string,
  input: { name?: string; config?: unknown; active?: boolean },
): Promise<ApprovalFlowRowView> {
  return parseFlowRow(
    await request(`/approval-config/flows/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  );
}

/** 启用指定流（approval-config:write；租户内其余 active 行同批置 false）。 */
export async function activateApprovalFlow(id: string): Promise<ApprovalFlowRowView> {
  return parseFlowRow(
    await request(`/approval-config/flows/${encodeURIComponent(id)}/activate`, { method: 'POST' }),
  );
}
