/**
 * 九循环模块共享命令/查询薄层（S2 批次）：smes.command.v1 信封构造、命令结果
 * 归一、列表响应抽取。端点形状全部按 packages/application/src 各控制器实态映射
 * （控制器读回：信封体 { operationId, expectedRevision, command: { kind, payload } }；
 * 命令响应 = { status: 'committed' | 'rejected' | ... , reason? }；列表响应 =
 * { <envelopeKey>: [...] }）。
 *
 * expectedRevision 口径（测试实态锚定）：
 *  - 创建类/快照类/重算类命令（create/import/submit/scan/gap.check/rebuild）→ 'initial'；
 *  - 既有聚合上的命令（transition/close/verify/judge/assign/approve…）→ 聚合行
 *    objectVersion（列表/详情行携带；revisionOf 抽取，缺失即抛错阻断提交）。
 */
import { request } from './apiClient';

/** 命令三分结果的归一视图（committed/rejected/其他按不确定处理）。 */
export interface CommandOutcomeView {
  readonly committed: boolean;
  readonly reason: string | null;
  readonly status: string;
}

export class ModuleApiError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleApiError';
  }
}

/** 生成幂等操作键：命令动词 + 随机 UUID（重试请由用户显式重发，不自动重造）。 */
export function newOperationId(kind: string): string {
  const random: string | undefined =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : undefined;
  return `${kind}-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/** smes.command.v1 信封体（形状钉死供 api 层映射测试）。 */
export function commandEnvelope(
  kind: string,
  payload: Record<string, unknown>,
  expectedRevision: number | 'initial' = 'initial',
): {
  readonly operationId: string;
  readonly expectedRevision: number | 'initial';
  readonly command: { readonly kind: string; readonly payload: Record<string, unknown> };
} {
  return {
    operationId: newOperationId(kind),
    expectedRevision,
    command: { kind, payload },
  };
}

/** POST 命令端点 + 结果归一（rejected 是业务结果不是传输错误，随 committed=false 返回）。 */
export async function postCommand(
  path: string,
  kind: string,
  payload: Record<string, unknown>,
  expectedRevision: number | 'initial' = 'initial',
): Promise<CommandOutcomeView> {
  const body: unknown = await request(path, {
    method: 'POST',
    body: JSON.stringify(commandEnvelope(kind, payload, expectedRevision)),
  });
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    throw new ModuleApiError(undefined, `命令端点响应形状非法（缺 status 字段）：${path}`);
  }
  const record = body as { status?: unknown; reason?: unknown };
  const status = typeof record.status === 'string' ? record.status : String(record.status);
  if (status !== 'committed' && status !== 'rejected' && status !== 'indeterminate') {
    throw new ModuleApiError(undefined, `命令结果未知（status=${status}）：${path}`);
  }
  return {
    committed: status === 'committed',
    status,
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
}

/** GET 列表端点 → 行数组（envelopeKey 为控制器实态的响应键；坏形状抛错不静默）。 */
export async function fetchRows(path: string, envelopeKey: string): Promise<readonly Record<string, unknown>[]> {
  const body: unknown = await request(path);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, `列表响应形状非法（期望对象）：${path}`);
  }
  const rows = (body as Record<string, unknown>)[envelopeKey];
  if (!Array.isArray(rows)) {
    throw new ModuleApiError(undefined, `列表响应缺 '${envelopeKey}' 数组：${path}`);
  }
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ModuleApiError(undefined, `列表响应 ${envelopeKey}[${index}] 非对象行：${path}`);
    }
    return row as Record<string, unknown>;
  });
}

/** GET 单对象端点 → 对象（envelopeKey 为响应键）。 */
export async function fetchObject(path: string, envelopeKey: string): Promise<Record<string, unknown>> {
  const body: unknown = await request(path);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, `响应形状非法（期望对象）：${path}`);
  }
  const value = (body as Record<string, unknown>)[envelopeKey];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModuleApiError(undefined, `响应缺 '${envelopeKey}' 对象：${path}`);
  }
  return value as Record<string, unknown>;
}

/** GET 裸对象端点 → 顶层对象本身（详情/进度类端点直返视图对象、无 envelope 键）。 */
export async function fetchRawObject(path: string): Promise<Record<string, unknown>> {
  const body: unknown = await request(path);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, `响应形状非法（期望对象）：${path}`);
  }
  return body as Record<string, unknown>;
}

/** 裸对象内字段行数组抽取（如 machining-progress 的 rows；坏形状抛错）。 */
export function rowsOf(view: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  const rows = view[key];
  if (!Array.isArray(rows)) {
    throw new ModuleApiError(undefined, `视图对象缺 '${key}' 数组`);
  }
  return rows as readonly Record<string, unknown>[];
}

/** 聚合行 objectVersion 抽取（乐观锁锚点；缺失 = 前端无法安全提交，阻断并明示）。 */
export function revisionOf(row: Record<string, unknown>, what = '选中行'): number {
  const version = row['objectVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ModuleApiError(undefined, `${what}缺 objectVersion（无法组装乐观锁 expectedRevision）`);
  }
  return version;
}

/** 查询参数串（跳过空值；值 trim + URL 编码）。 */
export function queryString(entries: ReadonlyArray<readonly [string, string | undefined]>): string {
  const parts = entries
    .filter(([, value]) => value !== undefined && value.trim().length > 0)
    .map(([key, value]) => `${key}=${encodeURIComponent(value!.trim())}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
