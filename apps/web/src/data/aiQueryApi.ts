/**
 * AI 问数数据薄层（WP-C，CONTRACT v1 §Wire 合同 · 2026-10-28）。
 *
 * 端点形状按 packages/application/src/ai-query/ai-query.controllers.ts 实态
 * （web 不 import 后端包——depcruise web-via-ui 铁律，类型在本文件镜像合同
 * 冻结字段，字段名不得偏移）：
 *   GET  /ai-query/capabilities      → { items: CapabilityInfo[] }
 *   POST /ai-query/ask               → AskResponse（恒 200：denied/clarify 等
 *                                      非答案态走回答通道，不是 HTTP 错误）
 *   GET  /ai-query/sessions?limit=50 → { items: SessionSummary[] }
 *   GET  /ai-query/sessions/:id      → 会话线程（跨用户读 404）
 *
 * 错误语义：HTTP 层错误（400 空问句 / 404 未知会话等）经 apiClient 抛
 * ApiError（code 形如 ai_query.invalid_input）；本层只对 200 响应体做形状
 * 校验，坏形状抛不带 API 路径的人话错误（体例同 reportingApi.getOutputTrend）。
 */
import { request } from './apiClient';

// ---- Wire 类型镜像（合同 §Wire 逐字段冻结） ----

export type AiQuerySubjectKind = 'workorder' | 'material' | 'inspection';

export interface AiQueryCapability {
  readonly capabilityId: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly subjectKind: AiQuerySubjectKind;
  readonly requiredPermissions: readonly string[];
  readonly status: 'ready';
}

export interface AiQueryFactCardSubject {
  readonly kind: AiQuerySubjectKind;
  readonly id: string;
  readonly label: string;
}

export interface AiQueryMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  readonly unit?: string;
}

export interface AiQueryFactCardRows {
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly values: readonly (readonly (string | number | null)[])[];
}

export interface AiQueryTimeBasis {
  readonly kind: 'point' | 'range';
  readonly label: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AiQuerySourceRef {
  readonly ref: string;
  readonly queryMoment: string;
}

export interface AiQueryCompleteness {
  readonly status: 'complete' | 'truncated';
  readonly rowCount: number;
  readonly totalKnown: boolean;
  readonly note?: string;
}

export interface AiQueryFactCard {
  readonly subject: AiQueryFactCardSubject;
  readonly title: string;
  readonly metrics: readonly AiQueryMetric[];
  readonly rows?: AiQueryFactCardRows;
  readonly timeBasis: AiQueryTimeBasis;
  readonly sourceRefs: readonly AiQuerySourceRef[];
  readonly completeness: AiQueryCompleteness;
}

export interface AiQueryAnswer {
  readonly kind: 'answer';
  readonly sessionId: string;
  readonly answerId: string;
  readonly capabilityId: string;
  readonly summary: string;
  readonly caliberNotes: readonly string[];
  readonly factCards: readonly AiQueryFactCard[];
  readonly createdAt: string;
}

export interface AiQueryClarify {
  readonly kind: 'clarify';
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly label: string; readonly description: string }[];
}

export interface AiQueryDenied {
  readonly kind: 'denied';
  readonly sessionId: string;
  readonly reason: 'no_permission';
  readonly missingPermissions: readonly string[];
  readonly hint: string;
}

export interface AiQueryUnsupported {
  readonly kind: 'unsupported';
  readonly sessionId: string;
  readonly hint: string;
  readonly capabilityHints: readonly string[];
}

export interface AiQueryUnavailable {
  readonly kind: 'unavailable';
  readonly sessionId: string;
  readonly reason: 'data_source_not_ready';
  readonly detail: string;
}

/** 五态判别联合（ask 响应；零行是合法 answer）。 */
export type AiQueryAskResponse =
  | AiQueryAnswer
  | AiQueryClarify
  | AiQueryDenied
  | AiQueryUnsupported
  | AiQueryUnavailable;

export interface AiQuerySessionSummary {
  readonly sessionId: string;
  readonly lastActivityAt: string;
  readonly turnCount: number;
}

export interface AiQuerySessionTurn {
  readonly question: string;
  readonly answerId?: string;
  readonly kind: AiQueryAskResponse['kind'];
  readonly response: AiQueryAskResponse;
}

export interface AiQuerySessionDetail {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly turns: readonly AiQuerySessionTurn[];
}

// ---- 形状校验（200 响应体；坏形状抛错不静默） ----

const ASK_KINDS: ReadonlySet<string> = new Set(['answer', 'clarify', 'denied', 'unsupported', 'unavailable']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asAskResponse(body: unknown): AiQueryAskResponse {
  const kind = isRecord(body) ? body['kind'] : undefined;
  if (typeof kind !== 'string' || !ASK_KINDS.has(kind)) {
    throw new Error('问数响应形状非法（缺 kind 字段或未知态）');
  }
  return body as AiQueryAskResponse;
}

function asItems(body: unknown): readonly Record<string, unknown>[] {
  const items = isRecord(body) ? body['items'] : undefined;
  if (!Array.isArray(items)) {
    throw new Error('问数端点响应形状非法（缺 items 列表）');
  }
  return items as Record<string, unknown>[];
}

// ---- 端点封装（Bearer 由 apiClient.request 自动注入） ----

/** 能力目录（GET /ai-query/capabilities）。 */
export async function listCapabilities(): Promise<readonly AiQueryCapability[]> {
  return (await request('/ai-query/capabilities').then(asItems)) as readonly AiQueryCapability[];
}

/** 问数（POST /ai-query/ask；恒 200，五态经 kind 判别）。 */
export async function ask(input: {
  readonly sessionId?: string | undefined;
  readonly question: string;
  readonly selectedOptionId?: string | undefined;
}): Promise<AiQueryAskResponse> {
  const body: Record<string, string> = { question: input.question };
  if (input.sessionId !== undefined) body['sessionId'] = input.sessionId;
  if (input.selectedOptionId !== undefined) body['selectedOptionId'] = input.selectedOptionId;
  return request('/ai-query/ask', { method: 'POST', body: JSON.stringify(body) }).then(asAskResponse);
}

/** 本人会话列表（GET /ai-query/sessions，缺省 limit=50 服务端口径）。 */
export async function listSessions(limit?: number | undefined): Promise<readonly AiQuerySessionSummary[]> {
  const suffix = limit === undefined ? '' : `?limit=${limit}`;
  return (await request(`/ai-query/sessions${suffix}`).then(asItems)) as readonly AiQuerySessionSummary[];
}

/** 会话线程（GET /ai-query/sessions/:id；跨用户读 404 → ApiError）。 */
export async function getSession(id: string): Promise<AiQuerySessionDetail> {
  const body: unknown = await request(`/ai-query/sessions/${encodeURIComponent(id)}`);
  if (!isRecord(body) || !Array.isArray(body['turns']) || typeof body['sessionId'] !== 'string') {
    throw new Error('会话线程响应形状非法（缺 sessionId/turns）');
  }
  return body as unknown as AiQuerySessionDetail;
}
