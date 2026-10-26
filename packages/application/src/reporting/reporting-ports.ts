/**
 * reporting 跨模块端口（M2-W7，05-reporting.md §4"依赖"与"被依赖"）。
 *
 * 只定义接口与缺省实现（模块间互调一律经 application 层端口，ADR-0011 / 通用
 * 合同纪律 6；跨模块只 import 已导出端口接口）。四个方向：
 *  - dispatch（依赖）：有效派工单校验读端口 ValidDispatchSource——submit 前
 *    校验派工单存在且处于可报状态，并取工艺属性快照（图号×工序×工作令随报工
 *    单快照，不回查 dispatch）；实现方 = 组合根把 dispatch DispatchOrderStore
 *    投影成 DispatchFactForReport（结构化兼容，不引类型）；缺省空实现 = 恒无
 *    单（零接线 boot 一切 submit 被拒——派工事实不可伪证，fail-closed）；
 *  - baseline（依赖）：工序合法性 OperationValidityPort（报工工序须在工序库）
 *    + 末道工序判定 FinalOperationJudgePort（工艺路线末道才触发自制质检）；
 *    缺省空实现 = 工序恒合法（fail-open：工序已在派工链路校验过，报工侧是
 *    复检）/ 恒非末道（不触发质检——零接线 boot 语义完整）；
 *  - inspection（被依赖调方）：末道报工触发待检单 InspectionIntakePort——
 *    reporting 是调用方，通知式（回执进事件载荷，未接线不阻塞报工落账）；
 *  - 被依赖面：hours（ReportVerified/ReportRevoked 事件消费）、workorder
 *    （进度上卷订阅方）、engine-reporting（产出趋势事实查询）——经域事件与
 *    查询供给，本文件不开端口。
 *
 * 端口方法一律异步；全部按租户收口。
 */
import type { TenantId } from '@smes/business-core';
import type { InspectionIntakePort } from '../inspection/inspection-ports.js';

export type { InspectionIntakePort, InspectionIntakeReceipt } from '../inspection/inspection-ports.js';

// ---- dispatch 端口：有效派工单校验（submit 前置） ----

/**
 * 派工单的消费面事实（dispatch DispatchOrderStore 的结构化投影——报工侧只读
 * 这一面；字段缺失按 null 收口）。kind/state 词汇以 dispatch-config 为准，
 * 跨模块不引类型（opaque string）。
 */
export interface DispatchFactForReport {
  readonly dispatchId: string;
  /** 六类派工 kind：part/outsourcing/assembly/electrical/aftermarket/oddjob。 */
  readonly kind: string;
  /** draft/assigned/executing/done/cancelled。 */
  readonly state: string;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  /** 派工数量（超报闸门上界：累计有效报工 + 本次 ≤ quantity——fix-wave-4 W4-1）。 */
  readonly quantity: number;
  /** 执行人（可选的对账参考输入；报工申报人以命令签发人为准）。 */
  readonly assignee: string | null;
}

/**
 * 有效派工单校验读端口。实现方读 dispatch 订单投影并校验 (tenant, id) 收口；
 * 缺省空实现 = 恒无单（submit 全拒：派工单事实在 dispatch 侧，不可伪证）。
 */
export interface ValidDispatchSource {
  findDispatch(tenant: TenantId, dispatchId: string): Promise<DispatchFactForReport | null>;
}

/** 缺省派工单读端口：恒无单（零接线 boot——submit 被拒并提示接线，不静默放行）。 */
export const EMPTY_VALID_DISPATCH_SOURCE: ValidDispatchSource = {
  findDispatch: async () => null,
};

/** dispatch 投影行的结构化形状（组合根/测试适配器用；字段缺失按 null/0 收口）。 */
export interface DispatchOrderLike {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly state?: unknown;
  readonly workOrderId?: unknown;
  readonly drawingNo?: unknown;
  readonly operationCode?: unknown;
  readonly quantity?: unknown;
  readonly assignee?: unknown;
}

/** dispatch 投影镜像 → 消费面事实（组合根/测试适配器用）。 */
export function toDispatchFactForReport(dispatchId: string, order: DispatchOrderLike): DispatchFactForReport {
  return {
    dispatchId,
    kind: typeof order.kind === 'string' ? order.kind : '',
    state: typeof order.state === 'string' ? order.state : '',
    workOrderId: typeof order.workOrderId === 'string' ? order.workOrderId : null,
    drawingNo: typeof order.drawingNo === 'string' ? order.drawingNo : null,
    operationCode: typeof order.operationCode === 'string' ? order.operationCode : null,
    quantity: typeof order.quantity === 'number' ? order.quantity : 0,
    assignee: typeof order.assignee === 'string' ? order.assignee : null,
  };
}

// ---- baseline 端口：工序合法性 + 末道工序判定 ----

/**
 * 工序合法性端口：报工单携带的 operationCode 须在 baseline 工序库中为已知工序。
 * 缺省空实现 = 恒合法（fail-open：工序合法性已在派工链路校验，报工侧复检不
 * 阻塞零接线 boot；接线后未知工序 → submit rejected）。
 */
export interface OperationValidityPort {
  isKnownOperation(tenant: TenantId, operationCode: string): Promise<boolean>;
}

/** 缺省工序合法性端口：恒合法（零接线 boot 语义完整）。 */
export const ALL_OPERATIONS_VALID: OperationValidityPort = {
  isKnownOperation: async () => true,
};

/**
 * 末道工序判定端口：图号工艺路线中该工序是否末道（末道报工才触发自制质检——
 * inspection intake 合同对账要点）。实现方读 baseline 工艺路线（P2 件）；
 * 缺省空实现 = 恒非末道（不触发质检——工艺路线未接线时语义完整）。
 */
export interface FinalOperationJudgePort {
  isFinalOperation(tenant: TenantId, drawingNo: string, operationCode: string): Promise<boolean>;
}

/** 缺省末道判定端口：恒非末道（零接线 boot——末道质检触发待工艺路线接线）。 */
export const NEVER_FINAL_OPERATION: FinalOperationJudgePort = {
  isFinalOperation: async () => false,
};

// ---- inspection 端口：末道报工触发待检单（通知式） ----

/** 缺省末道触发端口：未接线时来源事实不落地（inspection intake 合同的空实现语义）。 */
export const REPORTING_NOOP_INSPECTION_INTAKE: InspectionIntakePort = {
  receiveSourceFact: async () => ({
    inspectionId: null,
    created: false,
    reason: 'inspection intake 端口未接线：reporting 末道报工触发需组合根注入 InspectionService',
  }),
};
