/**
 * workorder 状态机配置（M2-W1，ADR-0010 条 2：状态集是配置，不是内核）。
 *
 * 两份配置均为 engine-flow ApprovalFlowConfig 形态（配置驱动、可整体替换）：
 *  - WORK_ORDER_FLOW_CONFIG   工作令九态（未开始→…→已关闭，含跳态与回退）
 *  - PARTS_REQUEST_FLOW_CONFIG 配件申请六态（draft → submitted → approved/
 *    rejected → shipped → received；审批决策走 engine-flow 决策迁移）
 *
 * 配件审批链（S6 / RREQ-IS-037）：PartsApprovalChain（级数 1/2/3 + 二三级
 * 角色）经 buildPartsRequestFlowConfig 生成多级链配置——待审中间态
 * level2_review/level3_review 与 submitted 同属「审批中」统一文案族；缺省
 * 链 levels=1 与基线配置逐规则等价（零回归）。
 *
 * 九态跳态/回退合法集为**合同初版**（02-workorder.md §8 Open question：对账
 * 阶段以活系统行为反推校正后冻结为 engine-flow 配置）——换一份配置即得到
 * 不同合法集，模块编排代码零改动。状态 id 为小写蛇形（engine 配置校验
 * 约束），中文语义经 WORK_ORDER_STATES 目录映射（展示层词汇，不进引擎）。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

/** 工作令九态配置标识。 */
export const WORK_ORDER_FLOW_ID = 'work-order';

/** 工作令九态状态 id（配置内声明顺序 = 交付推进序）。 */
export const WORK_ORDER_STATE_IDS = [
  'not_started',
  'in_progress',
  'ready_to_ship',
  'shipped',
  'in_acceptance',
  'in_maintenance',
  'in_aftermarket',
  'completed',
  'closed',
] as const;

export type WorkOrderStateId = (typeof WORK_ORDER_STATE_IDS)[number];

/** 九态目录（id ↔ 合同中文名；展示/待办标题用，引擎只认 id）。 */
export const WORK_ORDER_STATES: ReadonlyArray<{
  readonly id: WorkOrderStateId;
  readonly label: string;
}> = WORK_ORDER_STATE_IDS.map((id, index) => ({
  id,
  label: [
    '未开始',
    '进行中',
    '待发货',
    '已发货',
    '验收中',
    '维保中',
    '售后中',
    '已完成',
    '已关闭',
  ][index] as string,
}));

