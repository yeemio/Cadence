/**
 * payroll 跨模块端口（M3，m3-drafts/01-payroll.md v1.0 §4）。
 *
 * 依赖方向（ADR-0004 专业包 / ADR-0011 水平内核，差异表 #5 裁定）：
 *  - 仅依赖 business-core（UserId/TenantContext）；
 *  - 消费 hours（M2）的产出事实：**消费其端口形状，不依赖实现**——
 *    "已审核工时×人×月"事实在本包声明为 VerifiedLaborFact，由组合根适配器
 *    实现 PayrollSource 接线（hours 不 import 本包、本包不 import hours，
 *    两侧结构同形、apps/server 组合根粘合，R-M3-3）；
 *  - 计薪规则 = 数据（版本化）：改规则 = 发新版本，历史核算引用旧版本可复算。
 *
 * 词汇纪律（ADR-0010）：行业/客户口径词（工种名、计件单价表等）只出现在
 * 规则与配置的数据值里，不进类型；工种值集五词冻结见 payroll-config。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { LaborKind } from './payroll-config.js';

/** 计薪周期粒度（通用词；v1 锁 month——86/87 均按月，week/custom 留形状不实现，§8 #6）。 */
export type PayPeriodKind = 'month' | 'week' | 'custom';

/** 计薪周期：规则与薪酬记录共用的周期锚（人 × 周期 × 规则版本 = 核算粒度）。 */
export interface PayPeriod {
  /** 周期键（hours 模块月度归集 LaborLedgerMonth 的同形锚，如 '2026-10'）。 */
  readonly periodKey: string;
  readonly kind: PayPeriodKind;
  /** ISO date，含 */
  readonly startsOn: string;
  /** ISO date，含 */
  readonly endsOn: string;
}

/**
 * 计量基础（ADR-0010 通用化重述：计时/计件 → 按什么量计价）。
 * v1 只接 hours 事实源（VerifiedLaborFact）；output（计件）数据源未定
 * （合同 §10），形状保留、发布面拒绝（§8 #7）。
 */
export type EarningsBasis = 'hours' | 'output';

/**
 * 已审核工时事实（端口形状）：hours 模块（M2）的对外产出
 * "已审核工时 × 人 × 月"（m2-drafts/08-hours §1 Out / §7 对账口径
 * "verified 报工净额（含撤销冲销）"）。本包消费此形状，不 import hours 实现。
 */
export interface VerifiedLaborFact {
  readonly personId: UserId;
  /** 周期锚（与 PayPeriod.periodKey 同形，'YYYY-MM'）。 */
  readonly periodKey: string;
  /** 工种（m2 v1.1 冻结五词 part/assembly/electrical/aftermarket/oddjob）。 */
  readonly laborKind: LaborKind;
  /** 已审核净工时（小时；撤销冲销后净额，不取整）。 */
  readonly hours: number;
  /** 来源工时账目 id（hours LaborEntry 引用，下钻与对账锚点）。 */
  readonly sourceEntryIds: readonly string[];
}

/** 工时事实读取请求（合同 §4 形状）。 */
export interface PayrollLaborRequest {
  /** 租户（组合根适配器按租户读取 hours 事实——多租户语义，接线前必修）。 */
  readonly tenantId: TenantId;
  readonly periodKey: string;
  /** 缺省 = 周期内全部人员 */
  readonly personIds?: readonly UserId[];
}

/**
 * 数据源端口：由组合根适配器实现（读 hours 月度归集/工时条目查询拼装该形状），
 * apps/server 接线。本包提供缺省空实现 = 零接线 boot（无可核算工时，规则维护
 * 与查询语义完整）。
 */
export interface PayrollSource {
  readVerifiedLabor(request: PayrollLaborRequest): Promise<readonly VerifiedLaborFact[]>;
}

/** 缺省空源（零接线 boot：恒空事实集）。 */
export const EMPTY_PAYROLL_SOURCE: PayrollSource = {
  readVerifiedLabor: async () => [],
};
