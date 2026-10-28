/**
 * 移动作业页共享标签映射（S3 移动呈现）：各模块后端配置目录（id ↔ 中文名）
 * 的装配层镜像——引擎只认 id，展示词沿后端配置既定中文名（ADR-0010 词汇
 * 纪律：不造新词；未知 id 原样返回，配置换代不炸展示层）。
 *
 * 词源（packages/application/src 各 *-config.ts 实态）：
 * - reporting-config REPORT_KIND_LABELS / REPORT_STATES；
 * - inspection-config INSPECTION_KIND_LABELS / INSPECTION_STATE_IDS 标签；
 * - inventory-config RECEIPT_KIND_LABELS / STOCKTAKE_STATES 标签；
 * - workorder-config WORK_ORDER_STATES / PARTS_REQUEST_STATE_IDS（配件态无
 *   配置标签，按状态机注释口径给通用词）。
 */

/** 报工 kind → 中文名（五类；词源 reporting-config.ts:45）。 */
export const REPORT_KIND_LABELS: Readonly<Record<string, string>> = {
  part: '零件报工',
  assembly: '装配报工',
  electrical: '电气报工',
  aftermarket: '售后报工',
  oddjob: '零工报工',
};

/** 报工状态 → 中文名（四态；词源 reporting-config.ts:71）。 */
export const REPORT_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: '待报',
  reported: '已报',
  verified: '已核查',
  revoked: '已撤销',
};

/** 质检 kind → 中文名（四类；词源 inspection-config.ts:126-131）。 */
export const INSPECTION_KIND_LABELS: Readonly<Record<string, string>> = {
  self_outsourced: '自制外协',
  nonstandard_purchase: '非标件采购',
  standard_purchase: '标准配件采购',
  equipment_purchase: '设备采购',
};

/** 质检状态 → 中文名（四态；词源 inspection-config.ts:34）。 */
export const INSPECTION_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: '待检',
  passed: '合格',
  failed: '不合格',
  closed: '闭环',
};

/** 入库来源 kind → 中文名（三类；词源 inventory-config.ts:33-35）。 */
export const RECEIPT_KIND_LABELS: Readonly<Record<string, string>> = {
  inspection: '质检放行入库',
  purchase: '采购收货入库',
  production: '完工入库',
};

/** 盘点状态 → 中文名（四态；词源 inventory-config.ts:121）。 */
export const STOCKTAKE_STATE_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿',
  counting: '盘点中',
  reconciled: '待审核调账',
  adjusted: '已调账',
};

/**
 * 配件申请状态 → 中文名（六态 + 多级链两个待审中间态；配置无标签，按状态机
 * 注释口径的通用词）。level2_review/level3_review 词源 workorder-config.ts
 * PARTS_LEVEL2/3_REVIEW_STATE——与 submitted 同属「审批中」统一文案族，列表
 * 混级展示时按级次区分（UX-AP-01：审批人须能分辨行正等待哪一级）。
 */
export const PARTS_STATE_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿',
  submitted: '待审批',
  level2_review: '二级审批中',
  level3_review: '三级审批中',
  approved: '已批准',
  rejected: '已拒绝',
  shipped: '已发货',
  received: '已收货',
};

/** 故障单状态 → 中文名（三态；词源 baseline-fault-config.ts:39）。 */
export const FAULT_STATE_LABELS: Readonly<Record<string, string>> = {
  open: '已上报',
  assigned: '已派修',
  resolved: '已闭环',
};

/** 工作令状态 → 中文名（九态；词源 workorder-config.ts:44-52）。 */
export const WORK_ORDER_STATE_LABELS: Readonly<Record<string, string>> = {
  not_started: '未开始',
  in_production: '进行中',
  ready_to_ship: '待发货',
  shipped: '已发货',
  in_acceptance: '验收中',
  in_maintenance: '维保中',
  in_aftercare: '售后中',
  completed: '已完成',
  closed: '已关闭',
};

/** 未知 id 原样返回（配置换代不炸展示层——后端 label 函数同语义）。 */
export function labelOf(labels: Readonly<Record<string, string>>, id: string | null | undefined): string {
  if (id === null || id === undefined) return '—';
  return labels[id] ?? id;
}
