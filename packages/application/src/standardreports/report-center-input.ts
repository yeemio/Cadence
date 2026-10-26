/**
 * 报表中心查询入参解析（功能补齐第一波：A1/A2/A4/A6/A7——r2/r7/r9/r12/r13）。
 *
 * POST /report-center/query 请求体形状：在标准报表查询体（metricId/version/
 * from/to/timeBasis/dimensionSlice，见 standardreports-input.ts）之上追加
 * **查询期过滤 filter**（engine-reporting MetricFilter 纯数据谓词，与口径根
 * 过滤 AND——引擎合同保证口径内不变量不因查询过滤漂移）。
 *
 * 为什么 report-center 面需要 filter 而标准四张不需要：r2 工作令交付的
 * 「双日期范围」语义（计划/实际交付范围独立、成对才生效、可只填一侧）由
 * 查询层承载（口径 description 冻结原文）——落地为对 planDeliveryDate/
 * actualDeliveryDate 维度的 range 谓词与状态 in-set；r8/r7 呈现层筛选同走
 * 该面。谓词形状经引擎 validateMetricFilter 校验（结构非法抛 400 可映射的
 * StandardReportsInputError——复用既有错误类，组合根 backfill-error.filter
 * 零改动）。
 */
import type { MetricFilter, MetricQuery } from '@smes/engine-reporting';
import { validateMetricFilter } from '@smes/engine-reporting';
import { parseReportQueryInput } from './standardreports-input.js';
import { StandardReportsInputError } from './standardreports-errors.js';

/** 解析报表中心查询体（比标准查询体多一个可选 filter）。 */
export function parseReportCenterQueryInput(input: unknown): Omit<MetricQuery, 'version'> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new StandardReportsInputError(`报表中心查询请求体必须是对象：${JSON.stringify(input)}`);
  }
  const record = input as Record<string, unknown>;

  // 基础字段（metricId/version/from/to/timeBasis/dimensionSlice）复用标准查询
  // 解析：先摘掉 filter 再原样传入——标准解析器对未知字段宽容、只校验已知
  // 字段形状，摘除后两面校验语义等价、单一事实源不漂移。
  const rest: Record<string, unknown> = { ...record };
  delete rest['filter'];
  const base = parseReportQueryInput(rest);

  const filterRaw = record['filter'];
  if (filterRaw === undefined) {
    return base;
  }
  let filter: MetricFilter;
  try {
    filter = validateMetricFilter(filterRaw);
  } catch (error) {
    throw new StandardReportsInputError(
      `字段 'filter' 须为合法过滤谓词（compare/in-set/range/and/or/not）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { ...base, filter };
}
