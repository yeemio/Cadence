/**
 * 事实源路由（M3，m3-drafts/04-metric-pack.md §4 事实源绑定）。
 *
 * 六种 sourceKind 的 MetricSource 适配器由 business-store 实现（读各模块事实
 * 表/事件表，只读）、apps/server 组合根绑定——本包与 M2 九模块零代码依赖
 * （ADR-0011）。本文件只提供**按 sourceKind 分发的路由机制**（复用引擎端口
 * 形状，不是粘合）：组合根把六适配器组装成 MetricSourceSet 注入服务层。
 *
 * 缺省空集 = 零接线 boot（装载/清单语义完整；求值遇已装载口径时报
 * "源未绑定"——显式失败优于静默空结果）。
 */
import type { MetricSource, MetricSourceRequest, MetricSourceRow } from '@smes/engine-reporting';
import { MetricPackNotFoundError } from './metric-pack-errors.js';

/** 源集端口：按 sourceKind 取绑定的事实源适配器（未绑定返回 undefined）。 */
export interface MetricSourceSet {
  getSource(sourceKind: string): MetricSource | undefined;
}

/** 缺省空源集（零接线 boot：无任何绑定）。 */
export const EMPTY_METRIC_SOURCE_SET: MetricSourceSet = {
  getSource: () => undefined,
};

/**
 * 组合根装配便利：适配器映射 → 源集（薄封装，键即 sourceKind 词表）。
 * 值为 null 的键视为"已知但未接线"，与缺失同形（undefined）。
 */
export function metricSourceSetOf(
  sources: Readonly<Record<string, MetricSource | null | undefined>>,
): MetricSourceSet {
  return {
    getSource(sourceKind: string): MetricSource | undefined {
      const source = sources[sourceKind];
      return source ?? undefined;
    },
  };
}

/**
 * 引擎单源端口（MetricSource.read 携带 request.sourceKind）的源集适配：
 * 把一个 MetricSourceSet 收敛成引擎 MetricSource——按请求的 sourceKind 分发，
 * 未绑定的 sourceKind 显式抛错（fail-fast：装载包引用未绑定源 = 组合根接线
 * 缺陷，不静默返回空行集）。
 */
export function routingMetricSource(set: MetricSourceSet): MetricSource {
  return {
    async read(request: MetricSourceRequest): Promise<readonly MetricSourceRow[]> {
      const source = set.getSource(request.sourceKind);
      if (source === undefined) {
        throw new MetricPackNotFoundError(
          `事实源 '${request.sourceKind}' 未绑定（MetricSourceSet 无该 sourceKind 适配器）——组合根接线缺陷或包引用未知源`,
        );
      }
      return source.read(request);
    },
  };
}
