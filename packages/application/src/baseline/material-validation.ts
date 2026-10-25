/**
 * 物料校验确定性引擎（M2-W2 P1；合同 01-baseline.md §7：对清单行输出
 * 匹配/疑似/未匹配 判定；匹配算法口径是对账阶段以行为反推校准的 open question，
 * 本实现取**确定性规则**：编码精确 + 规格归一化比对，阈值可注入——不做模糊权重）。
 *
 * 比对基准 = masterdata 物品库（core 模块间端口 ItemStore，ADR-0011：模块间只经端口互调）。
 *
 * 判定规则（确定性、无权重、阈值注入）：
 *  1. 编码精确命中物品库（租户内 code 唯一 → 至多一件）：
 *     - 双方规格皆空           → 相似度 1.0 → 匹配（matched，basis=code-exact）；
 *     - 仅一方有规格           → 相似度 0   → 疑似（suspected：编码对、规格缺证，转人工）；
 *     - 双方有规格             → 归一化 Dice 二元组相似度 sim：
 *         sim >= specMatchThreshold → 匹配；否则 → 疑似（候选=该物品）。
 *  2. 编码未命中：按名称归一化精确等值筛候选；无候选 → 未匹配（unmatched）。
 *     有候选则取规格相似度最高者：sim >= suspectThreshold → 疑似
 *     （basis=name-and-spec，候选=最优物品）；否则 → 未匹配。
 *
 * 规格归一化：NFKC（全角→半角）→ 小写 → 乘号统一（× 与 * → x）→ 去全部空白。
 * 例："45＊50×60 " → "45x50x60"，与 "45*50x60" 等值。
 */
import type { ItemMaster } from '../masterdata/masterdata-stores.js';

/** 三分判定（合同词汇）。 */
export type MaterialJudgment = 'matched' | 'suspected' | 'unmatched';

/** 判定依据（对账阶段反推口径的证据列）。 */
export type MaterialJudgmentBasis = 'code-exact' | 'name-and-spec' | 'none';

/** 阈值注入形状（0 <= suspectThreshold <= specMatchThreshold <= 1）。 */
export interface MaterialValidationThresholds {
  /** 编码命中路径的匹配门槛（规格归一化相似度 ≥ 此值判 matched）。 */
  readonly specMatchThreshold: number;
  /** 编码未命中路径的疑似门槛（名称候选中规格相似度 ≥ 此值判 suspected）。 */
  readonly suspectThreshold: number;
}

/** 缺省阈值（对账阶段按活系统行为校准，合同 open question 有记载）。 */
export const DEFAULT_MATERIAL_VALIDATION_THRESHOLDS: MaterialValidationThresholds = {
  specMatchThreshold: 0.9,
  suspectThreshold: 0.7,
};

/** 校验输入行（清单行的物料三要素，至少一项非空——由输入解析保证）。 */
export interface MaterialValidationLine {
  readonly code: string | null;
  readonly name: string | null;
  readonly spec: string | null;
}

/** 单行判定结果（落库与事件的载荷形状）。 */
export interface MaterialLineJudgment extends MaterialValidationLine {
  /** 行号（1 起，载荷内顺序标识）。 */
  readonly lineNo: number;
  readonly judgment: MaterialJudgment;
  /** 候选物品 id / code（matched/suspected 携带，unmatched 为 null）。 */
  readonly candidateItemId: string | null;
  readonly candidateItemCode: string | null;
  /** 规格归一化相似度 0~1（无候选时 0）；判定证据，供对账与阈值校准。 */
  readonly similarity: number;
  readonly basis: MaterialJudgmentBasis;
}

/** 判定汇总计数。 */
export interface MaterialValidationSummary {
  readonly total: number;
  readonly matched: number;
  readonly suspected: number;
  readonly unmatched: number;
}

/** 规格归一化（确定性：NFKC + 小写 + 乘号统一 + 去空白）。 */
export function normalizeSpec(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '');
}

