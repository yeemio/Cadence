/**
 * StandardReportsService —— 标准报表查询用例（S1 backfill：0920 #89/#91/#92/#96）。
 *
 * 零框架业务类：口径来自版本化口径包（STANDARD_REPORTS_PACK，纯数据），
 * 求值全部委托 engine-reporting 纯函数（buildSourceRequest → 源取行 →
 * evaluateMetric——正确性归属引擎，本类只做引用解析与端口接线）。
 * 不做通用 BI：无自定义口径上传、无表达式聚合——查询入参 = 口径引用 +
 * 时间窗 + 维度切片（合同：报表 = 口径定义 + 查询端点）。
 */
import type { TenantId } from '@smes/business-core';
import {
  buildSourceRequest,
  evaluateMetric,
  type MetricDefinition,
  type MetricPack,
  type MetricQuery,
  type MetricResult,
} from '@smes/engine-reporting';
import { STANDARD_REPORTS_PACK } from './standard-reports-pack.js';
import { StandardReportsNotFoundError } from './standardreports-errors.js';
import { parseReportQueryInput } from './standardreports-input.js';
import {
  UNBOUND_REPORT_SOURCE_PROVIDER,
  type ReportSourceProvider,
} from './standardreports-stores.js';

/** 口径清单视图（GET /standard-reports/metrics 出参——含降级标注文本）。 */
export interface MetricCatalogEntry {
  readonly metricId: string;
  readonly version: number;
  readonly display: string;
  readonly description?: string;
  readonly timeBasis: string;
  readonly sourceKind: string;
  readonly dimensionFields: readonly string[];
  readonly measureIds: readonly string[];
}

export class StandardReportsService {
  constructor(
    private readonly pack: MetricPack = STANDARD_REPORTS_PACK,
    private readonly sources: ReportSourceProvider = UNBOUND_REPORT_SOURCE_PROVIDER,
  ) {}

  /** 包内口径清单（元数据只读视图）。 */
  listMetrics(): readonly MetricCatalogEntry[] {
    return this.pack.metrics.map(toCatalogEntry);
  }

  /**
   * 求值一张报表：解析引用（metricId 必填，version 缺省 = 包内当前版本）→
   * 事实源取行（按租户收口）→ 引擎求值（谓词重复施加，下推只是优化）。
   */
  async query(tenant: TenantId, input: unknown): Promise<MetricResult> {
    const parsed = parseReportQueryInput(input);
    const metric = this.resolveMetric(parsed.metricId);
    const query: MetricQuery = { ...parsed, version: metric.version };
    const source = this.sources.forTenant(tenant);
    const rows = await source.read(buildSourceRequest(metric, query));
    return evaluateMetric(metric, query, rows);
  }

  private resolveMetric(metricId: string): MetricDefinition {
    const metric = this.pack.metrics.find((candidate) => candidate.metricId === metricId);
    if (metric === undefined) {
      throw new StandardReportsNotFoundError(
        `口径包 '${this.pack.packId}'（v${this.pack.version}）内不存在口径 '${metricId}'——GET /standard-reports/metrics 查看可引用口径`,
      );
    }
    return metric;
  }
}

function toCatalogEntry(metric: MetricDefinition): MetricCatalogEntry {
  return {
    metricId: metric.metricId,
    version: metric.version,
    display: metric.display,
    ...(metric.description !== undefined ? { description: metric.description } : {}),
    timeBasis: metric.timeBasis,
    sourceKind: metric.sourceKind,
    dimensionFields: metric.dimensions.map((dimension) => dimension.field),
    measureIds: metric.measures.map((measure) => measure.measureId),
  };
}
