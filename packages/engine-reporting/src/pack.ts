/**
 * 口径包（MetricPack）：可售卖单元的可序列化载体（决策簿："口径包=商业资产"）。
 *
 * 包 = 包标识 + 包版本 + 口径清单 + 包元数据；口径定义经 defineMetricDefinition
 * 逐条校验冻结。包内 metricId 唯一——同一口径的演进走**包版本**更替
 * （pack v1 携 metric X v1，pack v2 携 metric X v2），不在包内并存同 id 双版本。
 */
import { deepFreeze } from './internal/freeze.js';
import { isPlainObject } from './internal/checks.js';
import { defineMetricDefinition, type MetricDefinition } from './definition.js';

export const METRIC_PACK_SCHEMA_VERSION = 1 as const;
export type MetricPackSchemaVersion = typeof METRIC_PACK_SCHEMA_VERSION;

export interface MetricPack {
  readonly schemaVersion: MetricPackSchemaVersion;
  /** kebab-case，包的唯一标识（售卖/装载按此寻址） */
  readonly packId: string;
  /** 包版本，整数 >= 1（口径演进 = 发新包版本） */
  readonly version: number;
  readonly title: string;
  readonly description?: string;
  readonly metrics: readonly MetricDefinition[];
}

const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 校验并固化一份口径包：逐条口径重新校验（不信任入口形状），包内 metricId 唯一。
 * 幂等：已冻结的合法包再次输入，产出等价冻结结果（跨版本不可变性测试）。
 */
export function defineMetricPack(raw: unknown): MetricPack {
  if (!isPlainObject(raw)) {
    throw new Error('invalid metric pack: expected a plain object');
  }
  const { schemaVersion, packId, version, title, description, metrics } = raw;

  if (schemaVersion !== METRIC_PACK_SCHEMA_VERSION) {
    throw new Error(`invalid schemaVersion: expected ${String(METRIC_PACK_SCHEMA_VERSION)}, got ${String(schemaVersion)}`);
  }
  if (typeof packId !== 'string' || !KEBAB_PATTERN.test(packId) || packId.length > 64) {
    throw new Error(`invalid packId: expected kebab-case (max 64 chars), got "${String(packId)}"`);
  }
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error(`invalid version: expected an integer >= 1, got ${String(version)}`);
  }
  if (typeof title !== 'string' || title.length === 0 || title.length > 128) {
    throw new Error(`invalid title: expected a non-empty string (max 128 chars), got "${String(title)}"`);
  }
  if (description !== undefined && (typeof description !== 'string' || description.length === 0 || description.length > 2000)) {
    throw new Error('invalid description: expected a non-empty string (max 2000 chars)');
  }
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new Error('invalid metrics: expected a non-empty array of metric definitions');
  }

  const normalized = metrics.map((metric) => defineMetricDefinition(metric));
  const seen = new Set<string>();
  for (const metric of normalized) {
    if (seen.has(metric.metricId)) {
      throw new Error(`invalid metric pack "${String(packId)}": duplicate metricId "${metric.metricId}"`);
    }
    seen.add(metric.metricId);
  }

  return deepFreeze<MetricPack>({
    schemaVersion: schemaVersion as MetricPackSchemaVersion,
    packId: packId as string,
    version: version as number,
    title: title as string,
    ...(description !== undefined ? { description: description as string } : {}),
    metrics: Object.freeze(normalized) as readonly MetricDefinition[],
  });
}

/** 按口径引用（metricId + version）在包内取定义；未命中返回 undefined。 */
export function findMetric(pack: MetricPack, metricId: string, version: number): MetricDefinition | undefined {
  return pack.metrics.find((metric) => metric.metricId === metricId && metric.version === version);
}
