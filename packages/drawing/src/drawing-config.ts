/**
 * drawing 默认配置层（M3，m3-drafts/03-drawing.md v1.0 §2 分层标注第三层）。
 *
 * 保密等级值集与查看留痕策略是**默认配置/租户配置**（ADR-0010 第三层，R-M3-6：
 * 值集=租户配置数据，客户制度对账后可扩——本文件冻结 v1 缺省值集）；内核锁的
 * 两不变量（合同 §2）在服务层与存储端口合同：
 *   1. 查看（内容指针 fileRef 的取得）必须过保密门禁（drawing:read 权限在
 *      边缘 casbin 过滤后，组合根装配 DrawingViewer.clearance 进服务）；
 *   2. 每次查看必须留痕（DrawingViewed 事件 + 留痕行，无例外路径）。
 *
 * 水印（查看者名+时间）、下载控制、短时效签名 URL = fileRef 实施层解释
 * （合同锁不变量不锁实现，差异表 #6 / R-M3-6）。
 */
import { DrawingInputError } from './drawing-errors.js';

// ---- 保密等级（v1 两级缺省值集：公开 / 受限） ----

/**
 * 保密等级稳定码（R-M3-6 推荐默认两级；等级有序——数组位次即高低，
 * 后位=更受限。租户扩值集=改配置数据并保证位次有序，不改类型语义）。
 */
export const CLASSIFICATION_LEVELS = ['public', 'restricted'] as const;

/** 保密等级（默认配置值集的数据值；不进类型——结构字段一律 string）。 */
export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

/** 保密等级人读标签（呈现层用；代码内只用稳定码）。 */
export const CLASSIFICATION_LEVEL_LABELS: Readonly<Record<ClassificationLevel, string>> = {
  public: '公开',
  restricted: '受限',
};

/** 缺省保密等级：公开（发布未声明等级的修订按公开面可见）。 */
export const DEFAULT_CLASSIFICATION_LEVEL: ClassificationLevel = 'public';

/** 保密等级合法性判定（词汇表门禁；未知词显式拒绝，不静默归类）。 */
export function isClassificationLevel(value: string): value is ClassificationLevel {
  return (CLASSIFICATION_LEVELS as readonly string[]).includes(value);
}

/** 保密等级位次（值集序；未知词抛错——门禁配置错必须 fail-fast，不默认放行）。 */
export function classificationRank(value: string): number {
  const index = (CLASSIFICATION_LEVELS as readonly string[]).indexOf(value);
  if (index < 0) {
    throw new DrawingInputError(
      `未知保密等级 '${value}'：须为 ${CLASSIFICATION_LEVELS.join('/')} 之一（值集=租户配置，扩值集改默认配置层）`,
    );
  }
  return index;
}

/**
 * 保密门禁（内核不变量 1 的判定唯一实现）：查看者许可等级 >= 修订保密等级
 * 才可见。许可与等级同用一套值集（public 许可只见 public；restricted 许可
 * 两级都见）。
 */
export function classificationAllows(clearance: string, classification: string): boolean {
  return classificationRank(clearance) >= classificationRank(classification);
}

/** 保密等级解析（发布/查看装配入参；未知词拒绝）。 */
export function requireClassificationLevel(value: unknown, what: string): ClassificationLevel {
  if (typeof value !== 'string' || !isClassificationLevel(value)) {
    throw new DrawingInputError(
      `${what}非法：须为 ${CLASSIFICATION_LEVELS.join('/')} 之一，得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---- 审核状态（append-only 事实域：发布即 published，查看即 viewed） ----

/** 图纸修订审核状态：发布即 published（版本化文档，无流转）。 */
export const DRAWING_REVISION_AUDIT_STATUS_PUBLISHED = 'published';

/** 变更通知审核状态：发布联动事实，恒 published。 */
export const DRAWING_NOTICE_AUDIT_STATUS_PUBLISHED = 'published';

/** 查看留痕审核状态：查看即 viewed（append-only 审计事实）。 */
export const DRAWING_VIEW_AUDIT_STATUS_VIEWED = 'viewed';

// ---- 权限码（合同 §5 最小集） ----

/**
 * drawing 权限码（登记进 casbin 策略面归组合根/总控；此处冻结词汇）。
 *
 *   - drawing:read       查看图纸（+保密等级过滤：数据权限由 DrawingViewer.
 *                        clearance 承载——建议默认角色：工艺/技术/车间管理=
 *                        restricted 许可，一线班组=public 许可）；
 *   - drawing:publish    发布修订（建议默认角色：工艺/技术）；
 *   - drawing:audit-read 查看留痕审计（建议默认角色：保密管理员/工艺负责人）。
 */
export const DRAWING_PERMISSIONS = {
  read: 'drawing:read',
  publish: 'drawing:publish',
  auditRead: 'drawing:audit-read',
} as const;

export type DrawingPermission = (typeof DRAWING_PERMISSIONS)[keyof typeof DRAWING_PERMISSIONS];
