/**
 * 审批配置输入解析（HTTP body → 业务输入；T 波 #102）。
 *
 * 配置文档校验**不在此重复实现**：直接委托 engine-flow defineApprovalFlowConfig
 * （结构/形状/树约束/超时交叉校验的唯一权威），其 Error 包装为
 * ApprovalConfigInputError（组合根映射 400）——fail-fast，不产生半合法配置。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';
import { ApprovalConfigInputError } from './approval-config-errors.js';

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApprovalConfigInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

/** 配置文档 → 固化配置（engine-flow 唯一权威校验；非法即 ApprovalConfigInputError）。 */
export function parseFlowConfig(input: unknown): ApprovalFlowConfig {
  try {
    return defineApprovalFlowConfig(input);
  } catch (error) {
    throw new ApprovalConfigInputError(
      `审批流配置非法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseFlowConfigIdParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new ApprovalConfigInputError(`流配置 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