/** 名称归一化（NFKC + 小写 + 压缩空白；保留词间距以降低误配）。 */
export function normalizeName(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Dice 二元组相似度（确定性，无权重）：两串公共二元组数×2 / 两串二元组总数。
 * 双空 → 1（无差异可争）；单空 → 0；单字符串退化为等值比较。
 */
export function bigramDiceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length < 2 || b.length < 2) return 0; // 长度不等（a===b 已排除）且至少一串无二元组
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      counts.set(gram, left - 1);
      common += 1;
    }
  }
  return (2 * common) / (a.length - 1 + b.length - 1);
}

function specSimilarity(lineSpec: string | null, itemSpec: string | null): number {
  const left = lineSpec === null || lineSpec.trim().length === 0 ? null : normalizeSpec(lineSpec);
  const right = itemSpec === null || itemSpec.trim().length === 0 ? null : normalizeSpec(itemSpec);
  if (left === null && right === null) return 1;
  if (left === null || right === null) return 0;
  return bigramDiceSimilarity(left, right);
}

/** 单行判定（纯函数：同输入同输出，行为测试与对账测试的锚点）。 */
export function judgeMaterialLine(
  line: MaterialValidationLine,
  items: readonly ItemMaster[],
  thresholds: MaterialValidationThresholds = DEFAULT_MATERIAL_VALIDATION_THRESHOLDS,
): MaterialLineJudgment {
  const base = {
    code: line.code,
    name: line.name,
    spec: line.spec,
  };

  // 1) 编码精确
  if (line.code !== null && line.code.trim().length > 0) {
    const exact = items.find((item) => item.code === line.code);
    if (exact !== undefined) {
      const similarity = specSimilarity(line.spec, exact.spec);
      const judgment: MaterialJudgment = similarity >= thresholds.specMatchThreshold ? 'matched' : 'suspected';
      return {
        ...base,
        lineNo: 0, // 由调用方（validateMaterialLines）回填
        judgment,
        candidateItemId: exact.id,
        candidateItemCode: exact.code,
        similarity,
        basis: 'code-exact',
      };
    }
  }

  // 2) 名称等值候选 + 规格相似度
  if (line.name !== null && line.name.trim().length > 0) {
    const wanted = normalizeName(line.name);
    const candidates = items.filter((item) => normalizeName(item.name) === wanted);
    if (candidates.length > 0) {
      let best = candidates[0]!;
      let bestSim = specSimilarity(line.spec, best.spec);
      for (const candidate of candidates.slice(1)) {
        const sim = specSimilarity(line.spec, candidate.spec);
        if (sim > bestSim) {
          best = candidate;
          bestSim = sim;
        }
      }
      if (bestSim >= thresholds.suspectThreshold) {
        return {
          ...base,
          lineNo: 0,
          judgment: 'suspected',
          candidateItemId: best.id,
          candidateItemCode: best.code,
          similarity: bestSim,
          basis: 'name-and-spec',
        };
      }
      return { ...base, lineNo: 0, judgment: 'unmatched', candidateItemId: null, candidateItemCode: null, similarity: bestSim, basis: 'none' };
    }
  }

  // 3) 未匹配
  return { ...base, lineNo: 0, judgment: 'unmatched', candidateItemId: null, candidateItemCode: null, similarity: 0, basis: 'none' };
}

/** 整单执行：行号回填 + 汇总（纯函数）。 */
export function validateMaterialLines(
  lines: readonly MaterialValidationLine[],
  items: readonly ItemMaster[],
  thresholds: MaterialValidationThresholds = DEFAULT_MATERIAL_VALIDATION_THRESHOLDS,
): { readonly judgments: readonly MaterialLineJudgment[]; readonly summary: MaterialValidationSummary } {
  const judgments = lines.map((line, index) => ({ ...judgeMaterialLine(line, items, thresholds), lineNo: index + 1 }));
  const summary: MaterialValidationSummary = {
    total: judgments.length,
    matched: judgments.filter((row) => row.judgment === 'matched').length,
    suspected: judgments.filter((row) => row.judgment === 'suspected').length,
    unmatched: judgments.filter((row) => row.judgment === 'unmatched').length,
  };
  return { judgments, summary };
}
