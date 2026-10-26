/**
 * dispatch 跨模块端口（M2-W6，04-dispatch.md §4"依赖"与"被依赖"）。
 *
 * 只定义接口与缺省实现（模块间互调一律经 application 层端口，ADR-0011 / 通用
 * 合同纪律 6；跨模块只 import 已导出端口接口）。实现方：内存/测试 = testkit
 * 夹具 + 本文件缺省实现（零接线 boot 语义完整）；真实联动 = 兄弟模块在合流时
 * 提供，经 DispatchModule.register 注入（apps/server 组合根接线）。
 *
 * 五个方向：
 *  - workorder KitCheck 齐套读（装配/电气派工创建的放行判断——fail-closed：
 *    无核查记录即拒绝创建，硬拦截语义不静默放行）；
 *  - baseline 外协计价实时取价（创建时逐工序取价；无规则 → 未定价待补录）；
 *  - inspection 外协回厂触发（外协单 done → InspectionIntakePort 投递来源事实）；
 *  - integration-print 打印（外协加工单 TSPL/pdf——业务侧最小形状镜像，边缘
 *    词汇不进业务层，ADR-0011 条 2：application 禁依赖 integration-*）；
 *  - 被依赖面：workorder 进度事件上卷（ProgressFact 同形镜像 + 适配器）。
 *
 * 端口方法一律异步；全部按租户收口。
 */
import type { TenantId } from '@smes/business-core';
import type { OutsourcingPriceQuote } from '../baseline/outsourcing-price.js';
import type { InspectionIntakePort, InspectionIntakeReceipt } from '../inspection/inspection-ports.js';

// ---- workorder 端口：KitCheck 齐套读（装配/电气派工创建的放行判断） ----

/**
 * workorder KitCheck 最新快照的只读消费面（字段口径以 workorder-stores KitCheck
 * 为准，接口镜像其 latestByWorkOrder 导出——结构化兼容，跨模块不引类型）。
 */
export interface KitCheckFact {
  /** 快照 id（放行证据锚点，进 DispatchCreated 事件载荷）。 */
  readonly id: string;
  readonly workOrderId: string;
  /** 全类目齐套 = true（dispatch 装配派工放行判断的口径，workorder 侧注释原文）。 */
  readonly complete: boolean;
  /** 缺口行数（未齐套时的拒绝理由计数）。 */
  readonly gapLineCount: number;
  readonly refreshedAt: string;
}

/**
 * workorder 齐套读端口。实现方读 workorder KitCheckStore.latestByWorkOrder 并
 * 投影成 KitCheckFact（组合根适配：`{ id, workOrderId: String(...), complete,
 * gapLines, refreshedAt } → gapLineCount = gapLines.length`）；缺省空实现 =
 * 恒无核查记录（装配/电气派工创建被 fail-closed 拒绝，接线后放行）。
 */
export interface KitCheckReadPort {
  latestKitCheck(tenant: TenantId, workOrderId: string): Promise<KitCheckFact | null>;
}

/** 缺省齐套读端口：恒无快照（未接线时装配/电气创建被拒——齐套事实不可伪证）。 */
export const EMPTY_KIT_CHECK_PORT: KitCheckReadPort = {
  latestKitCheck: async () => null,
};

/** workorder KitCheck 快照的结构化形状（latestByWorkOrder 返回面的镜像超集）。 */
export interface KitCheckSnapshotLike {
  readonly id?: unknown;
  readonly workOrderId?: unknown;
  readonly complete: boolean;
  readonly gapLines?: readonly unknown[];
  readonly refreshedAt?: unknown;
}

/** 快照镜像 → 消费面投影（组合根/测试适配器用；字段缺失按 null/0 收口）。 */
export function toKitCheckFact(workOrderId: string, snapshot: KitCheckSnapshotLike): KitCheckFact {
  return {
    id: typeof snapshot.id === 'string' ? snapshot.id : '',
    workOrderId,
    complete: snapshot.complete,
    gapLineCount: Array.isArray(snapshot.gapLines) ? snapshot.gapLines.length : 0,
    refreshedAt: typeof snapshot.refreshedAt === 'string' ? snapshot.refreshedAt : '',
  };
}

// ---- baseline 端口：外协计价实时取价（outsourcing 创建时逐工序取价） ----

/**
 * baseline OutsourcingPriceLookup 的本地消费面：无规则 → 返回 null（行落
 * "未定价"，事后补录锚点）。baseline 实现无规则时抛 NotFound——组合根接线时
 * 适配（捕获其 NotFound 翻 null）；返回 Quote 的实现结构化兼容本接口。
 */
