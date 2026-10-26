/**
 * ReportCenterReportsService —— 报表中心六张报表查询用例（功能补齐第一波：
 * A1/A2/A4/A6/A7——r2/r7/r9/r12/r13）。
 *
 * 与 StandardReportsService 同构（体例照抄 S1 backfill）：口径来自版本化口径
 * 包（REPORT_CENTER_PACK，engine-reporting packs——单一事实源，本类不重述），
 * 求值全部委托引擎纯函数（buildSourceRequest → 源取行 → evaluateMetric）；
 * 差异仅两点：
 *  1. 消费的包 = 报表中心预置口径包（随标准版交付形态；与 smes-machining-
 *     calib 激活价售卖层同源同根、两包各持其版——见 purchase-parts-summary
 *     口径 description 的并存登记）；
 *  2. 查询体多一个查询期 filter（r2 双日期范围/状态多选等由查询层承载）。
 *
 * 事实源经同一 ReportSourceProvider 端口（与标准四张共享源集路由：组合根
 * 在同一 sourceKind→适配器映射里补 report-center 六源绑定即可；缺绑定 =
 * 诚实 503，不静默空结果）。
 */
import type { TenantId } from '@smes/business-core';
import { REPORT_CENTER_PACK } from '@smes/engine-reporting';
import {
  buildSourceRequest,
  evaluateMetric,
  type MetricDefinition,
  type MetricPack,
  type MetricQuery,
  type MetricResult,
} from '@smes/engine-reporting';
import type { MetricCatalogEntry } from './standardreports.service.js';
import { parseReportCenterQueryInput } from './report-center-input.js';
import { StandardReportsNotFoundError } from './standardreports-errors.js';
import {
  UNBOUND_REPORT_SOURCE_PROVIDER,
  type ReportSourceProvider,
} from './standardreports-stores.js';

export class ReportCenterReportsService {
  constructor(
    private readonly pack: MetricPack = REPORT_CENTER_PACK,
    private readonly sources: ReportSourceProvider = UNBOUND_REPORT_SOURCE_PROVIDER,
  ) {}

  /** 包元数据（清单端点回显用——版本演进不破控制器，单一事实源在包本体）。 */
  readonly packId: string = REPORT_CENTER_PACK.packId;
  readonly packVersion: number = REPORT_CENTER_PACK.version;

  /** 包内口径清单（元数据只读视图，形状同标准报表清单）。 */
  listMetrics(): readonly MetricCatalogEntry[] {
    return this.pack.metrics.map((metric) => ({
      metricId: metric.metricId,
      version: metric.version,
      display: metric.display,
      ...(metric.description !== undefined ? { description: metric.description } : {}),
      timeBasis: metric.timeBasis,
      sourceKind: metric.sourceKind,
      dimensionFields: metric.dimensions.map((dimension) => dimension.field),
      measureIds: metric.measures.map((measure) => measure.measureId),
    }));
  }

  /** 求值一张报表：解析引用 → 事实源取行（按租户收口）→ 引擎求值。 */
  async query(tenant: TenantId, input: unknown): Promise<MetricResult> {
    const parsed = parseReportCenterQueryInput(input);
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
        `口径包 '${this.pack.packId}'（v${this.pack.version}）内不存在口径 '${metricId}'——GET /report-center/metrics 查看可引用口径`,
      );
    }
    return metric;
  }
}