/** 状态 id → 中文名（未知 id 原样返回，配置换代不炸展示层）。 */
export function workOrderStateLabel(state: string): string {
  return WORK_ORDER_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 工作令九态默认配置（初版合法集）：
 *
 * 主干（8 条）：not_started→in_progress→ready_to_ship→shipped→in_acceptance
 *   →in_maintenance→in_aftermarket→completed→closed
 * 跳态（5 条）：not_started→ready_to_ship、in_progress→shipped（免包装直发）、
 *   in_acceptance→completed（验收即完成）、in_acceptance→in_aftermarket
 *   （免维保段）、in_maintenance→completed（免售后段）
 * 回退（6 条）：ready_to_ship/shipped/in_acceptance→in_progress（返工/撤回）、
 *   in_maintenance→in_acceptance、in_aftermarket→in_maintenance、
 *   completed→in_aftermarket（完成重开）
 * 共 19 条；命令口径：transition.v1 以**目标态**寻径（from=当前态 ∧ to=目标态
 * 的规则），同一目标态可由多个起点到达（如 completed 可自 in_acceptance/
 * in_maintenance/in_aftermarket 进入）；closed 仅自 completed 进入（close 命令
 * 固定目标态）。
 */
export const DEFAULT_WORK_ORDER_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: WORK_ORDER_FLOW_ID,
  initial: 'not_started',
  states: [
    { id: 'not_started' },
    { id: 'in_progress' },
    { id: 'ready_to_ship' },
    { id: 'shipped' },
    { id: 'in_acceptance' },
    { id: 'in_maintenance' },
    { id: 'in_aftermarket' },
    { id: 'completed' },
    { id: 'closed', final: true },
  ],
  transitions: [
    // ---- 主干 ----
    { from: 'not_started', event: 'START', to: 'in_progress', eventAction: 'started' },
    { from: 'in_progress', event: 'READY_TO_SHIP', to: 'ready_to_ship', eventAction: 'ready-to-ship' },
    { from: 'ready_to_ship', event: 'SHIP', to: 'shipped', eventAction: 'shipped' },
    { from: 'shipped', event: 'START_ACCEPTANCE', to: 'in_acceptance', eventAction: 'acceptance-started' },
    { from: 'in_acceptance', event: 'ENTER_MAINTENANCE', to: 'in_maintenance', eventAction: 'maintenance-entered' },
    { from: 'in_maintenance', event: 'ENTER_AFTERSALES', to: 'in_aftermarket', eventAction: 'aftersales-entered' },
    { from: 'in_aftermarket', event: 'COMPLETE', to: 'completed', eventAction: 'completed' },
    { from: 'completed', event: 'CLOSE', to: 'closed', eventAction: 'closed' },
    // ---- 跳态 ----
    { from: 'not_started', event: 'READY_TO_SHIP_DIRECT', to: 'ready_to_ship', eventAction: 'ready-to-ship' },
    { from: 'in_progress', event: 'SHIP_DIRECT', to: 'shipped', eventAction: 'shipped' },
    { from: 'in_acceptance', event: 'COMPLETE_DIRECT', to: 'completed', eventAction: 'completed' },
    { from: 'in_acceptance', event: 'ENTER_AFTERSALES_DIRECT', to: 'in_aftermarket', eventAction: 'aftersales-entered' },
    { from: 'in_maintenance', event: 'COMPLETE_DIRECT', to: 'completed', eventAction: 'completed' },
    // ---- 回退 ----
    { from: 'ready_to_ship', event: 'RESUME_PRODUCTION', to: 'in_progress', eventAction: 'production-resumed' },
    { from: 'shipped', event: 'RESUME_PRODUCTION', to: 'in_progress', eventAction: 'production-resumed' },
    { from: 'in_acceptance', event: 'RESUME_PRODUCTION', to: 'in_progress', eventAction: 'production-resumed' },
    { from: 'in_maintenance', event: 'RESUME_ACCEPTANCE', to: 'in_acceptance', eventAction: 'acceptance-resumed' },
    { from: 'in_aftermarket', event: 'RESUME_MAINTENANCE', to: 'in_maintenance', eventAction: 'maintenance-resumed' },
    { from: 'completed', event: 'RESUME_AFTERSALES', to: 'in_aftermarket', eventAction: 'aftersales-resumed' },
  ],
});

// ---- 配件申请状态机 ----

/** 配件申请配置标识。 */
export const PARTS_REQUEST_FLOW_ID = 'parts-request';

/** 配件申请状态 id（与 02-workorder.md §2 配件申请链一致）。 */
export const PARTS_REQUEST_STATE_IDS = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'shipped',
  'received',
] as const;

export type PartsRequestStateId = (typeof PARTS_REQUEST_STATE_IDS)[number];

/**
 * 配件申请默认配置：draft → submitted →（approve|reject）→ shipped → received。
 * - parts.request 命令 = 建单 + 自动 SUBMIT（落 submitted 待审态）；
 * - parts.approve 决策 approve/reject（决策类迁移，产审批记录语义）；
 * - shipped → received（RECEIVE）由 inventory 收货联动驱动（本模块不发命令，
 *   配置先行声明，行为对齐"审批走 engine-flow 审批链"的合同口径）。
 */
export const DEFAULT_PARTS_REQUEST_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: PARTS_REQUEST_FLOW_ID,
  initial: 'draft',
  states: [
    { id: 'draft' },
    { id: 'submitted' },
    { id: 'approved' },
    { id: 'rejected', final: true },
    { id: 'shipped' },
    { id: 'received', final: true },
  ],
  transitions: [
    { from: 'draft', event: 'SUBMIT', to: 'submitted', eventAction: 'submitted' },
    { from: 'submitted', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
    { from: 'submitted', event: 'REJECT', to: 'rejected', decision: 'reject', eventAction: 'rejected' },
    { from: 'approved', event: 'SHIP', to: 'shipped', eventAction: 'shipped' },
    { from: 'shipped', event: 'RECEIVE', to: 'received', eventAction: 'received' },
  ],
});

// ---- 配件审批链（fix-wave-6 6b-2 / S6：RREQ-IS-037 三级审批） ----

