/**
 * 标准报表薄数据层（S3-a：0920 #89/#91/#92/#96 查询页；实态见
 * standardreports.controllers.ts + engine-reporting MetricResult）。
 *
 *  - GET  /standard-reports/metrics → 口径清单（packId/version + 四 metric 元数据）
 *  - POST /standard-reports/query    → MetricResult（自描述：口径溯源 metric
 *    {metricId,version} + dimensionFields + measureIds + rows[{key, values}]）
 *
 * 列依赖取舍（写明）：web 不得 import 后端口径包（web-via-ui 铁律），而
 * MetricResult 已自带维度字段与度量 id 清单——**列结构按响应实态动态生成**，
 * 仅列头中文标签用页面内静态副本（与 STANDARD_REPORTS_PACK v1 对齐；未知
 * id 回退原样显示，包版本演进不破页面）。
 */
import { request } from './apiClient';

/** 口径清单条目（GET /standard-reports/metrics 的 metrics[] 形状）。 */
export interface MetricCatalogEntryView {
  readonly metricId: string;
  readonly version: number;
  readonly display: string;
  readonly description: string | null;
  readonly timeBasis: string;
  readonly sourceKind: string;
  readonly dimensionFields: readonly string[];
  readonly measureIds: readonly string[];
}

export interface MetricCatalogView {
  readonly packId: string;
  readonly version: number;
  readonly metrics: readonly MetricCatalogEntryView[];
}

/** 求值结果（engine-reporting MetricResult 的页面视图；数值度量可为 null）。 */
export interface MetricResultView {
  readonly metricId: string;
  readonly metricVersion: number;
  readonly timeBasis: string;
  readonly window: { readonly from?: string | undefined; readonly to?: string | undefined };
  readonly dimensionFields: readonly string[];
  readonly measureIds: readonly string[];
  readonly rows: readonly {
    readonly key: Readonly<Record<string, unknown>>;
    readonly values: Readonly<Record<string, number | null>>;
  }[];
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what}形状非法`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${what}须为字符串数组`);
  }
  return value as readonly string[];
}

function parseCatalogEntry(input: unknown): MetricCatalogEntryView {
  const record = asObject(input, '口径清单条目');
  const description = record['description'];
  return {
    metricId: String(record['metricId']),
    version: Number(record['version']),
    display: String(record['display']),
    description: typeof description === 'string' ? description : null,
    timeBasis: String(record['timeBasis']),
    sourceKind: String(record['sourceKind']),
    dimensionFields: asStringArray(record['dimensionFields'], '口径维度字段'),
    measureIds: asStringArray(record['measureIds'], '口径度量清单'),
  };
}

/** 口径清单（report:read 门禁；四张标准报表的元数据）。 */
export async function listStandardReportMetrics(): Promise<MetricCatalogView> {
  const body = asObject(await request('/standard-reports/metrics'), '口径清单响应');
  const metrics = body['metrics'];
  if (!Array.isArray(metrics)) {
    throw new Error("口径清单响应缺 'metrics' 数组");
  }
  return {
    packId: String(body['packId']),
    version: Number(body['version']),
    metrics: metrics.map(parseCatalogEntry),
  };
}

/** 报表求值入参（metricId 必填；from/to 为 ISO 时刻，含端点，可选）。 */
export interface StandardReportQueryInput {
  readonly metricId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** 求值一张报表（POST /standard-reports/query；响应自描述行列）。 */
export async function queryStandardReport(
  input: StandardReportQueryInput,
): Promise<MetricResultView> {
  const payload: Record<string, unknown> = { metricId: input.metricId };
  if (input.from !== undefined && input.from.length > 0) payload.from = input.from;
  if (input.to !== undefined && input.to.length > 0) payload.to = input.to;
  const body = asObject(
    await request('/standard-reports/query', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    '报表求值响应',
  );
  const metric = asObject(body['metric'], '口径溯源');
  const window = asObject(body['window'], '时间窗');
  const rows = body['rows'];
  if (!Array.isArray(rows)) {
    throw new Error("报表求值响应缺 'rows' 数组");
  }
  return {
    metricId: String(metric['metricId']),
    metricVersion: Number(metric['version']),
    timeBasis: String(body['timeBasis']),
    window: {
      ...(typeof window['from'] === 'string' ? { from: window['from'] } : {}),
      ...(typeof window['to'] === 'string' ? { to: window['to'] } : {}),
    },
    dimensionFields: asStringArray(body['dimensionFields'], '结果维度字段'),
    measureIds: asStringArray(body['measureIds'], '结果度量清单'),
    rows: rows.map((row) => {
      const record = asObject(row, '结果行');
      const rawValues = asObject(record['values'], '结果行度量值');
      const values: Record<string, number | null> = {};
      for (const [measureId, value] of Object.entries(rawValues)) {
        values[measureId] = typeof value === 'number' ? value : null;
      }
      return {
        key: asObject(record['key'], '结果行维度键'),
        values,
      };
    }),
  };
}
