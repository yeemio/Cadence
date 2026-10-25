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
