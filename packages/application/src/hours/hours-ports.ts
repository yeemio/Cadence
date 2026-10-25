/**
 * hours 跨模块端口（M2-W6，08-hours.md v1.0 §4 依赖 M2）。
 *
 * 只定义接口与缺省实现（模块间互调一律经 application 层端口，ADR-0011 / 通用
 * 合同纪律 6）。reporting 线并行实施中——事件形状按 05-reporting.md §6 合同
 * 事件载荷以**本地镜像结构类型**承载（与 listing-ports 的 WorkOrderCreated 镜像
 * 同取舍），不 import 其 WIP 文件；合流时以结构化兼容注入真实订阅端口。
 *
 * 工作令维度经事实链携带（派工单→图号→工作令）：verified/revoked 事件载荷
 * 直接带 workOrderId / drawingNo / dispatchId，本模块不再回查 dispatch。
 */
import type { TenantId } from '@smes/business-core';
import type { HoursTrade, ReportKind } from './hours-config.js';

// ---- reporting 端口：ReportVerified / ReportRevoked 事件订阅 ----

/**
 * 报工事件载荷镜像（ReportVerified / ReportRevoked 共用快照形状；字段口径以
 * 05-reporting.md §2/§6 为准：kind 五类、挂 DispatchId、完工数量+工时+申报人、
 * 工艺属性随单快照；撤销事件另带原因）。
 */
export interface ReportEventPayloadShape {
  /** 报工单 id（幂等锚点：同一报工单只入账一次净额链）。 */
  readonly reportId: string;
  /** 报工类别（五类稳定码）。 */
  readonly kind: ReportKind;
  /** 来源派工单 id（可空：零工类报工可不挂派工单）。 */
  readonly dispatchId: string | null;
  /** 工作令 id（事实链：派工单→图号→工作令；可空 = 未关联工作令）。 */
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  /** 工序业务码（随单快照；可空）。 */
  readonly processCode: string | null;
  /** 申报人（工人）——工时归属人。 */
  readonly worker: string;
  /** 完工数量（revoked 事件为撤销时点的单值快照）。 */
  readonly doneQty: number;
  /** 申报工时（小时）。 */
  readonly hours: number;
  /** 业务日期 'YYYY-MM-DD'（工时归属日）。 */
  readonly workDate: string;
  /** 撤销原因（仅 revoked 事件；verified 为 null）。 */
  readonly revokeReason: string | null;
  readonly actor: string;
}

/** 订阅消息（域事件的最小消费面：eventId + 信号判别 + 载荷）。 */
export interface ReportEventMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  /** 'ReportVerified' → 入账；'ReportRevoked' → 冲销（合同 §6 归集/冲销信号）。 */
  readonly signal: 'ReportVerified' | 'ReportRevoked';
  readonly payload: ReportEventPayloadShape;
}

/**
 * reporting 事件订阅端口。实现方读 reporting 域事件账本
 * （smes.reporting.v1.report-verified / report-revoked）并维护消费位；缺省空
 * 实现 = 零接线 boot（无 verified 事件可归集，月度重算/查询语义完整）。
 */
export interface ReportEventFeedPort {
  /** 拉取该租户未确认的 verified/revoked 事件（occurredAt 升序）。 */
  pending(tenant: TenantId): Promise<readonly ReportEventMessage[]>;
  /** 确认消费（幂等：重复确认无副作用）。 */
  acknowledge(eventId: string): Promise<void>;
}

/** 缺省空订阅（零接线 boot）。 */
export const EMPTY_REPORT_EVENT_FEED: ReportEventFeedPort = {
  pending: async () => [],
  acknowledge: async () => {},
};

// ---- baseline 端口：StandardTime 额定工时对标 ----

/** 对标请求（图号 + 工序双键；任一可空 = 实现方按自身键口径解析）。 */
export interface StandardTimeRef {
  readonly drawingNo: string | null;
  readonly processCode: string | null;
}

/**
 * baseline StandardTime 额定工时端口（08-hours.md §4：baseline 出标准、本模块
 * 出实际）。StandardTime 属 P2/P3 并行线——缺省恒 null（对标列空），实装后由
 * 组合根注入真实实现，按工作令视图挂额定 vs 实际对比。
 */
export interface StandardTimePort {
  /** 额定工时（小时）；null = 无可用标准（缺省口径）。 */
  standardHours(tenant: TenantId, ref: StandardTimeRef): Promise<number | null>;
}

/** 缺省对标端口：恒 null（无 baseline StandardTime 接线时空对比列）。 */
export const EMPTY_STANDARD_TIME: StandardTimePort = {
  standardHours: async () => null,
};
