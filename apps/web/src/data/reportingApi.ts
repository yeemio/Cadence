/**
 * 报工提交通道（M5 首波正式：mock → 真实 reporting 端点；词汇：report 为
 * ADR-0010 内核白名单通用词）。单点替换：调用方（移动报工页与离线重放）
 * 依赖本函数签名（形状出口：Promise<void>、失败抛错），对接后页面与队列
 * 代码不改。
 *
 * 后端合同（packages/application/src/reporting/，M2-W7 落地）：
 * - 端点 POST /reports，权限码 report:submit（Bearer 会话身份，租户与申报人
 *   均取请求上下文——载荷不带，ADR-0005）；
 * - 请求体 = smes.command.v1 信封：{ operationId, expectedRevision: 'initial',
 *   command: { kind: 'report.submit.v1', payload: { dispatchId, doneQty,
 *   laborMinutes, businessTime, remark } } }；
 * - 响应 = ReportCommandResult：committed（HTTP 201）/ rejected（HTTP 201 +
 *   status:'rejected'——业务拒绝不是传输错误，控制器直返值）/ indeterminate。
 *
 * 草稿形状 → 请求体映射（后端比草稿多/异字段，全部在本层写明）：
 * - key → operationId（幂等键同源：离线重放重发同 key 即同 operationId，
 *   后端幂等记账拒重复执行——离线重放不产生重复报工）；
 * - ref → dispatchId（页面"对象引用"语义 = 派工单不透明 id；非派工单 id
 *   会被 submit 前置校验 fail-closed 拒绝，经 rejected 路径反馈）；
 * - quantity → doneQty；laborMinutes → laborMinutes（M5 首波起来自草稿
 *   真实录入——预研的缺省 1 分钟占位已随草稿形状补字段移除）；
 * - note → remark（null 直传，后端可空）；
 * - submittedAt → businessTime（补录口径：草稿提交时刻即业务时刻）；
 * - expectedRevision 恒 'initial'（submit 是创建命令——后端合同）。
 *
 * rejected / indeterminate 均按"失败抛错"归一（调用方 catch 分支入离线队列）。
 * 注意：rejected 类失败（如派工单不存在）入队后重放仍会 rejected——
 * OfflineQueue 失败保留原位语义（attempts 累加、队头阻塞），用户可清队列
 * 存量后修正 ref 重报；reason 经 Error message 原样带回。
 */
import { request } from './apiClient';
import { fetchRawObject, fetchRows, postCommand, queryString, revisionOf } from './commandClient';
import type { ReportDraftSubmission } from '@/pages/scan/reportDraft';

export type { ReportDraftSubmission };

/** 草稿 → report.submit.v1 信封体（映射表见文件头；导出供单测钉形状）。 */
export function reportSubmitEnvelope(draft: ReportDraftSubmission): {
  readonly operationId: string;
  readonly expectedRevision: 'initial';
  readonly command: {
    readonly kind: 'report.submit.v1';
    readonly payload: {
      readonly dispatchId: string;
      readonly doneQty: number;
      readonly laborMinutes: number;
      readonly businessTime: string;
      readonly remark: string | null;
    };
  };
} {
  return {
    operationId: draft.key,
    expectedRevision: 'initial',
    command: {
      kind: 'report.submit.v1',
      payload: {
        dispatchId: draft.ref,
        doneQty: draft.quantity,
        laborMinutes: draft.laborMinutes,
        businessTime: draft.submittedAt,
        remark: draft.note,
      },
    },
  };
}

export async function submitReportDraft(draft: ReportDraftSubmission): Promise<void> {
  const result: unknown = await request('/reports', {
    method: 'POST',
    body: JSON.stringify(reportSubmitEnvelope(draft)),
  });
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    throw new Error('报工端点响应形状非法（缺 status 字段）');
  }
  const outcome = result as { status?: unknown; reason?: unknown };
  if (outcome.status === 'committed') return;
  if (outcome.status === 'rejected') {
    const reason = typeof outcome.reason === 'string' ? outcome.reason : '未知原因';
    throw new Error(`报工被拒绝：${reason}`);
  }
  throw new Error(`报工结果不确定（status=${String(outcome.status)}）`);
}

// ---- 管理读面与核查命令（S2 批次；端点形状按 reporting.controllers.ts 实态） ----

export interface ReportFilters {
  readonly kind?: string | undefined;
  readonly state?: string | undefined;
  readonly dispatchId?: string | undefined;
  readonly reporter?: string | undefined;
  readonly drawingNo?: string | undefined;
}

/** 报工单列表（五类 kind × 四态；多键过滤）。 */
export async function listReports(filters: ReportFilters = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/reports${queryString([
      ['kind', filters.kind],
      ['state', filters.state],
      ['dispatchId', filters.dispatchId],
      ['reporter', filters.reporter],
      ['drawingNo', filters.drawingNo],
    ])}`,
    'reports',
  );
}

/** 待核查队列（pending-verification 端点，具名路由在 :id 之前声明）。 */
export async function listPendingVerification(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/reports/pending-verification', 'reports');
}

/** 报工详情（直返对象：修正链+留痕+里程碑）。 */
export async function getReportDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/reports/${encodeURIComponent(id)}`);
}

/** 核查（reported→verified；载荷=hours 消费合同）。 */
export function verifyReport(id: string, row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/reports/${encodeURIComponent(id)}/verify`,
    'report.verify.v1',
    { remark: remark ?? null },
    revisionOf(row, '报工单行'),
  );
}

/** 修正（修正版+原因，不改原单；reason 必填）。 */
export function auditEditReport(
  id: string,
  row: Record<string, unknown>,
  input: {
    readonly reason: string;
    readonly doneQty?: number | undefined;
    readonly laborMinutes?: number | undefined;
    readonly remark?: string | undefined;
  },
) {
  return postCommand(
    `/reports/${encodeURIComponent(id)}/audit-edit`,
    'report.audit-edit.v1',
    {
      reason: input.reason,
      doneQty: input.doneQty ?? null,
      laborMinutes: input.laborMinutes ?? null,
      businessTime: null,
      remark: input.remark ?? null,
    },
    revisionOf(row, '报工单行'),
  );
}

/** 撤销冲销（→ReportRevoked）。 */
export function revokeReport(id: string, row: Record<string, unknown>, reason?: string | undefined) {
  return postCommand(
    `/reports/${encodeURIComponent(id)}/revoke`,
    'report.revoke.v1',
    { reason: reason ?? null },
    revisionOf(row, '报工单行'),
  );
}

/** 图号 × 工序进度（{rows}）。 */
export async function getDrawingOperationProgress(drawingNo: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/reporting/drawings/${encodeURIComponent(drawingNo)}/operation-progress`, 'rows');
}

/** 产出趋势（缺省 12 日窗口；{trend} 数组行）。 */
export async function getOutputTrend(days?: number | undefined): Promise<readonly Record<string, unknown>[]> {
  const suffix = days === undefined ? '' : `?days=${days}`;
  return fetchRows(`/reporting/output-trend${suffix}`, 'trend');
}
