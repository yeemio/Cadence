/**
 * 报表事实源端口（S1 backfill）：按租户解析 engine-reporting 的 MetricSource。
 *
 * 引擎 MetricSource 端口不带租户参数（engine-reporting 包形状冻结，不改它），
 * 租户收口走"组合根按请求租户构造并缓存实例"的既有先例（metric-pack 的
 * metricPackSourceSetFor 同构，main.ts 接线）。本文件提供：
 *  - ReportSourceProvider 端口（forTenant(tenant) → MetricSource）；
 *  - reportSourceProviderOf：sourceKind → 适配器映射 → 单一 MetricSource 的
 *    路由封装（同 metric-pack routingMetricSource 形态，本包不 import 专业包——
 *    ADR-0011：application 只依赖 business-core + engine-*）；
 *  - 缺省 UNBOUND 形态：零 DB boot 时求值显式抛"源未绑定"（503）——口径在、
 *    数据面缺，不静默返回空结果（空结果会被误读为"无数据"）。
 */
import type { MetricSource, MetricSourceRequest, MetricSourceRow } from '@smes/engine-reporting';
import type { TenantId } from '@smes/business-core';
import { StandardReportsSourceError } from './standardreports-errors.js';

/** 按租户解析报表事实源（组合根注入；租户收口 = 构造注入闭包）。 */
export interface ReportSourceProvider {
  forTenant(tenant: TenantId): MetricSource;
}

const UNBOUND_MESSAGE =
  "标准报表事实源未绑定（需 DATABASE_URL 的 PG 形态接线；当前为零 DB 形态——口径装载完整，数据面不可用）";

/** 缺省未绑定源集（零 DB boot：诚实失败，不静默空结果）。 */
export const UNBOUND_REPORT_SOURCE_PROVIDER: ReportSourceProvider = {
  forTenant: (): MetricSource => ({
    async read(): Promise<readonly MetricSourceRow[]> {
      throw new StandardReportsSourceError(UNBOUND_MESSAGE);
    },
  }),
};

/**
 * 组合根装配便利：sourceKind → 适配器映射 → ReportSourceProvider。
 * 值为 null/undefined 的键视为"已知但未接线"——读取时按未绑定显式抛错。
 */
export function reportSourceProviderOf(
  sources: Readonly<Record<string, MetricSource | null | undefined>>,
): ReportSourceProvider {
  return {
    forTenant: (): MetricSource => ({
      async read(request: MetricSourceRequest): Promise<readonly MetricSourceRow[]> {
        const source = sources[request.sourceKind] ?? undefined;
        if (source === undefined) {
          throw new StandardReportsSourceError(
            `事实源 '${request.sourceKind}' 未绑定（标准报表源集无该 sourceKind 适配器）——组合根接线缺陷或口径引用未知源`,
          );
        }
        return source.read(request);
      },
    }),
  };
}
