/**
 * maintenance 跨模块端口（M3，m3-drafts/02-maintenance.md v1.0 §4）。
 *
 * 依赖方向（ADR-0004 专业包 / pro-pack-tier-edges）：
 *  - 仅依赖 business-core（UserId）；存储走端口（business-store 实现，组合根接线）；
 *    engine-flow 承载任务状态机配置（见 maintenance-config）；
 *  - **消费 baseline 的形状引用，零代码依赖**（差异表 #4 裁定）：
 *      ResourceRef = 设备台账（baseline EquipmentRecord，功能项 16）id 形状——
 *        字符串引用，不复制台账；存在性校验归组合根/实施层；
 *      FaultRef   = baseline FaultReport（功能项 20，P2 标准项）id 形状——
 *        故障的"报与闭环"归 baseline；本包只做维修处置记录与任务安排；
 *      FaultReportedFact / FaultResolvedFact = baseline 事件载荷的**结构同形
 *        镜像**（字段名逐一同形，不 import @smes/application）——故障联动经
 *        baseline Outbox 事件（FaultReported/FaultResolved）在组合根适配为
 *        本包任务建议/待办（apps/server 粘合归总控，本包与 baseline 零 import）。
 *
 * 词汇纪律（ADR-0010）：点检/保养/维修是三态**记录动词**（通用），判据/周期/
 * 动作清单全部是数据（计划作者/租户配置定义），不进内核类型。
 */
import type { UserId } from '@smes/business-core';

/** 设备引用：baseline 设备台账（EquipmentRecord）的 id 形状（字符串引用，不依赖包）。 */
export type ResourceRef = string;

/** 故障引用：baseline FaultReport 的 id 形状（字符串引用，不依赖实现）。 */
export type FaultRef = string;

/**
 * baseline FaultReported 事件载荷的结构同形镜像（消费面形状；eventType =
 * 'smes.baseline.v1.fault-reported'）。组合根订阅 Outbox 后把 equipmentCode
 * 解析为 ResourceRef（台账存在性校验在该层），再组装 maintenance.task.create.v1。
 */
export interface FaultReportedFact {
  readonly faultReportId: string;
  readonly equipmentCode: string;
  readonly description: string;
  readonly reportedBy: string;
  readonly assignee: string;
  readonly state: string;
  readonly objectVersion: number;
  /** 随迁移创建的维修待办 id（待办联动留痕；无待办线时 null）。 */
  readonly todoId: string | null;
}

/**
 * baseline FaultResolved 事件载荷的结构同形镜像（eventType =
 * 'smes.baseline.v1.fault-resolved'）。悬挂态提醒口径（合同 §10 开放问题）由
 * 组合根消费该事实时对账，本包不自动同步任务状态。
 */
export interface FaultResolvedFact {
  readonly faultReportId: string;
  readonly equipmentCode: string;
  readonly assignee: string | null;
  readonly remark: string | null;
  readonly state: string;
  readonly objectVersion: number;
}

/**
 * 故障联动建议（组合根适配 FaultReportedFact 后的产物形状）：设备 × 故障引用 ×
 * 建议执行人——总控/组合根据此组装 maintenance.task.create.v1（kind=repair，
 * faultRef=Fact.faultReportId）。本包不订阅 Outbox（接线归组合根），此形状供
 * 粘合层与 testkit 夹具结构校验。
 */
export interface FaultTaskSuggestion {
  readonly resourceRef: ResourceRef;
  readonly faultRef: FaultRef;
  readonly description: string;
  readonly suggestedAssignee: UserId | null;
  readonly reportedAt: string;
}
