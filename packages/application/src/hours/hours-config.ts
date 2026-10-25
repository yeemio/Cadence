/**
 * hours 默认配置层（M2-W6，08-hours.md v1.0 §2 分层标注第三层）。
 *
 * 工种枚举与"报工类别 → 工种"映射是**默认配置**（初版口径，实施时按客户口径
 * 调整，不属内核——ADR-0010）；账本不可变纪律与冲销语义在内核（服务层与存储
 * 端口合同），不在本文件。设计/外包两口径来源无派工单载体（合同 §8 open
 * question），v1 不入账——录入面待对账阶段确认活系统行为后另定。
 */
import { HoursInputError } from './hours-errors.js';

/** 工种（五类；机加工时统计取 machining）。 */
export const HOURS_TRADES = ['machining', 'assembly', 'electrical', 'aftercare', 'misc'] as const;
export type HoursTrade = (typeof HOURS_TRADES)[number];

/** 工种人读标签（呈现层用；代码内只用稳定码）。 */
export const HOURS_TRADE_LABELS: Readonly<Record<HoursTrade, string>> = {
  machining: '机加',
  assembly: '装配',
  electrical: '电气',
  aftercare: '售后',
  misc: '零工',
};

/**
 * 报工类别（reporting 五类 WorkReport kind 的稳定码镜像；结构化消费，不 import
 * 其 WIP 文件）。词汇表与 reporting REPORT_KINDS 一一对应（M2 Wave-4 验收中危
 * #2 修复：旧词 after-sales/misc 已迁移为 aftermarket/oddjob，本仓零 commit 无
 * 历史数据负担，存储与查询不承载报工类别词——入账即映射为工种）。
 */
export const REPORT_KINDS = ['part', 'assembly', 'electrical', 'aftermarket', 'oddjob'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** 报工类别合法性判定（联动入账的词汇表门禁；未知类别显式拒绝，不静默归类）。 */
export function isReportKind(value: string): value is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(value);
}

/**
 * 报工类别 → 工种 初版映射（默认配置层）。零件报工（自制加工）归机加工种；
 * 售后报工（aftermarket）归售后工种；零工报工（oddjob）归零工工种。实施时按
 * 客户口径调整映射值即可，不改代码结构。
 */
export const REPORT_KIND_TO_TRADE: Readonly<Record<ReportKind, HoursTrade>> = {
  part: 'machining',
  assembly: 'assembly',
  electrical: 'electrical',
  aftermarket: 'aftercare',
  oddjob: 'misc',
};

/** 工时账目审核状态：条目只从 verified 报工联动产生，恒 verified（无人工审核环节）。 */
export const HOURS_AUDIT_STATUS_VERIFIED = 'verified';

/** 月度归集快照审核状态：重算是机械动作，恒 rebuilt（快照可重算，ADR-0010）。 */
export const HOURS_MONTH_AUDIT_STATUS_REBUILT = 'rebuilt';

/** 工时上界（小时；单条报工联动条目的合法量纲上界，(0, 1e4]。 */
export const MAX_HOURS_PER_ENTRY = 10_000;

/**
 * 报工分钟上界（与 reporting MAX_LABOR_MINUTES 同口径：1440×31——单次报工上限
 * 一个月分钟数，防误输）。minutesToHours 的入参合法域上界。
 */
export const MAX_REPORT_MINUTES = 44_640;

/**
 * 分钟 → 小时换算（纯函数；接线适配器消费——reporting 事件载荷工时是整数分钟
 * laborMinutes，本账本量纲是小时）。返回浮点数（90 → 1.5），不四舍五入；入参
 * 须为 (0, MAX_REPORT_MINUTES] 内的有限数，越界抛 HoursInputError（不静默产出
 * 量纲漂移值）。
 */
export function minutesToHours(minutes: number): number {
  if (
    typeof minutes !== 'number' ||
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    minutes > MAX_REPORT_MINUTES
  ) {
    throw new HoursInputError(`minutes 须为 (0, ${MAX_REPORT_MINUTES}] 内的数：${JSON.stringify(minutes)}`);
  }
  return minutes / 60;
}

/** 月份口径：'YYYY-MM'。 */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 业务日期口径：'YYYY-MM-DD'。 */
export const WORK_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 月份格式判定 + 规范化（trim）。 */
export function isMonth(value: string): value is string {
  return MONTH_PATTERN.test(value);
}

/** 条目月份归属（业务日期 → 'YYYY-MM'）。 */
export function monthOfDate(workDate: string): string {
  return workDate.slice(0, 7);
}
