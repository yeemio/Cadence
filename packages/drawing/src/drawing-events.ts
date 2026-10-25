/**
 * drawing 域事件构造（M3，m3-drafts/03-drawing.md §6：append-only + Outbox +
 * 证据列）。事件词汇两个（合同冻结）：DrawingRevisionPublished / DrawingViewed。
 * eventType 守 business-core BusinessEvent 命名：smes.<环节>.v<n>.<过去式动作>。
 * DrawingRevisionPublished 携 from→to（变更通知事实镜像）；DrawingViewed 携
 * 谁/何时/哪修订/当时保密等级（保密审计锚点，合同 §7 对账"留痕完整性"）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { DrawingChangeNotice } from './ports.js';
import type { DrawingRevisionRow, DrawingViewTrailRow } from './drawing-stores.js';

/** 事件类型（合同 §6 词汇）。 */
export const DRAWING_EVENT_TYPES = {
  drawingRevisionPublished: 'smes.drawing.v1.drawing-revision-published',
  drawingViewed: 'smes.drawing.v1.drawing-viewed',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const DRAWING_AGGREGATE_TYPES = {
  drawingRevision: 'drawing',
  drawingView: 'drawing-view',
} as const;

/**
 * 溯源载荷（evidence-columns provenance JSONB 的 drawing 约定形状）。
 * 查看事件（读路径动作）的 operationId = 留痕行 id、commandKind='drawing.view'
 * ——留痕即操作的事实记录，与发布命令同一溯源形状。
 */
export interface DrawingEventProvenance extends Readonly<Record<string, unknown>> {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
}

/** 修订发布事件载荷（发布联动通知的 from→to 事实镜像；supersedes 携链位）。 */
export interface DrawingRevisionPublishedPayload {
  readonly drawingId: string;
  readonly version: number;
  readonly fileRef: string;
  readonly changeNote: string;
  readonly classification: string;
  readonly supersedesVersion: number | null;
  readonly rowId: string;
  readonly noticeId: string;
  readonly fromVersion: number;
}

/** 查看留痕事件载荷（谁、何时、哪修订、当时保密等级）。 */
export interface DrawingViewedPayload {
  readonly drawingId: string;
  readonly version: number;
  readonly viewedBy: string;
  readonly viewedAt: string;
  readonly classification: string;
  readonly trailId: string;
}

export function makeDrawingRevisionPublishedEvent(
  tenant: TenantId,
  revision: DrawingRevisionRow,
  notice: DrawingChangeNotice,
  provenance: DrawingEventProvenance,
  occurredAt: string,
): BusinessEvent<DrawingRevisionPublishedPayload> {
  return makeBusinessEvent<DrawingRevisionPublishedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: DRAWING_EVENT_TYPES.drawingRevisionPublished,
    tenantId: tenant,
    aggregate: {
      id: revision.drawingId,
      type: DRAWING_AGGREGATE_TYPES.drawingRevision,
      revision: revision.version,
    },
    occurredAt,
    ...(revision.businessTime === undefined ? {} : { businessTime: revision.businessTime }),
    provenance,
    payload: {
      drawingId: revision.drawingId,
      version: revision.version,
      fileRef: revision.fileRef,
      changeNote: revision.changeNote,
      classification: revision.classification,
      supersedesVersion: revision.supersedesVersion ?? null,
      rowId: revision.id,
      noticeId: notice.noticeId,
      fromVersion: notice.fromVersion,
    },
  });
}

export function makeDrawingViewedEvent(
  tenant: TenantId,
  trail: DrawingViewTrailRow,
  provenance: DrawingEventProvenance,
  occurredAt: string,
): BusinessEvent<DrawingViewedPayload> {
  return makeBusinessEvent<DrawingViewedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: DRAWING_EVENT_TYPES.drawingViewed,
    tenantId: tenant,
    aggregate: {
      id: `${trail.drawingId}@v${trail.version}`,
      type: DRAWING_AGGREGATE_TYPES.drawingView,
      revision: 1,
    },
    occurredAt,
    businessTime: trail.viewedAt,
    provenance,
    payload: {
      drawingId: trail.drawingId,
      version: trail.version,
      viewedBy: trail.viewedBy,
      viewedAt: trail.viewedAt,
      classification: trail.classification,
      trailId: trail.id,
    },
  });
}
