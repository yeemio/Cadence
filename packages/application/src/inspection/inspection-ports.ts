/**
 * inspection 跨模块端口（M2-W4，06-inspection.md §4）。
 *
 * 只定义接口（模块间互调一律经 application 层端口，ADR-0011 / 通用合同纪律
 * 6；并行线在写 listing——接口互调只 import 本文件导出的接口）。四个方向：
 *  - 来源入口（In）：reporting 末道报工 / dispatch 外协回厂 / listing 收货的
 *    来源事件投递入口 InspectionIntakePort——InspectionService 实现该接口；
 *    兄弟模块/组合根合流时 import 接口即可互调，缺省空实现 = 未接线丢弃
 *    （零接线 boot 语义完整）。
 *  - 放行事实（Out）：passed 后发放行事实——StockReleasePort 由 inventory 实现
 *    （inventory 未合流前缺省空实现即可，放行语义经 released 域事件（Outbox）
 *    与端口双通道表达：事件是异步消费锚点，端口是组合根可选的直连通道）。
 *  - IM（Out）：闭环超时点名 NotifyChannel 由 integration-im / 组合根实现，
 *    缺省空实现（application 禁依赖 integration-*，ADR-0011——边缘词汇不进
 *    业务层，本端口是业务侧最小通知形状）。
 *  - 待办：复用 workbench TodoStore（module 注入，与 WorkbenchModule 同实例）。
 *
 * 端口方法一律异步（PG 实现天然异步）。全部按租户收口。
 */
import type { TenantId } from '@smes/business-core';
import type {
  InspectionKind,
  InspectionSourceType,
} from './inspection-config.js';

// ---- 来源事件入口（reporting / dispatch / listing → inspection） ----

/**
 * 来源事实（触发待检单生成的最小事实形状；三个来源共用，sourceType 区分）：
 *  - report：reporting 末道报工完成（末道工序才触发自制质检——对账要点）；
 *  - dispatch：外协回厂；
 *  - receipt：listing 收货（须显式给三类采购 kind 之一）。
 */
export interface InspectionSourceFact {
  readonly sourceType: InspectionSourceType;
  /** 来源对象 id（报工单/外协单/收货单，opaque；幂等去重键）。 */
  readonly sourceRefId: string;
  /** receipt 来源必填（三类采购之一）；report/dispatch 缺省（恒 self_outsourced）。 */
  readonly kind?: InspectionKind;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  /** 送检数量（正数）。 */
  readonly quantity: number;
  readonly workOrderId: string | null;
  readonly occurredAt: string;
  /** 触发系统账号（来源事件路由器/兄弟模块的系统身份）。 */
  readonly triggeredBy: string;
}

/** 来源入口回执：created=false 且 inspectionId 非空 = 幂等命中既有待检单。 */
export interface InspectionIntakeReceipt {
  readonly inspectionId: string | null;
  readonly created: boolean;
  readonly reason?: string;
}

/**
 * 来源事件订阅端口：组合根/兄弟模块（reporting 末道报工、dispatch 外协回厂、
 * listing 收货）把来源事实投递到这里，inspection 自动生成待检单。
 * InspectionService 实现本接口（receiveSourceFact = intake）。
 */
export interface InspectionIntakePort {
  receiveSourceFact(tenant: TenantId, fact: InspectionSourceFact): Promise<InspectionIntakeReceipt>;
}

/** 缺省空实现：未接线时来源事件不落地（boot 不炸；组合根接线后替换）。 */
export const EMPTY_INSPECTION_INTAKE_PORT: InspectionIntakePort = {
  receiveSourceFact: async () => ({ inspectionId: null, created: false, reason: 'intake 端口未接线' }),
};

// ---- 放行事实端口（inspection → inventory，合同 §2 放行规则） ----

/** 放行事实：passed 判定后 inventory 才可入库的许可锚点（与 released 事件同载荷口径）。 */
export interface StockReleaseFact {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly releasedAt: string;
}

/**
 * 放行事实端口：通知式（判定已落账后调用，失败不回滚判定——放行事实域事件
 * 已入 Outbox 为最终一致锚点；实现方由 inventory 合流时提供）。
 */
export interface StockReleasePort {
  recordRelease(tenant: TenantId, fact: StockReleaseFact): Promise<void>;
}

/** 缺省空实现：inventory 未合流前放行事实仅走事件通道（语义正确即可）。 */
export const NOOP_STOCK_RELEASE_PORT: StockReleasePort = {
  recordRelease: async () => undefined,
};

// ---- IM 通知端口（inspection → integration-im，经组合根接线） ----

/** 业务侧最小通知形状（标题/正文/业务指向；IM 适配词汇不进业务层）。 */
export interface NotifyMessage {
  readonly title: string;
  readonly body: string;
  readonly refType?: string;
  readonly refId?: string;
}

/** IM 通知端口：闭环超时点名等强提醒；由 integration-im / 组合根实现。 */
export interface NotifyChannel {
  notify(tenant: TenantId, message: NotifyMessage): Promise<void>;
}

/** 缺省空实现：无 IM 接线时点名仅走待办 + 事件（零接线 boot 语义完整）。 */
export const NOOP_NOTIFY_CHANNEL: NotifyChannel = {
  notify: async () => undefined,
};

// ---- 撤销前置闸门端口（inspection ← inventory/reporting/hours 经组合根，RQ-037） ----

/** 撤销命令要校验的质检单最小形状（闸门实现方按需取用）。 */
export interface RevokeGuardTarget {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
}

/**
 * 撤销质检前置闸门端口（RQ-037"关联入库未入库完成方可撤 + 下一道闸门 +
 * 工时已审禁撤"三项跨域校验的接缝）：源三项闸门分别读 IV（入库状态）、
 * reporting/baseline（紧邻下一道报工/已质检）、HC（工时审核）——本域一律
 * 不可见，经本端口由组合根接线实现。返回 null=可撤；返回 reason=拒绝原因。
 * 缺省 FAIL_CLOSED_INSPECTION_REVOKE_GUARD：未接线一律拒绝（数据完整性
 * 优先——放行/报工/工时状态不可见时不盲撤；组合根接线后替换）。
 */
export interface InspectionRevokeGuardPort {
  assertRevokable(tenant: TenantId, target: RevokeGuardTarget): Promise<string | null>;
}

/** 缺省 fail-closed 闸门：未接线 = 无法确认三项跨域闸门，拒绝撤销。 */
export const FAIL_CLOSED_INSPECTION_REVOKE_GUARD: InspectionRevokeGuardPort = {
  assertRevokable: async () =>
    '撤销闸门端口未接线（fail-closed）：无法确认关联入库/下一道工序/工时审核状态，拒绝撤销质检',
};

/** 测试/接线用放行闸门：三项跨域闸门全过（真实接线前不得用于组合根）。 */
export const PERMISSIVE_INSPECTION_REVOKE_GUARD: InspectionRevokeGuardPort = {
  assertRevokable: async () => null,
};

// ---- 待办联动 ----

/** 待办联动来源码（workbench TodoStore 的 source 口径；refType = 聚合类型）。 */
export const INSPECTION_TODO_SOURCE = 'inspection';
