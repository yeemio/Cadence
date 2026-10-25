/**
 * baseline 跨模块端口（M2-W7 P2/P3 件，合同 01-baseline.md §4）。
 *
 * 只定义接口与缺省空实现（模块间互调一律经 application 层端口，ADR-0011 /
 * 通用合同纪律 6；兄弟模块/组合根合流时 import 接口即可互调）。三个方向：
 *  - 被依赖（Out）：StandardTimeLookup——hours 额定工时对标的取数端口，
 *    BaselineService 实现该接口（hours 线并行实施按此形状镜像消费）；
 *  - 依赖（In）：WorkOrderDrawingSource——workorder 附件图纸计数事实（下图
 *    统计数据源，合同 §4 依赖（M2））；本模块只透出事实，口径归 engine-reporting
 *    （合同 §8）。缺省空实现 = 未接线时事实查询返回空集（零接线 boot 语义完整）；
 *  - IM（Out）：复用 inspection-ports 的 NotifyChannel 单一定义（application
 *    包内唯一 IM 端口形状；缺省 no-op，由 integration-im / 组合根接线）。
 *
 * 待办联动复用 workbench TodoStore（module 注入，与 WorkbenchModule 同实例）。
 * 端口方法一律异步（PG 实现天然异步）。全部按租户收口。
 */
import type { TenantId } from '@smes/business-core';
import type { StandardTimeScope } from './baseline-stores.js';

// ---- 额定工时对标端口（baseline → hours，合同 §4 被依赖） ----

/** 额定工时对标快照（hours 额定 vs 实际对标的取数形状；工时量纲 = 秒整数）。 */
export interface StandardTimeBenchmark {
  /** 额定工时业务码。 */
  readonly standardTimeCode: string;
  /** 对标维度：process=按工序 / product=按产品（图号）。 */
  readonly scope: StandardTimeScope;
  /** 对标目标业务码（工序码或产品图号）。 */
  readonly targetCode: string;
  /** 每件标准工时（秒，整数精确）。 */
  readonly standardSeconds: number;
  /** 每批/每任务预备工时额度（秒，整数精确）。 */
  readonly preparationSeconds: number;
}

/**
 * hours 额定工时对标端口：按工序/产品取 active 当前版额定工时。
 * BaselineService 实现本接口；无可用（active 且未被取代）行 → 抛
 * BaselineNotFoundError（404 语义，与 OutsourcingPriceLookup.resolve 同口径；
 * 方法名独立成词——本服务已实现取价端口的 resolve，避免同名双实现）。
 */
export interface StandardTimeLookup {
  resolveStandardTime(tenant: TenantId, scope: StandardTimeScope, targetCode: string): Promise<StandardTimeBenchmark>;
}

// ---- 工作令附件图纸计数事实端口（workorder → baseline，合同 §4 依赖 M2） ----

/** 单工作令的附件图纸计数事实（下图统计的原子数据行；口径归 engine-reporting）。 */
export interface DrawingReceiptFact {
  /** 工作令 id（opaque 业务指向，不落外键）。 */
  readonly workOrderId: string;
  /** 附件图纸计数（≥0）。 */
  readonly drawingCount: number;
  /** 事实产出时刻（ISO 8601；实现方可缺省）。 */
  readonly asOf?: string;
}

/**
 * 工作令附件图纸计数来源端口：workorder 线/组合根实现（数据源 = 工作令附件
 * 的图纸类挂接计数）；baseline 的下图统计事实查询经本端口取数后原样透出。
 */
export interface WorkOrderDrawingSource {
  listDrawingCounts(tenant: TenantId): Promise<readonly DrawingReceiptFact[]>;
}

/** 缺省空实现：未接线时下图统计事实为空集（boot 不炸；组合根接线后替换）。 */
export const EMPTY_WORKORDER_DRAWING_SOURCE: WorkOrderDrawingSource = {
  listDrawingCounts: async () => [],
};

// ---- 待办联动 ----

/** baseline 待办来源码（workbench TodoStore 的 source 口径；refType = 聚合类型）。 */
export const BASELINE_TODO_SOURCE = 'baseline';
