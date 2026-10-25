/**
 * 报工草稿形状（M5 首波升级，原位不动——e2e-scan-report.test.ts 等消费方
 * import 本路径）：草稿表单 → 提交载荷构造 + 形状守卫（离线队列 hydrate 用）。
 * 消费方：m.report 移动报工页（pages/m/ReportPage）、reportingApi、离线队列。
 *
 * 取舍：不放 product-ui——product-ui 视图模型位放的是响应解析/请求构造的
 * 跨页复用形状（workbench/org/masterdata/hours/inventory），报工草稿是
 * 报工页与离线队列的局部载荷形状，页面码三问记录见 ReportPage 文件头。
 * 词汇（ADR-0010）：report/draft/ref/quantity/labor/note 均为通用词。
 *
 * M5 首波变更：补 laborMinutes（预研缺省 1 分钟占位移除——工时来自真实
 * 录入；校验对齐后端 reporting-input requireLaborMinutes：正整数分钟、上限
 * 44640 = 1440×31 单次报工防误输）。旧离线队列条目（无 laborMinutes 字段）
 * 过守卫时被丢弃——预研形态无存量数据，不作迁移。
 */

/** 一次报工提交（在线直发与离线入队共用同一形状与幂等键）。 */
export interface ReportDraftSubmission {
  /** 幂等键：提交动作创建时生成（crypto.randomUUID），重放端据此去重。 */
  readonly key: string;
  /** 对象引用：扫到的码（派工单 id——页面语义，传输层不解释）。 */
  readonly ref: string;
  readonly quantity: number;
  /** 工时（正整数分钟；M5 首波补真实录入，预研缺省占位已移除）。 */
  readonly laborMinutes: number;
  readonly note: string | null;
  /** 提交时刻（ISO 字符串；补录口径 = 业务时刻）。 */
  readonly submittedAt: string;
}

/** 单次报工工时上限（对齐后端 requireLaborMinutes：1440×31 分钟）。 */
export const MAX_LABOR_MINUTES = 44_640;

export class ReportDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportDraftError';
  }
}

export interface BuildReportDraftInput {
  readonly key: string;
  readonly ref: string;
  readonly quantity: number;
  readonly laborMinutes: number;
  readonly note: string | null;
  readonly submittedAt: string;
}

/** 构造提交载荷：ref 非空、quantity 正数、laborMinutes 正整数分钟，否则抛错。 */
export function buildReportDraftSubmission(input: BuildReportDraftInput): ReportDraftSubmission {
  if (typeof input.key !== 'string' || input.key.length === 0) {
    throw new ReportDraftError("字段 'key' 须为非空字符串");
  }
  if (typeof input.ref !== 'string' || input.ref.trim().length === 0) {
    throw new ReportDraftError("字段 'ref' 须为非空字符串");
  }
  if (typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new ReportDraftError("字段 'quantity' 须为正数");
  }
  if (
    typeof input.laborMinutes !== 'number' ||
    !Number.isInteger(input.laborMinutes) ||
    input.laborMinutes <= 0 ||
    input.laborMinutes > MAX_LABOR_MINUTES
  ) {
    throw new ReportDraftError(`字段 'laborMinutes' 须为 (0, ${MAX_LABOR_MINUTES}] 内的整数分钟`);
  }
  if (typeof input.submittedAt !== 'string' || Number.isNaN(Date.parse(input.submittedAt))) {
    throw new ReportDraftError("字段 'submittedAt' 须为可解析的 ISO 时间字符串");
  }
  return {
    key: input.key,
    ref: input.ref.trim(),
    quantity: input.quantity,
    laborMinutes: input.laborMinutes,
    note: input.note === null || input.note.trim().length === 0 ? null : input.note.trim(),
    submittedAt: input.submittedAt,
  };
}

/** 形状守卫（OfflineQueue hydrate 的 isPayload 注入）。 */
export function isReportDraftSubmission(value: unknown): value is ReportDraftSubmission {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['key'] === 'string' &&
    record['key'].length > 0 &&
    typeof record['ref'] === 'string' &&
    record['ref'].length > 0 &&
    typeof record['quantity'] === 'number' &&
    Number.isFinite(record['quantity']) &&
    record['quantity'] > 0 &&
    typeof record['laborMinutes'] === 'number' &&
    Number.isInteger(record['laborMinutes']) &&
    record['laborMinutes'] > 0 &&
    record['laborMinutes'] <= MAX_LABOR_MINUTES &&
    (record['note'] === null || typeof record['note'] === 'string') &&
    typeof record['submittedAt'] === 'string' &&
    !Number.isNaN(Date.parse(record['submittedAt']))
  );
}
