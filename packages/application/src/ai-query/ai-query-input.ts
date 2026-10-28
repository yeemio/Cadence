/**
 * ai-query 输入解析（HTTP body/query → 业务输入；裸 interface + 手写 parse，
 * fail-fast 抛 AiQueryInputError → 组合根映射 400）。体例同 reporting-input：
 * 违规绝不静默丢弃；身份与租户不从请求体进（TenantContext / REQUEST_USER_KEY，
 * ADR-0005）。
 */
import { AiQueryInputError } from './ai-query-errors.js';

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AiQueryInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new AiQueryInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new AiQueryInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

/** id 形状（存储侧生成的不透明串：非空、无空白、≤128）。 */
function requireIdShape(value: unknown, what: string): string {
  const trimmed = requireBoundedString(value, what, 1, 128);
  if (/\s/.test(trimmed)) {
    throw new AiQueryInputError(`${what} 非法（含空白）：${JSON.stringify(value)}`);
  }
  return trimmed;
}

// ---- POST /ai-query/ask 请求体 ----

export interface AiQueryAskInput {
  readonly sessionId?: string;
  readonly question: string;
  readonly selectedOptionId?: string;
}

/**
 * 解析 ask 请求体：{sessionId?, question(1..500), selectedOptionId?}。
 * selectedOptionId 是对上一轮 clarify 的回传，须与 sessionId 同传（无会话则
 * 无从回放选项）。
 */
export function parseAskBody(input: unknown): AiQueryAskInput {
  const record = requireObject(input, 'ask 请求体');
  const question = requireBoundedString(record['question'], 'question', 1, 500);
  const sessionId = optionalBoundedString(record['sessionId'], 'sessionId', 1, 128);
  const selectedOptionId = optionalBoundedString(record['selectedOptionId'], 'selectedOptionId', 1, 128);
  if (selectedOptionId !== undefined && sessionId === undefined) {
    throw new AiQueryInputError('selectedOptionId 须与 sessionId 同传（澄清回传续走既有会话）');
  }
  return {
    question,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(selectedOptionId === undefined ? {} : { selectedOptionId }),
  };
}

// ---- 查询/路径参数 ----

/** 会话列表 limit（1~200 整数；缺省 50——合同 GET /ai-query/sessions?limit=50）。 */
export const AI_QUERY_SESSION_LIMIT_DEFAULT = 50;
export const AI_QUERY_SESSION_LIMIT_MAX = 200;

export function parseSessionLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const limit = typeof value === 'string' ? Number(value) : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > AI_QUERY_SESSION_LIMIT_MAX) {
    throw new AiQueryInputError(`limit 须为 1~${AI_QUERY_SESSION_LIMIT_MAX} 的整数：${JSON.stringify(value)}`);
  }
  return limit;
}

/** 路径参数 sessionId（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseSessionIdParam(value: string): string {
  try {
    return requireIdShape(value, 'sessionId');
  } catch (error) {
    if (error instanceof AiQueryInputError) {
      throw new AiQueryInputError(`sessionId 路径参数非法：${JSON.stringify(value)}`);
    }
    throw error;
  }
}
