/**
 * 外协计价纯函数（M2-W2 P1；合同 01-baseline.md §7 对账要点：
 * 外协单取价 = 工序单价 × (1 + 利润率)，数值一致）。
 *
 * 精确性取舍（零新增依赖，不引 decimal 库）：
 *  - 单价以**分**为整数单位存储（unitPriceMinor），利润率以**万分比**整数存储
 *    （marginPermyriad，如 1500 = 15%）——全程整数运算，无浮点误差；
 *  - 取价 = round-half-up(unitPriceMinor × (10000 + marginPermyriad) / 10000)，
 *    半位（x.xx5）向上取整，规则确定、可对账；
 *  - 量纲上界（unitPriceMinor ≤ 1e9、marginPermyriad ≤ 1e5）保证中间积
 *    ≤ 1.1e14 < 2^53，整数乘除在 double 内精确。
 */
import { BaselineInputError } from './baseline-errors.js';
import type { StoredMasterStatus, VersionChainEntry } from './baseline-versioning.js';

/** 单价上界（分）：10 亿元级，覆盖机加工外协单价域并留两个量级余量。 */
export const MAX_UNIT_PRICE_MINOR = 1_000_000_000;

/** 利润率上界（万分比）：100000 = 1000%。 */
export const MAX_MARGIN_PERMYRIAD = 100_000;

/** 取价报价（dispatch 外协派工实时取价的载荷形状；金额全整数精确）。 */
export interface OutsourcingPriceQuote {
  /** 计价规则业务码。 */
  readonly ruleCode: string;
  /** 工序业务码（规则的比对键）。 */
  readonly processCode: string;
  readonly unitPriceMinor: number;
  readonly marginPermyriad: number;
  /** 取价结果（分，half-up 到分；不存在厘厘位）。 */
  readonly priceMinor: number;
  /** 展示用十进制串（'12.50' / '14.38'，与 minor 恒等值）。 */
  readonly unitPrice: string;
  readonly price: string;
}

/** 计价规则的最小取价形状（规则行子集即可参与取价）。 */
export interface OutsourcingPricePricedRule extends VersionChainEntry {
  readonly code: string;
  readonly processCode: string;
  readonly unitPriceMinor: number;
  readonly marginPermyriad: number;
  readonly status: StoredMasterStatus;
}

/** 分 → 十进制串（纯整数换算，无浮点参与）。 */
export function minorToDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new BaselineInputError(`金额（分）须为非负整数：${String(minor)}`);
  }
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/**
 * 十进制单价串 → 分（输入解析锚点；'12.5'/'12.50' 合法，'12.505' 拒绝——
 * 计价域只认到分，避免高于分的输入静默截断）。
 */
export function decimalToMinor(input: string, field: string): number {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(input)) {
    throw new BaselineInputError(
      `${field} '${input}' 非法：须为非负十进制金额串（整数 ≤9 位、小数 ≤2 位），如 '12.50'`,
    );
  }
  const [whole, fraction = ''] = input.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
  if (minor <= 0 || minor > MAX_UNIT_PRICE_MINOR) {
    throw new BaselineInputError(`${field} '${input}' 超出取值域（0 < 单价 ≤ ${minorToDecimal(MAX_UNIT_PRICE_MINOR)}）`);
  }
  return minor;
}

/** 利润率载荷解析（万分比整数，0 ~ MAX_MARGIN_PERMYRIAD）。 */
export function parseMarginPermyriad(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MARGIN_PERMYRIAD) {
    throw new BaselineInputError(
      `${field} ${JSON.stringify(value)} 非法：须为 0~${MAX_MARGIN_PERMYRIAD} 的整数（万分比，1500=15%）`,
    );
  }
  return value;
}

/** 取价核心（纯函数）：half-up 到分。量纲上界内整数精确（见文件头）。 */
export function computeOutsourcingPriceMinor(unitPriceMinor: number, marginPermyriad: number): number {
  if (!Number.isInteger(unitPriceMinor) || unitPriceMinor <= 0 || unitPriceMinor > MAX_UNIT_PRICE_MINOR) {
    throw new BaselineInputError(`unitPriceMinor ${String(unitPriceMinor)} 非法（量纲上界内正整数）`);
  }
  if (!Number.isInteger(marginPermyriad) || marginPermyriad < 0 || marginPermyriad > MAX_MARGIN_PERMYRIAD) {
    throw new BaselineInputError(`marginPermyriad ${String(marginPermyriad)} 非法（0~${MAX_MARGIN_PERMYRIAD}）`);
  }
  const scaled = unitPriceMinor * (10_000 + marginPermyriad);
  return Math.floor((scaled + 5_000) / 10_000);
}

/** 规则 → 报价（纯函数组合；对账锚点：price = unit × (1+margin)）。 */
export function quoteOutsourcingRule(rule: OutsourcingPricePricedRule): OutsourcingPriceQuote {
  const priceMinor = computeOutsourcingPriceMinor(rule.unitPriceMinor, rule.marginPermyriad);
  return {
    ruleCode: rule.code,
    processCode: rule.processCode,
    unitPriceMinor: rule.unitPriceMinor,
    marginPermyriad: rule.marginPermyriad,
    priceMinor,
    unitPrice: minorToDecimal(rule.unitPriceMinor),
    price: minorToDecimal(priceMinor),
  };
}

/**
 * 从规则全集选出某工序的取价规则（纯函数；dispatch 实时取价的选规口径）：
 *  - 只认 active 且未被取代的当前版；
 *  - 多条命中时取版本号最大者，平版本按业务码字典序取首（确定性）。
 */
export function pickActiveRuleForProcess<T extends OutsourcingPricePricedRule>(
  rules: readonly T[],
  processCode: string,
  isSuperseded: (entry: VersionChainEntry, chain: readonly VersionChainEntry[]) => boolean,
): T | null {
  const chain: readonly VersionChainEntry[] = rules;
  let best: T | null = null;
  for (const rule of rules) {
    if (rule.processCode !== processCode) continue;
    if (rule.status !== 'active') continue;
    if (isSuperseded(rule, chain)) continue;
    if (
      best === null ||
      rule.objectVersion > best.objectVersion ||
      (rule.objectVersion === best.objectVersion && rule.code.localeCompare(best.code) < 0)
    ) {
      best = rule;
    }
  }
  return best;
}