/** 二级待审态 id（多级链中间态；与 submitted 同属「审批中」统一文案族）。 */
export const PARTS_LEVEL2_REVIEW_STATE = 'level2_review';

/** 三级待审态 id（同上）。 */
export const PARTS_LEVEL3_REVIEW_STATE = 'level3_review';

/**
 * 「审批中」统一文案族（RREQ-IS-037：审批中各节点统一文案，不按节点拆状态）。
 * 列表状态过滤对族内任一 id 互为同义词（service.listParts 展开语义）。
 */
export const PARTS_PENDING_STATE_IDS = [
  'submitted',
  PARTS_LEVEL2_REVIEW_STATE,
  PARTS_LEVEL3_REVIEW_STATE,
] as const;

export type PartsPendingStateId = (typeof PARTS_PENDING_STATE_IDS)[number];

/** 待审态 → 审批层级（1/2/3）；非待审态（draft/approved/rejected/shipped/received）返回 null。 */
export function partsApprovalLevelOfState(state: string): 1 | 2 | 3 | null {
  switch (state) {
    case 'submitted':
      return 1;
    case PARTS_LEVEL2_REVIEW_STATE:
      return 2;
    case PARTS_LEVEL3_REVIEW_STATE:
      return 3;
    default:
      return null;
  }
}

/**
 * 配件审批链配置（S6 / RREQ-IS-037）：一级 = 工作令负责人（我方实态映射
 * 项目经理——18 册 §2 权限与待办口径，空回落销售；源文档「业务负责人=销售
 * 人员」的切换登记开放问题），二/三级 = 参数角色或签（源 blade_param 两键
 * 的我方等价物——角色码经组合根/租户解析器注入，用户实时解析不落库）。
 * 缺省 levels=1 = 既有单级审批（RREQ-IS-032 基线），零回归锚点。
 */
export interface PartsApprovalChain {
  /** 审批级数：1（缺省零回归）/ 2 / 3。 */
  readonly levels: 1 | 2 | 3;
  /** 二级审批角色码（org 域角色名；levels≥2 生效；未配置/角色无人 → 该级审批拒绝）。 */
  readonly level2Role?: string;
  /** 三级审批角色码（levels=3 生效）。 */
  readonly level3Role?: string;
}

/** 缺省审批链：单级（零回归）。 */
export const DEFAULT_PARTS_APPROVAL_CHAIN: PartsApprovalChain = { levels: 1 };

/** 角色码形状：与 org RoleName 单段小写形状兼容（PolicyStore grant-role 比对键）。 */
const PARTS_CHAIN_ROLE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 校验并固化一份审批链配置（fail-fast，同 defineApprovalFlowConfig 纪律）：
 * levels ∈ {1,2,3}；levels≥2 须 level2Role；levels=3 须 level3Role；角色码
 * 单段小写形状（≤64）。levels=1 时二/三级角色允许携带（前向兼容：先配角色
 * 后翻级数）但不生效。
 */
