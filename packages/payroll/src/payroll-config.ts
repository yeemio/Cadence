/**
 * payroll 默认配置层（M3，m3-drafts/01-payroll.md v1.0 §2 分层标注第三层）。
 *
 * 工种值集五词、量纲上界与缺省系数是**默认配置/量纲纪律**（实施时按客户口径
 * 调整值域，不属内核）；append-only 不可变纪律、快照重算幂等语义与
 * "金额 = 量 × 单价 × 系数"换算纪律在内核（服务层与存储端口合同）。
 *
 * 量纲冻结（m2 v1.1 纪律，差异表 #4）：
 *   quantity = 小时（hours 存储口径，不取整）；
 *   rate     = 分/小时（整数，> 0）；
 *   amount   = 分（整数；quantity × rate × coefficient 后 half-up 到分——
 *              对齐 baseline 外协计价 half-up 先例）；
 *   laborKind 值集 = 工种五词 part/assembly/electrical/aftermarket/oddjob
 *              （m2 v1.1 冻结，reporting 与 hours 逐词一致；未知词 rejected
 *              不静默）。
 */
import { PayrollInputError } from './payroll-errors.js';

// ---- 工种五词（m2 v1.1 冻结） ----

/** 工种稳定码（五词；与 reporting REPORT_KINDS / hours 入账词逐词一致）。 */
export const LABOR_KINDS = ['part', 'assembly', 'electrical', 'aftermarket', 'oddjob'] as const;
export type LaborKind = (typeof LABOR_KINDS)[number];

/** 工种人读标签（呈现层用；代码内只用稳定码）。 */
export const LABOR_KIND_LABELS: Readonly<Record<LaborKind, string>> = {
  part: '零件',
  assembly: '装配',
  electrical: '电气',
  aftermarket: '售后',
  oddjob: '零工',
};

/** 工种合法性判定（词汇表门禁；未知词显式拒绝，不静默归类）。 */
export function isLaborKind(value: string): value is LaborKind {
  return (LABOR_KINDS as readonly string[]).includes(value);
}

// ---- 量纲上界（默认配置） ----

/** 时薪上界（分/小时）：(0, 1e9]。 */
export const MAX_RATE_MINOR = 1_000_000_000;

/** 系数上界（乘数，缺省 1）：(0, 1000]。 */
export const MAX_COEFFICIENT = 1_000;

/** 系数缺省（§2 默认配置：系数缺省 1）。 */
export const DEFAULT_COEFFICIENT = 1;

/** 单期净工时上界（小时）：(0, 1e6]（月度口径的防误输上界）。 */
export const MAX_PERIOD_HOURS = 1_000_000;

// ---- 金额换算（内核换算纪律的唯一实现） ----

/**
 * 正数 half-up 取整到分（内核纪律唯一实现；量恒正——hours 净工时可为 0，
 * 0 × rate = 0）。取 floor(x + 0.5) 而非 Math.round：Math.round 对 .5 走
 * "向 +∞ 舍入"，正数域两者等价，但 floor(+0.5) 语义显式且不受负零/负值分支
 * 干扰；量纲恒正，不做负值兜底（负值应在解析层被拒）。
 */
export function roundHalfUp(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PayrollInputError(`换算入参须为有限数：${JSON.stringify(value)}`);
  }
  return Math.floor(value + 0.5);
}

/**
 * 金额 = quantity(小时) × rate(分/小时) × coefficient → half-up 到分。
 * 对账锚点（合同 §7）：同月同规则版本集合下
 * "人×工种金额 = Σ(已审核净工时 × 时薪 × 系数)"与此函数一致。
 */
export function earningsAmountMinor(quantity: number, rateMinor: number, coefficient: number): number {
  return roundHalfUp(quantity * rateMinor * coefficient);
}

// ---- 周期与审核状态 ----

/** 计薪周期口径（v1 锁 month，§8 差异表 #6：week/custom 留形状不实现）。 */
export const PAY_PERIOD_KINDS = ['month', 'week', 'custom'] as const;

/** 月份口径：'YYYY-MM'（与 hours LaborLedgerMonth.month 同形锚）。 */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 月份格式判定。 */
export function isMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** 计薪规则版本行审核状态：发布即 published（版本化主数据）。 */
export const PAYROLL_RULE_AUDIT_STATUS_PUBLISHED = 'published';

/** 核算批次快照审核状态：核算是机械动作，恒 computed（快照可重算）。 */
export const PAYROLL_RUN_AUDIT_STATUS_COMPUTED = 'computed';

/** 薪酬记录审核状态：核算产出事实，恒 computed。 */
export const PAYROLL_EARNINGS_AUDIT_STATUS_COMPUTED = 'computed';

// ---- 权限码（合同 §5 最小集；金额敏感） ----

/**
 * payroll 权限码（登记进 casbin 策略面归组合根/总控；此处冻结词汇）。
 *
 * 金额敏感纪律（对齐 costing 金额可见性先例）：薪酬金额默认仅人事/财务/厂长
 * 角色可见——
 *   - payroll:read        查询（数据权限：本人 vs 全部——"我的工资"走本人，
 *                          全员核算结果走全部；建议默认角色：工人=本人、
 *                          人事/财务/厂长=全部）；
 *   - payroll:rule-manage 时薪维护（86 维护面；建议默认角色：人事/财务）；
 *   - payroll:run         核算/重算（建议默认角色：人事/财务）；
 *   - payroll:export      导出（金额敏感面；建议默认角色：人事/财务/厂长）。
 */
export const PAYROLL_PERMISSIONS = {
  read: 'payroll:read',
  ruleManage: 'payroll:rule-manage',
  run: 'payroll:run',
  export: 'payroll:export',
} as const;

export type PayrollPermission = (typeof PAYROLL_PERMISSIONS)[keyof typeof PAYROLL_PERMISSIONS];
