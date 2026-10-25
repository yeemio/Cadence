/**
 * DrawingService —— 图纸域用例编排（M3，m3-drafts/03-drawing.md v1.0）。
 * 零框架业务类（不 import @nestjs/*；注册面/激活开关接线归组合根与总控）。
 * 版本化文档域无状态机（ADR-0010；G2 不适用）：修订链 = append-only 发布
 * 事实（发布 v4 不改 v3——钉版引用不漂移，合同 §7 对账锚）。
 *
 * 命令（合同 §3 全集，G1 口径：先解析校验后记账——被拒命令不占用 operationId）：
 *  - drawing.publish.v1：发布新修订（drawingId+fileRef+changeNote+classification；
 *    version 由链尾+1，客户端不传；expectedRevision 乐观锁（'initial'=首发，
 *    N=在当前 vN 上追加）；发布即联动落 DrawingChangeNotice（from→to））。
 *
 * 查看与查询（合同 §3 查询面；保密两不变量在服务层承载，合同 §2）：
 *  - viewRevision：web/移动查看（钉版 vN 或当前版）——**内容指针 fileRef 的
 *    唯一取得路径**：先过保密门禁（clearance vs classification；不可见与
 *    不存在同形 404，不泄漏存在性），必落查看留痕行 + DrawingViewed 事件，
 *    再返回内容视图；
 *  - revisionChain：修订链（clearance 过滤；**不含 fileRef**——清单是元数据
 *    索引，内容走 viewRevision 留痕路径）；
 *  - notices：变更通知读取（sinceVersion 游标——消费方轮询/对账）；
 *  - drawingsForWorkOrder：按工作令图纸清单（消费 workorder 附件的钉版引用
 *    结构同形载荷 + 修订升级视图"我引用的 vN 是否已有更新"；组合根粘合面，
 *    §4 差异表 #3：消费模块不 import 本包）；
 *  - viewAudit：查看留痕审计（保密管理员；drawing:audit-read 在边缘过滤）。
 *
 * 事件追加失败窗口：发布命令走 indeterminate(retrySafe=true)（重放安全：
 * 修订/通知幂等键完整——(tenant, drawingId, version)/(tenant, drawingId,
 * toVersion) 唯一）；查看路径 fail-closed 抛错（留痕行已落=保守安全方向，
 * 不返回内容指针）。
 */
import type {
  BusinessEvent,
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
} from '@smes/business-core';
import { DrawingNotFoundError, isDrawingConflict } from './drawing-errors.js';
import {
  DRAWING_EVENT_TYPES,
  makeDrawingRevisionPublishedEvent,
  makeDrawingViewedEvent,
  type DrawingEventProvenance,
} from './drawing-events.js';
import {
  parseDrawingPublishPayload,
  parseDrawingRef,
  type DrawingCommandEnvelope,
  type DrawingRefInput,
} from './drawing-input.js';
import {
  DRAWING_REVISION_AUDIT_STATUS_PUBLISHED,
  DRAWING_VIEW_AUDIT_STATUS_VIEWED,
  classificationAllows,
  classificationRank,
} from './drawing-config.js';
import type { DrawingChangeNotice, DrawingViewer } from './ports.js';
import type { DrawingId } from './drawing-ids.js';
import type {
  DrawingRevisionRow,
  DrawingStores,
  DrawingViewTrailRow,
  ListDrawingViewsFilter,
} from './drawing-stores.js';

// ---- 结果形状 ----

/**
 * 修订内容视图（查看路径回执）：唯一携 fileRef 的视图——过门禁+留痕后返回。
 */
export interface DrawingRevisionView {
  /** 修订行 id（dr-<uuidv7>）。 */
  readonly id: string;
  readonly drawingId: string;
  readonly version: number;
  /** 内容指针（存储键/URL；水印/下载控制/签名 URL=实施层解释）。 */
  readonly fileRef: string;
  readonly changeNote: string;
  readonly classification: string;
  readonly changedBy: string;
  readonly changedAt: string;
  /** 取代的上一修订号（首发 null）。 */
  readonly supersedesVersion: number | null;
  /** current = 链尾；superseded = 历史修订（钉版查看常态）。 */
  readonly status: 'current' | 'superseded';
  readonly createdAt: string;
}

/** 修订链元数据视图（清单口径：**不含 fileRef**——内容走 viewRevision 留痕路径）。 */
export interface DrawingRevisionSummaryView extends Omit<DrawingRevisionView, 'fileRef'> {}