export interface OutsourcingPriceSource {
  resolve(tenant: TenantId, processCode: string): Promise<OutsourcingPriceQuote | null>;
}

/** 缺省取价端口：恒无价（零接线 boot——外协行可创建为未定价，事后补录）。 */
export const DISPATCH_EMPTY_PRICE_SOURCE: OutsourcingPriceSource = {
  resolve: async () => null,
};

// ---- inspection 端口：外协回厂触发（外协单 done 联动） ----

export type { InspectionIntakePort, InspectionIntakeReceipt } from '../inspection/inspection-ports.js';

/** 缺省回厂触发端口：未接线时来源事实不落地（inspection intake 合同的空实现语义）。 */
export const DISPATCH_NOOP_INSPECTION_INTAKE: InspectionIntakePort = {
  receiveSourceFact: async () => ({
    inspectionId: null,
    created: false,
    reason: 'inspection intake 端口未接线：dispatch 外协回厂触发需组合根注入 InspectionService',
  }),
};

// ---- integration-print 端口：外协加工单打印（业务侧最小形状镜像） ----

/** 打印文档（外协加工单的结构化数据——TSPL/pdf 渲染归 integration-print 适配器）。 */
export interface DispatchPrintDocument {
  readonly dispatchId: string;
  readonly kind: string;
  /** 单据标题（如"外协加工单（供应商名）"）。 */
  readonly title: string;
  /** 头字段（label/value 行式——渲染顺序即数组序）。 */
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  /** 外协明细行（表格式；空数组 = 非外协单；状态/取消原因列随行——RREQ-DP-031）。 */
  lines: readonly {
    readonly lineNo: number;
    readonly processCode: string;
    readonly drawingNo: string | null;
    readonly quantity: number;
    readonly unitPriceLabel: string;
    readonly promisedAt: string | null;
    /** 行状态中文（待派工/已派工/已质检/已取消——推导口径见 dispatch-config）。 */
    readonly statusLabel: string;
    /** 取消外协原因（未取消为 null）。 */
    readonly cancelReason: string | null;
  }[];
}

/** 打印回执：printed=false 携拒绝原因（未接线/设备不可用——查询不因此失败）。 */
export interface DispatchPrintReceipt {
  readonly printed: boolean;
  readonly jobId: string | null;
  readonly refusedReason?: string;
}

/**
 * 打印端口（integration-print PrintPort 的业务侧最小镜像——edge 词汇不进业务
 * 层，ADR-0011 条 2；组合根把本接口适配到 PrintPort.submit 家族 'pdf'/'tspl'）。
 */
export interface DispatchPrintPort {
  print(tenant: TenantId, document: DispatchPrintDocument): Promise<DispatchPrintReceipt>;
}

/** 缺省打印端口：受理不达设备（零接线 boot——打印数据查询仍完整可用）。 */
export const DISPATCH_NOOP_PRINT_PORT: DispatchPrintPort = {
  print: async () => ({ printed: false, jobId: null, refusedReason: 'print 端口未接线' }),
};

// ---- 被依赖面：workorder 进度事件上卷 ----

/** 进度事实（与 workorder-ports ProgressFact 同形——结构化兼容，不引类型）。 */
export interface DispatchProgressFact {
  readonly stage: 'machining' | 'assembly';
  readonly drawingNo: string | null;
  readonly operationId: string;
  readonly doneQty: number;
  readonly totalQty: number;
  readonly status: 'pending' | 'in_progress' | 'done';
}

/** 进度事实提供方（service.progressFacts 的函数面）。 */
export interface DispatchProgressSource {
  progressFacts(tenant: TenantId, workOrderId: string): Promise<readonly DispatchProgressFact[]>;
}

/**
 * workorder 进度端口适配器（被依赖面）：把 dispatch 进度事实投影成 workorder
 * ProgressFactPort 合同形状（结构化兼容——组合根直接注入 workorder 模块；
 * 体例同 listing 的 createListingRequirementAdapter）。
 */
export function createDispatchProgressAdapter(source: DispatchProgressSource): {
  progressFacts(tenant: TenantId, workOrderId: string): Promise<readonly DispatchProgressFact[]>;
} {
  return { progressFacts: (tenant, workOrderId) => source.progressFacts(tenant, workOrderId) };
}

// ---- 待办联动 ----

/** 待办联动来源码（workbench TodoStore 的 source 口径；refType = 聚合类型）。 */
export const DISPATCH_TODO_SOURCE = 'dispatch';

/** 派工单聚合类型（待办 refType / 事件 aggregate.type 共用词汇）。 */
export const DISPATCH_TODO_REF_TYPE = 'dispatch-order';
