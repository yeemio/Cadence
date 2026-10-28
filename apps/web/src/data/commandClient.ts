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
import { ApiError, request } from './apiClient';

/** 命令三分结果的归一视图（committed/rejected/其他按不确定处理）。 */
export interface CommandOutcomeView {
  readonly committed: boolean;
  readonly reason: string | null;
  readonly status: string;
  /**
   * 服务端拒绝的语义 code（i18n 波 2 接通，PM 2026-10-28 §10）：error 来源
   * 透传 ApiError.code（非 ApiError / 缺 code 时无此键）；CommandOutcomeHint
   * 在 en-US 下按白名单映射英文文案，未知 code 回落现状拼接。
   */
  readonly code?: string;
  /**
   * 命令端点原始响应体（UX-WH-02：committed 回执携带聚合视图——movement/
   * movements/warehouse 等，业务单号回显从中抽取；error 路径缺省无体）。
   */
  readonly body?: Readonly<Record<string, unknown>> | null;
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

/**
 * 捕获的 error → error 形态 outcome（i18n 波 2 接通，PM 2026-10-28 §10）：
 * reason 提取与各页 onError 现状逐字一致（Error.message / String(error)），
 * ApiError 携带语义 code 时透传（exactOptionalPropertyTypes 下缺 code 不落键）。
 * 页面 onError 的 outcome 合成统一走本助手，避免 code 在转换处被丢弃。
 */
export function errorOutcomeOf(error: unknown): CommandOutcomeView {
  const code = error instanceof ApiError ? error.code : undefined;
  return {
    committed: false,
    status: 'error',
    reason: error instanceof Error ? error.message : String(error),
    ...(code !== undefined ? { code } : {}),
  };
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
  // UX-VW-R2-03：可见错误不携带 API 路径（页面直出 message；路径定位走
  // 浏览器开发者工具网络面，用户文案保持人话）。
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    throw new ModuleApiError(undefined, '命令响应形状非法（缺 status 字段）');
  }
  const record = body as { status?: unknown; reason?: unknown };
  const status = typeof record.status === 'string' ? record.status : String(record.status);
  if (status !== 'committed' && status !== 'rejected' && status !== 'indeterminate') {
    throw new ModuleApiError(undefined, `命令结果未知（status=${status}）`);
  }
  return {
    committed: status === 'committed',
    status,
    reason: typeof record.reason === 'string' ? record.reason : null,
    body: record,
  };
}

/**
 * 命令回执里的业务单号抽取（UX-WH-02）：committed 响应按模块实态把聚合视图挂
 * 在 movement / movements / warehouse / stocktake / shippingOrder 键下——逐键收
 * 集其中的 id（transfer 两腿流水按序全部返回）。无回执体/无命中返回空数组。
 */
export function businessIdsOfOutcome(outcome: CommandOutcomeView): readonly string[] {
  const body = outcome.body;
  if (body === undefined || body === null) return [];
  const ids: string[] = [];
  const pushId = (value: unknown): void => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  };
  pushId(body['movement']);
  if (Array.isArray(body['movements'])) {
    for (const row of body['movements']) pushId(row);
  }
  pushId(body['warehouse']);
  pushId(body['stocktake']);
  pushId(body['shippingOrder']);
  return ids;
}

/** GET 列表端点 → 行数组（envelopeKey 为控制器实态的响应键；坏形状抛错不静默）。 */
export async function fetchRows(path: string, envelopeKey: string): Promise<readonly Record<string, unknown>[]> {
  const body: unknown = await request(path);
  // UX-VW-R2-03：错误文案不露 API 路径（SPA HTML 误入等坏形状下路径不进用户文案）。
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, '列表响应形状非法（期望对象），请稍后重试');
  }
  const rows = (body as Record<string, unknown>)[envelopeKey];
  if (!Array.isArray(rows)) {
    throw new ModuleApiError(undefined, `列表响应缺 '${envelopeKey}' 数组`);
  }
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ModuleApiError(undefined, `列表响应 ${envelopeKey}[${index}] 非对象行`);
    }
    return row as Record<string, unknown>;
  });
}

/** GET 单对象端点 → 对象（envelopeKey 为响应键）。 */
export async function fetchObject(path: string, envelopeKey: string): Promise<Record<string, unknown>> {
  const body: unknown = await request(path);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, '响应形状非法（期望对象），请稍后重试');
  }
  const value = (body as Record<string, unknown>)[envelopeKey];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModuleApiError(undefined, `响应缺 '${envelopeKey}' 对象`);
  }
  return value as Record<string, unknown>;
}

/** GET 裸对象端点 → 顶层对象本身（详情/进度类端点直返视图对象、无 envelope 键）。 */
export async function fetchRawObject(path: string): Promise<Record<string, unknown>> {
  const body: unknown = await request(path);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, '响应形状非法（期望对象），请稍后重试');
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