export interface DrawingCommitted extends CommittedOutcome {
  /** drawing.publish 回执：新修订内容视图（发布者本人，门禁不适用）。 */
  readonly revision?: DrawingRevisionView;
  /** 发布联动的变更通知事实（from→to）。 */
  readonly notice?: DrawingChangeNotice;
}

export type DrawingCommandResult = DrawingCommitted | RejectedOutcome | IndeterminateOutcome;

export interface DrawingServiceOptions {
  /** 时钟注入（事件 occurredAt 与修订 changedAt 取时点；测试确定性）。 */
  readonly now?: () => string;
}

/** 按工作令图纸清单的单条升级视图（消费方持钉版引用，§4 结构同形粘合面）。 */
export type WorkOrderDrawingView =
  | {
      readonly drawingId: string;
      readonly version: number;
      readonly status: 'ok';
      readonly changeNote: string;
      readonly classification: string;
      readonly changedBy: string;
      readonly changedAt: string;
      /** 查看者许可内最新版（钉版引用的升级目标）。 */
      readonly latestVersion: number;
      /** true = 引用的 vN 之后已有更新（钉版不漂移，升级是显式动作）。 */
      readonly hasUpdate: boolean;
    }
  | { readonly drawingId: string; readonly version: number; readonly status: 'restricted' }
  | { readonly drawingId: string; readonly version: number; readonly status: 'missing' };

// ---- 服务 ----

export class DrawingService {
  private readonly now: () => string;