export function definePartsApprovalChain(raw: unknown): PartsApprovalChain {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid parts approval chain: expected a plain object, got ${JSON.stringify(raw)}`);
  }
  const { levels, level2Role, level3Role } = raw as Record<string, unknown>;
  if (levels !== 1 && levels !== 2 && levels !== 3) {
    throw new Error(`invalid parts approval chain levels: expected 1|2|3, got ${JSON.stringify(levels)}`);
  }
  const chainLevels = levels as 1 | 2 | 3;
  // 必填级缺角色即报错；levels=1 或非本键必填级时允许前向携带（先配角色后翻级数）。
  if (chainLevels >= 2 && level2Role === undefined) {
    throw new Error(`invalid parts approval chain: levels=${chainLevels} requires 'level2Role'`);
  }
  if (chainLevels === 3 && level3Role === undefined) {
    throw new Error(`invalid parts approval chain: levels=${chainLevels} requires 'level3Role'`);
  }
  return {
    levels: chainLevels,
    ...(level2Role === undefined ? {} : { level2Role: parseChainRole('level2Role', level2Role) }),
    ...(level3Role === undefined ? {} : { level3Role: parseChainRole('level3Role', level3Role) }),
  };
}

/** 角色码校验：单段小写形状（≤64）——与 org RoleName 比对键兼容。 */
function parseChainRole(key: 'level2Role' | 'level3Role', value: unknown): string {
  if (typeof value !== 'string' || !PARTS_CHAIN_ROLE_PATTERN.test(value) || value.length > 64) {
    throw new Error(
      `invalid parts approval chain '${key}': expected single-segment lowercase role code (max 64 chars), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 按审批链构建配件申请流配置（同一 flowId 'parts-request'——请求行
 * flowConfigId 不随级数变化；级数切换后存量在途单由重放守卫兜底，取舍同
 * approval-config 运行时先例）。levels=1 返回 DEFAULT（与基线逐规则等价）。
 */
export function buildPartsRequestFlowConfig(chain: PartsApprovalChain): ApprovalFlowConfig {
  if (chain.levels === 1) {
    return DEFAULT_PARTS_REQUEST_FLOW_CONFIG;
  }
  const pending = chain.levels === 3
    ? ['submitted', PARTS_LEVEL2_REVIEW_STATE, PARTS_LEVEL3_REVIEW_STATE]
    : ['submitted', PARTS_LEVEL2_REVIEW_STATE];
  const transitions: Array<Record<string, string>> = [
    { from: 'draft', event: 'SUBMIT', to: 'submitted', eventAction: 'submitted' },
  ];
  for (let index = 0; index < pending.length; index += 1) {
    const from = pending[index] as string;
    const isLastLevel = index === pending.length - 1;
    const approveTo = isLastLevel ? 'approved' : (pending[index + 1] as string);
    const approveAction = isLastLevel ? 'approved' : `level${index + 2}-review-entered`;
    transitions.push({ from, event: 'APPROVE', to: approveTo, decision: 'approve', eventAction: approveAction });
    transitions.push({ from, event: 'REJECT', to: 'rejected', decision: 'reject', eventAction: 'rejected' });
  }
  transitions.push({ from: 'approved', event: 'SHIP', to: 'shipped', eventAction: 'shipped' });
  transitions.push({ from: 'shipped', event: 'RECEIVE', to: 'received', eventAction: 'received' });
  return defineApprovalFlowConfig({
    schemaVersion: 1,
    flowId: PARTS_REQUEST_FLOW_ID,
    initial: 'draft',
    states: [
      { id: 'draft' },
      { id: 'submitted' },
      ...(chain.levels >= 2 ? [{ id: PARTS_LEVEL2_REVIEW_STATE }] : []),
      ...(chain.levels === 3 ? [{ id: PARTS_LEVEL3_REVIEW_STATE }] : []),
      { id: 'approved' },
      { id: 'rejected', final: true },
      { id: 'shipped' },
      { id: 'received', final: true },
    ],
    transitions,
  });
}

/** 配件申请状态目录（id ↔ 中文名；待审三态统一「审批中」——RREQ-IS-037）。 */
export const PARTS_REQUEST_STATES: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: 'draft', label: '草稿' },
  { id: 'submitted', label: '审批中' },
  { id: PARTS_LEVEL2_REVIEW_STATE, label: '审批中' },
  { id: PARTS_LEVEL3_REVIEW_STATE, label: '审批中' },
  { id: 'approved', label: '已批准' },
  { id: 'rejected', label: '已拒绝' },
  { id: 'shipped', label: '已发货' },
  { id: 'received', label: '已收货' },
];

/** 状态 id → 中文名（未知 id 原样返回——配置换代不炸展示层，口径同 workOrderStateLabel）。 */
export function partsRequestStateLabel(state: string): string {
  return PARTS_REQUEST_STATES.find((entry) => entry.id === state)?.label ?? state;
}

// ---- 清单类目（listing 合同 03 的四类；齐套默认取前三类，初版口径可调） ----

/** 四类清单 kind（listing 模块 ListingSheet.kind 的镜像词汇）。 */
export const LISTING_KINDS = ['part', 'standard', 'electrical', 'equipment'] as const;

export type ListingKind = (typeof LISTING_KINDS)[number];

/**
 * 齐套检查默认覆盖的清单类目（合同口径"三类清单"）：零件/标准件/电气件。
 * 设备采购类默认不入齐套（对账阶段按活系统行为校正，模块选项可调整）。
 */
export const DEFAULT_KIT_SCOPE_KINDS: readonly ListingKind[] = ['part', 'standard', 'electrical'];
