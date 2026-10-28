/**
 * ai-query 能力目录（CONTRACT v1 §三域能力）。
 *
 * 三域能力 v1 全部 ready（静态目录；后续数据源分级时 status 再分化）。域权限码
 * 叠加在端点级 ai-query:read 之上，能力执行前经 PermissionResolver 逐码复核
 * （缺码 → kind:'denied'，不是 403）。summary 仅由结构化事实模板拼接（v1 无
 * 推测性结论——事实与推测分离的首版形态就是「无推测」）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { WorkOrder } from '../workorder/workorder-stores.js';
import type {
  AiQueryCapabilityInfo,
  AiQueryClarifyOption,
  AiQueryFactCard,
  AiQueryTimeRange,
} from './ai-query-ports.js';

/** 能力 id 词汇（wire 冻结：apps/web 与本模块据此分支）。 */
export type AiQueryCapabilityId = 'workorder-progress' | 'material-gap' | 'quality-inspection';

/** 能力目录（GET /ai-query/capabilities 数据源；字段冻结）。 */
export const AI_QUERY_CAPABILITIES: readonly AiQueryCapabilityInfo[] = [
  {
    capabilityId: 'workorder-progress',
    version: '1',
    subjectKind: 'workorder',
    title: '工作令进度',
    description: '按工作令查三类进度：项目进度（计划 vs 当前态）、机加工（图号×工序）、装配调试（工序），含未完成任务清单。',
    requiredPermissions: ['workorder:read'],
    status: 'ready',
  },
  {
    capabilityId: 'material-gap',
    version: '1',
    subjectKind: 'material',
    title: '物料缺口',
    description: '按工作令查最新齐套核对：类目齐套状态、缺口行明细（需求/可用/缺口量）与采购关联（请购/采购单）。',
    requiredPermissions: ['listing:read'],
    status: 'ready',
  },
  {
    capabilityId: 'quality-inspection',
    version: '1',
    subjectKind: 'inspection',
    title: '质量检验',
    description: '按时间窗（今日/本周/最近N天）查不合格检验单与不合格处置状态（返工/让步/报废、闭环进度）。',
    requiredPermissions: ['inspection:read'],
    status: 'ready',
  },
];

export function capabilityInfoOf(capabilityId: AiQueryCapabilityId): AiQueryCapabilityInfo {
  const found = AI_QUERY_CAPABILITIES.find((entry) => entry.capabilityId === capabilityId);
  if (found === undefined) {
    throw new Error(`未知能力 id：${capabilityId}`);
  }
  return found;
}

// ---- 完整性与口径纪律（CONTRACT v1 §完整性与口径纪律） ----

/**
 * doneQty 口径注记（原样携带，不得静默吞掉）：来源 standard-reports-pack #92 与
 * workorder-progress 注释——进度完成量为派工侧终态回填，报工撤销不回滚（两域
 * 未联动），对账阶段校正。
 */
export const DONE_QTY_CALIBER_NOTE =
  '完成数量口径：进度事实为派工侧终态回填量——报工撤销不回滚 doneQty（两域未联动），口径暂按派工侧终态呈现，对账阶段校正。';

/** 交付倒计时口径注记（来源 workorder-progress.ts：初版口径，对账阶段校正）。 */
export const DELIVERY_COUNTDOWN_CALIBER_NOTE = '交付倒计时为初版口径（对账阶段以活系统行为校正）。';

/** 缺口可用量口径注记（来源 listing-stores GapLine 注释：利库预占口径）。 */
export const GAP_AVAILABLE_QTY_CALIBER_NOTE =
  '可用量口径：跨仓可用 + 本令 issue 订单级锚活跃预占（利库预占未接线时为纯可用量）。';

/** 质检时间窗口径注记。 */
export const INSPECTION_WINDOW_CALIBER_NOTE = '时间窗按判定时刻 judgedAt 过滤（左闭右开），状态取质检单当前态。';

// ---- 质检时间澄清选项（id 稳定可重放；CONTRACT v1 §意图路由） ----

export const AI_QUERY_TIME_CLARIFY_OPTIONS: readonly AiQueryClarifyOption[] = [
  { id: 'today', label: '今日', description: '当地今日 00:00 至今' },
  { id: 'this-week', label: '本周', description: '当地本周一 00:00 至今' },
  { id: 'last-7-days', label: '最近7天', description: '滚动 7×24 小时窗口' },
  { id: 'last-30-days', label: '最近30天', description: '滚动 30×24 小时窗口' },
];

/** 澄清选项 id → 时间范围意图（selectedOptionId 回放口径）。 */
export const AI_QUERY_TIME_OPTION_RANGES: Readonly<Record<string, AiQueryTimeRange>> = {
  today: { kind: 'today' },
  'this-week': { kind: 'this-week' },
  'last-7-days': { kind: 'last-n-days', days: 7 },
  'last-30-days': { kind: 'last-n-days', days: 30 },
};

// ---- 能力执行器形状（service 分发；实现见 capability-*.ts） ----

/** 能力执行上下文（subject/timeRange 按能力所需携带）。 */
export interface AiQueryCapabilityContext {
  readonly tenant: TenantId;
  readonly userId: UserId;
  readonly queryMoment: string;
  /** 行表截断上限（completeness 如实标注）。 */
  readonly rowLimit: number;
  /** 已解析的工作令主体（workorder-progress / material-gap）。 */
  readonly subjectOrder?: WorkOrder;
  /** 已解析的时间范围（quality-inspection）。 */
  readonly timeRange?: AiQueryTimeRange;
}

/** 能力产物：结构化事实（summary 模板拼接）或数据源未就绪。 */
export type AiQueryCapabilityResult =
  | {
      readonly summary: string;
      readonly caliberNotes: readonly string[];
      readonly factCards: readonly AiQueryFactCard[];
    }
  | { readonly unavailableDetail: string };

/** 行表截断（完整性如实：截断时 totalKnown=true 且 note 标注总量与展示量）。 */
export function capRows<T>(values: readonly T[], rowLimit: number): {
  readonly values: readonly T[];
  readonly truncated: boolean;
  readonly total: number;
} {
  if (values.length <= rowLimit) return { values, truncated: false, total: values.length };
  return { values: values.slice(0, rowLimit), truncated: true, total: values.length };
}
