/**
 * 品牌化 ID 清单（M0 立桩集）。
 * M1/M2 各领域按需用 defineId 增补——增补不改机制。
 */
import { defineId } from './branding.js';

// ---- 身份与基础层（M1） ----
export const TenantId = defineId('TenantId');
export type TenantId = ReturnType<typeof TenantId.create>;

export const UserId = defineId('UserId');
export type UserId = ReturnType<typeof UserId.create>;

// ---- 工作令与九循环环节（M2） ----
export const WorkOrderId = defineId('WorkOrderId');
export type WorkOrderId = ReturnType<typeof WorkOrderId.create>;

export const DispatchId = defineId('DispatchId');
export type DispatchId = ReturnType<typeof DispatchId.create>;

export const ReportId = defineId('ReportId');
export type ReportId = ReturnType<typeof ReportId.create>;

export const InspectionId = defineId('InspectionId');
export type InspectionId = ReturnType<typeof InspectionId.create>;

// ---- 命令与事件 ----
export const OperationId = defineId('OperationId');
export type OperationId = ReturnType<typeof OperationId.create>;

export const EventId = defineId('EventId');
export type EventId = ReturnType<typeof EventId.create>;
