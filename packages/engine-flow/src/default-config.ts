/**
 * 默认审批流配置：通用审批（draft → submitted → 评审循环 → 终态）。
 *
 * 这是"机加工场景默认配置"级别的默认值（ADR-0010 条 2 状态集配置分离的默认实例），
 * 不是内核：行业包/租户可整体替换为自有状态集（见 tests/runtime.test.ts 的
 * 自定义配置行为差异用例）。全部状态与命令为通用词，零行业词（ADR-0010 条 1）。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from './config.js';

export const DEFAULT_APPROVAL_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: 'general-approval',
  initial: 'draft',
  states: [
    { id: 'draft' },
    { id: 'submitted' },
    { id: 'in_review' },
    { id: 'escalated' },
    { id: 'approved', final: true },
    { id: 'rejected', final: true },
    { id: 'withdrawn', final: true },
  ],
  transitions: [
    { from: 'draft', event: 'SUBMIT', to: 'submitted', eventAction: 'submitted' },
    { from: 'submitted', event: 'START_REVIEW', to: 'in_review', eventAction: 'review-started' },
    { from: 'submitted', event: 'WITHDRAW', to: 'withdrawn', decision: 'withdraw', eventAction: 'withdrawn' },
    { from: 'in_review', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
    { from: 'in_review', event: 'REJECT', to: 'rejected', decision: 'reject', eventAction: 'rejected' },
    { from: 'in_review', event: 'ESCALATE', to: 'escalated', decision: 'escalate', eventAction: 'escalated' },
    { from: 'in_review', event: 'WITHDRAW', to: 'withdrawn', decision: 'withdraw', eventAction: 'withdrawn' },
    { from: 'escalated', event: 'RESUME', to: 'in_review', eventAction: 'resumed' },
    { from: 'escalated', event: 'WITHDRAW', to: 'withdrawn', decision: 'withdraw', eventAction: 'withdrawn' },
  ],
});
