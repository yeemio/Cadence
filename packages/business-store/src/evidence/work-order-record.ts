/**
 * WorkOrderRecord 行形状与构造（示例业务事实表——证据公共列复用模式的首个消费者）。
 *
 * ADR-0010：WorkOrder 是内核通用词汇白名单成员。业务载荷列（物料、数量、
 * 工艺字段等）由 M2 领域规格产出后增补进 schema 与本形状——清洁室不预造。
 */
import type { TenantId } from '@smes/business-core';
import { isUuid } from '../ids/uuidv7.js';
import type { EvidenceColumnsInput, EvidenceColumnsRow } from './evidence-columns.js';
import { buildEvidenceColumns } from './evidence-columns.js';

/** 事实表行 = 证据公共列 + 领域键（此处仅聚合身份 workOrderId）。 */
export interface WorkOrderRecordRow extends EvidenceColumnsRow {
  /** 工作令聚合身份（跨修订不变；同一 workOrderId 的多行 = 修正链/多版本） */
  readonly workOrderId: string;
}

export interface WorkOrderRecordInput extends EvidenceColumnsInput {
  readonly workOrderId: string;
}

/**
 * 构造工作令记录插入行（冻结）。workOrderId 须为合法 UUID
 * （新建聚合时由调用方 uuidv7() 生成；已有聚合沿用它）。
 */
export function buildWorkOrderRecordCreate(input: WorkOrderRecordInput): WorkOrderRecordRow {
  if (!isUuid(input.workOrderId)) {
    throw new Error(`invalid workOrderId: expected a uuid string, got "${input.workOrderId}"`);
  }
  const evidence = buildEvidenceColumns(input);
  return Object.freeze({
    ...evidence,
    workOrderId: input.workOrderId,
  });
}

/** 多租户读回的键形状（配合 Prisma where 子句的租户贯通示例）。 */
export function workOrderRecordScope(tenantId: TenantId, workOrderId: string): {
  tenantId: TenantId;
  workOrderId: string;
} {
  return Object.freeze({ tenantId, workOrderId });
}
