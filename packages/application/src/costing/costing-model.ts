/**
 * costing 口径（CostingModel）声明式定义与纯函数（M2-W6，09-costing.md v1.0
 * §2/§8）。
 *
 * 口径 = 数据（决策簿"口径定义即数据、可版本化可售卖"）：类别映射 / 单价来源 /
 * 分摊规则三段声明式定义，随 CostingModel 版本行落库；换口径 = 发新版本
 * （supersedes），不改历史快照。默认配置层（ADR-0010 第三层）：
 *  - 类别映射：v1 固定三类事实源 → 三分类（inventory-movement→材料、
 *    labor-entry→工时、outsourcing-line→外协）；映射集可扩展；
 *  - 单价来源：工时→金额换算 = 工种时薪表（分/小时，整数精确）。R6 边界：
 *    本模块存工时量，金额化在口径层——工时类成本条目不带金额，金额由口径
 *    版本的时薪表在快照层换算；
 *  - 分摊规则：v1 恒 none（人工/制造费用分摊不进范围，合同 §8 裁定）。
 */
import { CostingInputError } from './costing-errors.js';
import { HOURS_TRADES, type HoursTrade } from '../hours/hours-config.js';

/** 成本三分类（合同 §1：材料/工时/外协）。 */
export const COST_CATEGORIES = ['material', 'labor', 'outsourcing'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** 三分类人读标签。 */
export const COST_CATEGORY_LABELS: Readonly<Record<CostCategory, string>> = {
  material: '材料',
  labor: '工时',
  outsourcing: '外协',
};

/** 事实源类型（sourceRef 词汇：来源单据类型）。 */
export const COST_SOURCE_TYPES = ['inventory-movement', 'labor-entry', 'outsourcing-line'] as const;
export type CostSourceType = (typeof COST_SOURCE_TYPES)[number];

/** 工时→金额换算时薪表（分/小时；按工种；缺工种 = 0）。 */
export type HourlyRateTable = Readonly<Partial<Record<HoursTrade, number>>>;

/** 分摊规则声明（v1 仅 none——扩展位，新方法 = 新版本口径）。 */
export interface AllocationRule {
  readonly method: 'none';
}

/** 口径版本的定义段（JSONB 载荷形状；声明式，供重算引擎消费）。 */
export interface CostingModelDefinition {
  /** 类别映射：事实源类型 → 成本三分类（v1 固定映射；扩展源往此加）。 */
  readonly categoryMapping: Readonly<Record<string, CostCategory>>;
  /** 单价来源：工种时薪表（分/小时；工时金额化的唯一口径）。 */
  readonly hourlyRates: HourlyRateTable;
  /** 分摊规则（v1 恒 none）。 */
  readonly allocation: AllocationRule;
}

/** 缺省口径码（v1 标准口径；costing.rebuild 未指定口径时取该码最新 active 版）。 */
export const DEFAULT_COSTING_MODEL_CODE = 'standard';

/** 初版默认口径定义（默认配置层：实施时按客户口径调整，不属内核）。时薪为初版占位值。 */
export const DEFAULT_COSTING_MODEL_DEFINITION: CostingModelDefinition = {
  categoryMapping: {
    'inventory-movement': 'material',
    'labor-entry': 'labor',
    'outsourcing-line': 'outsourcing',
  },
  hourlyRates: {
    machining: 6000,
    assembly: 5000,
    electrical: 6500,
    aftercare: 5500,
    misc: 4000,
  },
  allocation: { method: 'none' },
};

/** 时薪合法性：整数分、[0, 1e9]。 */
export function requireHourlyRate(value: unknown, trade: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new CostingInputError(`hourlyRates.${trade} 须为 [0, 1e9] 内的整数（分/小时）：${JSON.stringify(value)}`);
  }
  return value;
}

/** 时薪表解析（收工种子集；未知工种键 400——防口径与工种枚举漂移）。 */
export function parseHourlyRates(value: unknown): HourlyRateTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CostingInputError(`hourlyRates 必须是对象：${JSON.stringify(value)}`);
  }
  const parsed: Partial<Record<HoursTrade, number>> = {};
  for (const [trade, rate] of Object.entries(value as Record<string, unknown>)) {
    if (!(HOURS_TRADES as readonly string[]).includes(trade)) {
      throw new CostingInputError(`hourlyRates 含未知工种 '${trade}'（合法：${HOURS_TRADES.join('/')}）`);
    }
    parsed[trade as HoursTrade] = requireHourlyRate(rate, trade);
  }
  return parsed;
}

/** 口径定义解析（命令载荷 → 定义段；缺省段取初版默认）。 */
export function parseCostingModelDefinition(input: {
  readonly categoryMapping?: unknown;
  readonly hourlyRates: unknown;
  readonly allocation?: unknown;
}): CostingModelDefinition {
  const definition: CostingModelDefinition = {
    categoryMapping:
      input.categoryMapping === undefined ? DEFAULT_COSTING_MODEL_DEFINITION.categoryMapping : (input.categoryMapping as Record<string, CostCategory>),
    hourlyRates: parseHourlyRates(input.hourlyRates),
    allocation: { method: 'none' },
  };
  if (Object.keys(definition.hourlyRates).length === 0) {
    throw new CostingInputError('hourlyRates 至少提供一个工种的时薪（工时金额化口径不可为空表）');
  }
  return definition;
}

/** 工时→金额（分）：工种时薪 × 工时，按条目取整（Math.round，半取正）。缺工种时薪 = 0。 */
export function laborAmountMinor(definition: CostingModelDefinition, trade: string | null, hours: number): number {
  const rate = trade === null ? undefined : definition.hourlyRates[trade as HoursTrade];
  return Math.round((rate ?? 0) * hours);
}

/** 三分类合计形状（快照 totals 与对比视图共用）。 */
export interface CostTotals {
  readonly materialMinor: number;
  readonly laborMinor: number;
  readonly outsourcingMinor: number;
  readonly grandMinor: number;
  /** 工时量基础（工种→净小时；口径换算的留痕输入）。 */
  readonly laborHoursByTrade: Readonly<Record<string, number>>;
  readonly entryCounts: Readonly<Record<CostCategory, number>>;
}

export const EMPTY_COST_TOTALS: CostTotals = {
  materialMinor: 0,
  laborMinor: 0,
  outsourcingMinor: 0,
  grandMinor: 0,
  laborHoursByTrade: {},
  entryCounts: { material: 0, labor: 0, outsourcing: 0 },
};