  constructor(
    private readonly stores: DrawingStores,
    options: DrawingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: DrawingCommandEnvelope): Promise<DrawingCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'drawing.publish.v1':
          return await this.publishDrawing(tenant, envelope);
      }
    } catch (error) {
      if (isDrawingConflict(error)) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（G1：先解析校验后记账）。调用点在载荷解析与业务校验全部
   * 通过、首个持久写之前——被拒命令不占用 operationId，同 id 修正重发可重新
   * 评估；已 committed 的同 id 重发在此被拒（不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: DrawingCommandEnvelope): Promise<DrawingCommandResult | null> {
    const claimed = await this.stores.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: DrawingCommandEnvelope): DrawingEventProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  /** 查看动作溯源（读路径动作：operationId=确定性复合锚；留痕行 id 在事件载荷）。 */
  private viewProvenance(drawingId: string, version: number, viewer: DrawingViewer, viewedAt: string): DrawingEventProvenance {
    return {
      operationId: `view|${drawingId}|v${version}|${viewedAt}|${String(viewer.userId)}`,
      issuedBy: String(viewer.userId),
      commandKind: 'drawing.view',
      contract: 'smes.command.v1',
    };
  }

  /** 事件逐条落账；失败 = 中断窗口 → indeterminate（重放安全：事实幂等键完整）。 */
  private async commitOutcome(
    events: readonly BusinessEvent[],
    extra: Omit<DrawingCommitted, keyof CommittedOutcome | 'events'>,
    failureContext: string,
  ): Promise<DrawingCommandResult> {
    try {
      for (const event of events) {
        await this.stores.events.append(event);
      }
      return { status: 'committed', newRevision: 1, events, ...extra };
    } catch (error) {
      return {
        status: 'indeterminate',
        reason: `${failureContext}（${error instanceof Error ? error.message : String(error)}）：retrySafe=true——事实幂等键完整，可安全重发新 operationId 重放`,
        retrySafe: true,
      };
    }
  }

  // ---- drawing.publish.v1（发布新修订；发布即联动变更通知） ----

  private async publishDrawing(tenant: TenantId, envelope: DrawingCommandEnvelope): Promise<DrawingCommandResult> {
    const payload = parseDrawingPublishPayload(envelope.command.payload);
    const chain = await this.stores.revisions.chain(tenant, payload.drawingId);
    const tail = chain.length > 0 ? chain[chain.length - 1]! : null;
    if (envelope.expectedRevision === 'initial') {
      if (tail !== null) {
        return {
          status: 'rejected',
          reason: `图纸 '${payload.drawingId}' 已存在（当前 v${tail.version}），新修订请声明 expectedRevision=${tail.version}`,
        };
      }
    } else {
      if (tail === null) {
        return {
          status: 'rejected',
          reason: `图纸 '${payload.drawingId}' 不存在，无修订可追加（首发请走 expectedRevision='initial'）`,
        };
      }
      if (envelope.expectedRevision !== tail.version) {
        return {
          status: 'rejected',
          reason: `乐观锁冲突：图纸 '${payload.drawingId}' 声明 expectedRevision=${String(envelope.expectedRevision)}，当前链尾 version=${tail.version}（不重试同信封）`,
        };
      }
    }
    // 先解析校验后记账（G1）：发布语义守门全过、修订行落账前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const changedAt = this.now();
    const version = tail === null ? 1 : tail.version + 1;
    const revision = await this.stores.revisions.insert({
      tenant,
      drawingId: payload.drawingId,
      version,
      fileRef: payload.fileRef,
      changeNote: payload.changeNote,
      classification: payload.classification,
      changedBy: envelope.issuedBy,
      changedAt,
      supersedes: tail === null ? null : tail.id,
      objectVersion: 1,
      auditStatus: DRAWING_REVISION_AUDIT_STATUS_PUBLISHED,
      provenance,
      businessTime: envelope.issuedAt,
    });
    // 发布联动：变更通知（from→to；首发 from=0）。差异表 #1——通知不是独立入口。
    const notice = await this.stores.notices.publish({
      tenant,
      drawingId: payload.drawingId,
      fromVersion: tail === null ? 0 : tail.version,
      toVersion: version,
      changeNote: payload.changeNote,
      publishedAt: changedAt,
      objectVersion: 1,
      auditStatus: DRAWING_REVISION_AUDIT_STATUS_PUBLISHED,
      provenance,
      businessTime: envelope.issuedAt,
    });
    const event = makeDrawingRevisionPublishedEvent(tenant, revision, notice, provenance, changedAt);
    return this.commitOutcome(
      [event],
      { revision: this.toRevisionView(revision, true), notice },
      '修订行/变更通知已落账但事件追加失败',
    );
  }

  // ---- 查看与查询（读路径） ----

  /**
   * web/移动查看（保密两不变量的执行点，合同 §2）：
   * 门禁（不可见与不存在同形 404）→ 留痕行 + DrawingViewed 事件 → 内容视图。
   * version='latest' 查当前版；钉版查看传具体修订号（v4 发布后 v3 读回仍 v3）。
   */
  async viewRevision(
    tenant: TenantId,
    viewer: DrawingViewer,
    drawingId: DrawingId,
    version: number | 'latest',
  ): Promise<DrawingRevisionView> {
    classificationRank(viewer.clearance); // 未知许可 fail-fast，不默认放行
    const chain = await this.stores.revisions.chain(tenant, drawingId);
    const target =
      version === 'latest'
        ? chain.length > 0
          ? chain[chain.length - 1]!
          : undefined
        : chain.find((row) => row.version === version);
    // 不存在与超保密等级不可见**同形 404**：消息只回显调用方已知入参（租户/
    // 图纸/请求版本），不回显内部状态（链长/目标版本/等级）——不泄漏存在性。
    const requestLabel = version === 'latest' ? '当前版' : `v${version}`;
    const notVisible = () =>
      new DrawingNotFoundError(`租户 '${tenant}' 内不存在图纸 '${drawingId}' 的可查看修订 ${requestLabel}`);
    if (target === undefined) {
      throw notVisible();
    }
    if (!classificationAllows(viewer.clearance, target.classification)) {
      throw notVisible();
    }
    const viewedAt = this.now();
    const provenance = this.viewProvenance(drawingId, target.version, viewer, viewedAt);
    const trail: DrawingViewTrailRow = await this.stores.views.insert({
      tenant,
      drawingId,
      version: target.version,
      viewedBy: viewer.userId,
      viewedAt,
      classification: target.classification,
      auditStatus: DRAWING_VIEW_AUDIT_STATUS_VIEWED,
      provenance,
      businessTime: viewedAt,
    });
    const event = makeDrawingViewedEvent(tenant, trail, provenance, viewedAt);
    await this.stores.events.append(event); // fail-closed：事件失败即查看失败（留痕已落=保守方向）
    const latestRow = chain.length > 0 ? chain[chain.length - 1]! : target;
    return this.toRevisionView(target, target === latestRow);
  }

  /** 修订链（按 drawingId，含 changeNote；clearance 过滤；不含 fileRef）。 */
  async revisionChain(
    tenant: TenantId,
    viewer: DrawingViewer,
    drawingId: DrawingId,
  ): Promise<readonly DrawingRevisionSummaryView[]> {
    classificationRank(viewer.clearance);
    const chain = await this.stores.revisions.chain(tenant, drawingId);
    const latest = chain.length > 0 ? chain[chain.length - 1]!.version : 0;
    return chain
      .filter((row) => classificationAllows(viewer.clearance, row.classification))
      .map((row) => this.toSummaryView(row, row.version === latest));
  }

  /** 变更通知读取（sinceVersion 游标：只取 toVersion > sinceVersion；toVersion 升序）。 */
  async notices(
    tenant: TenantId,
    drawingId: DrawingId,
    sinceVersion?: number,
  ): Promise<readonly DrawingChangeNotice[]> {
    return this.stores.notices.readByDrawing(
      tenant,
      drawingId,
      sinceVersion === undefined ? {} : { sinceVersion },
    );
  }

  /**
   * 按工作令图纸清单（合同 §3：消费 workorder 附件事实 + 修订升级视图）。
   * refs = 消费方结构同形钉版引用（组合根从 workorder 附件载荷透传，§4 裁定：
   * 消费模块不 import 本包）。restricted = 引用存在但超查看者许可（内容/元数据
   * 均不返回；引用本身由调用方持有，不泄漏新信息）；missing = 修订不存在。
   */
  async drawingsForWorkOrder(
    tenant: TenantId,
    viewer: DrawingViewer,
    refs: readonly DrawingRefInput[],
  ): Promise<readonly WorkOrderDrawingView[]> {
    classificationRank(viewer.clearance);
    const views: WorkOrderDrawingView[] = [];
    for (const ref of refs) {
      const parsed = parseDrawingRef(ref);
      const chain = await this.stores.revisions.chain(tenant, parsed.drawingId);
      const pinned = chain.find((row) => row.version === parsed.version) ?? null;
      if (pinned === null) {
        views.push({ drawingId: parsed.drawingId, version: parsed.version, status: 'missing' });
        continue;
      }
      if (!classificationAllows(viewer.clearance, pinned.classification)) {
        views.push({ drawingId: parsed.drawingId, version: parsed.version, status: 'restricted' });
        continue;
      }
      // 升级视图只看许可内的新版（"存在新版"本身按许可过滤，不越级泄漏）
      const latestViewable = chain
        .filter((row) => classificationAllows(viewer.clearance, row.classification))
        .reduce((max, row) => Math.max(max, row.version), pinned.version);
      views.push({
        drawingId: parsed.drawingId,
        version: parsed.version,
        status: 'ok',
        changeNote: pinned.changeNote,
        classification: pinned.classification,
        changedBy: pinned.changedBy,
        changedAt: pinned.changedAt,
        latestVersion: latestViewable,
        hasUpdate: latestViewable > pinned.version,
      });
    }
    return views;
  }

  /** 查看留痕审计（保密管理员；drawing:audit-read 在边缘过滤；seq 升序）。 */
  async viewAudit(
    tenant: TenantId,
    filter?: ListDrawingViewsFilter,
  ): Promise<readonly DrawingViewTrailRow[]> {
    return this.stores.views.list(tenant, filter);
  }

  /** 事件读（审计/调试口径，occurredAt 升序）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }

  // ---- 内部 ----

  private toRevisionView(row: DrawingRevisionRow, isCurrent: boolean): DrawingRevisionView {
    return {
      id: row.id,
      drawingId: row.drawingId,
      version: row.version,
      fileRef: row.fileRef,
      changeNote: row.changeNote,
      classification: row.classification,
      changedBy: row.changedBy,
      changedAt: row.changedAt,
      supersedesVersion: row.supersedesVersion ?? null,
      status: isCurrent ? 'current' : 'superseded',
      createdAt: row.createdAt,
    };
  }

  private toSummaryView(row: DrawingRevisionRow, isCurrent: boolean): DrawingRevisionSummaryView {
    const view = this.toRevisionView(row, isCurrent);
    return {
      id: view.id,
      drawingId: view.drawingId,
      version: view.version,
      changeNote: view.changeNote,
      classification: view.classification,
      changedBy: view.changedBy,
      changedAt: view.changedAt,
      supersedesVersion: view.supersedesVersion,
      status: view.status,
      createdAt: view.createdAt,
    };
  }
}
