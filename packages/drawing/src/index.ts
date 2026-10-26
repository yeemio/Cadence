/**
 * @smes/drawing —— 图纸专业包（M3 实施，m3-drafts/03-drawing.md v1.0 冻结合同）。
 *
 * 激活开关语义（合同 §1）：开关关闭时图纸域入口、权限码（drawing:read /
 * drawing:publish / drawing:audit-read）、通知消费全部不可见——**注册面
 * （app-registry / 组合根接线 / 权限策略登记）归总控**，本包只保证不被接线即
 * 不可见（零副作用构造 + 内存回落）。
 *
 * 包身份：图纸=版本化文档——一次修订=一条 DrawingRevision（append-only 链）；
 * 业务对象挂图纸用 DrawingRef 钉住修订号（引用不漂移）；新修订发布联动变更
 * 通知；查看必过保密门禁+必留痕（两级值集 公开/受限，R-M3-6 推荐默认）。
 *
 * 依赖铁律（pro-pack-tier-edges）：仅依赖 @smes/business-core（v1 无 engine
 * 依赖）；不 import @smes/application 与任何 M2 模块；消费方（workorder/
 * dispatch/reporting/inspection）持钉版引用时以结构同形字段进自己版本化
 * schema，**不 import 本包**（合同 §4 差异表 #3，引用存在性校验与通知投递
 * 归组合根）；business-store 的 PG 适配不 import 本包（结构同形镜像，见
 * drawing-errors 的跨包防线注）。
 */
export type {
  DrawingRef,
  DrawingViewer,
  DrawingChangeNotice,
  DrawingChangeQuery,
  AppendDrawingChangeNoticeInput,
} from './ports.js';
export type { DrawingChangeNoticePort } from './ports.js';

export {
  CLASSIFICATION_LEVELS,
  CLASSIFICATION_LEVEL_LABELS,
  DEFAULT_CLASSIFICATION_LEVEL,
  DRAWING_PERMISSIONS,
  DRAWING_INDEX_DEFAULT_PAGE_SIZE,
  DRAWING_INDEX_MAX_PAGE_SIZE,
  isClassificationLevel,
  classificationRank,
  classificationAllows,
  requireClassificationLevel,
  type ClassificationLevel,
  type DrawingPermission,
} from './drawing-config.js';
export {
  DRAWING_REVISION_AUDIT_STATUS_PUBLISHED,
  DRAWING_NOTICE_AUDIT_STATUS_PUBLISHED,
  DRAWING_VIEW_AUDIT_STATUS_VIEWED,
} from './drawing-config.js';

export {
  DrawingId,
  DrawingRevisionId,
  DrawingChangeNoticeId,
  newDrawingRevisionRowId,
  newDrawingChangeNoticeId,
  newDrawingViewTrailRowId,
  uuidv7,
} from './drawing-ids.js';

export {
  DrawingInputError,
  DrawingNotFoundError,
  DrawingConflictError,
  isDrawingConflict,
} from './drawing-errors.js';

export {
  DRAWING_EVENT_TYPES,
  DRAWING_AGGREGATE_TYPES,
  makeDrawingRevisionPublishedEvent,
  makeDrawingViewedEvent,
  type DrawingEventProvenance,
  type DrawingRevisionPublishedPayload,
  type DrawingViewedPayload,
} from './drawing-events.js';

export type {
  DrawingRevisionRow,
  CreateDrawingRevisionInput,
  DrawingRevisionStore,
  DrawingIndexQuery,
  DrawingIndexRow,
  DrawingIndexPage,
  DrawingViewTrailRow,
  AppendDrawingViewInput,
  ListDrawingViewsFilter,
  DrawingViewTrailStore,
  DrawingDomainEventStore,
  DrawingOperationStore,
  DrawingStores,
} from './drawing-stores.js';

export {
  DRAWING_COMMAND_KINDS,
  parseCommandEnvelopeBody,
  parseCommandBodyForKind,
  parseDrawingPublishPayload,
  requireDrawingId,
  requireVersion,
  parseSinceVersionParam,
  parseDrawingIdParam,
  parseVersionParam,
  parseClearance,
  parseDrawingRef,
  parsePageIndexParam,
  parsePageSizeParam,
  parseSearchParam,
  parseReadReferenceTtlParam,
  type DrawingCommandKind,
  type DrawingCommand,
  type DrawingCommandEnvelope,
  type DrawingEnvelopeBody,
  type DrawingPublishPayload,
  type DrawingRefInput,
} from './drawing-input.js';

export {
  DrawingService,
  type DrawingServiceOptions,
  type DrawingCommandResult,
  type DrawingCommitted,
  type DrawingRevisionView,
  type DrawingRevisionSummaryView,
  type WorkOrderDrawingView,
  type DrawingIndexQueryInput,
  type DrawingIndexEntry,
  type DrawingIndexView,
} from './drawing.service.js';

export {
  DrawingReadReferenceSigner,
  newDrawingReadReferenceSigningKey,
  encodeDrawingReadReferenceToken,
  verifyDrawingReadReferenceToken,
  DEFAULT_DRAWING_READ_REFERENCE_TTL_SECONDS,
  MAX_DRAWING_READ_REFERENCE_TTL_SECONDS,
  type DrawingReadReference,
  type DrawingReadReferenceClaims,
  type DrawingReadReferenceSignerOptions,
} from './drawing-read-references.js';

export {
  InMemoryDrawingRevisionStore,
  InMemoryDrawingChangeNoticeStore,
  InMemoryDrawingViewTrailStore,
  InMemoryDrawingDomainEventStore,
  InMemoryDrawingOperationStore,
  inMemoryDrawingStores,
} from './in-memory-drawing-stores.js';
