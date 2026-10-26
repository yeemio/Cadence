/**
 * drawing 存储端口的内存先行实现（M3；体例同 in-memory-payroll-stores：重启
 * 即失，PG 实现在 business-store `./drawing`（结构同形镜像类型——
 * pro-pack-tier-edges，不 import 本包）；无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，零 DB boot 语义完整）。
 *
 * 唯一约束防线与 PG 同合同：revisions 按 (tenant, drawingId, version) 与
 * (tenant, supersedes)；notices 按 (tenant, drawingId, toVersion) 拒重复落账
 * （抛 DrawingConflictError）。留痕行无业务唯一键（每次查看都是新事实）。
 *
 * supersedesVersion = version−1 派生（链连续由唯一约束+链尾+1 构造保证），
 * 首发缺省不落——与 PG 映射器同口径。
 */
import type { BusinessEvent, TenantId } from '@smes/business-core';
import { DrawingConflictError } from './drawing-errors.js';
import {
  newDrawingChangeNoticeId,
  newDrawingRevisionRowId,
  newDrawingViewTrailRowId,
} from './drawing-ids.js';
import type { DrawingId, DrawingRevisionId } from './drawing-ids.js';
import type {
  AppendDrawingChangeNoticeInput,
  DrawingChangeNotice,
  DrawingChangeNoticePort,
  DrawingChangeQuery,
} from './ports.js';
import type {
  AppendDrawingViewInput,
  CreateDrawingRevisionInput,
  DrawingDomainEventStore,
  DrawingIndexPage,
  DrawingIndexQuery,
  DrawingIndexRow,
  DrawingOperationStore,
  DrawingRevisionRow,
  DrawingRevisionStore,
  DrawingStores,
  DrawingViewTrailRow,
  DrawingViewTrailStore,
  ListDrawingViewsFilter,
} from './drawing-stores.js';

/** 修订行落账（append-only 派生口径：supersedesVersion 由 version 派生）。 */
function withDerivedRevisionFields(
  input: CreateDrawingRevisionInput,
  id: DrawingRevisionId,
  createdAt: string,
): DrawingRevisionRow {
  return {
    ...input,
    id,
    createdAt,
    ...(input.version > 1 ? { supersedesVersion: input.version - 1 } : {}),
  };
}

/** 图纸修订链内存实现（append-only；链线性不变量由两组唯一检查背书）。 */
export class InMemoryDrawingRevisionStore implements DrawingRevisionStore {
  private readonly rows: DrawingRevisionRow[] = [];

  async insert(input: CreateDrawingRevisionInput): Promise<DrawingRevisionRow> {
    const chain = this.rows.filter(
      (row) => row.tenant === input.tenant && row.drawingId === input.drawingId,
    );
    if (chain.some((row) => row.version === input.version)) {
      throw new DrawingConflictError(
        `图纸 ${input.drawingId} 修订 v${input.version} 已存在（并发发布竞态）`,
      );
    }
    if (input.supersedes !== null && chain.some((row) => row.supersedes === input.supersedes)) {
      throw new DrawingConflictError(`图纸 ${input.drawingId} 的前任修订行已被取代（supersedes 链分叉）`);
    }
    const row = withDerivedRevisionFields(input, newDrawingRevisionRowId(), new Date().toISOString());
    this.rows.push(row);
    return row;
  }

  async find(tenant: TenantId, drawingId: DrawingId, version: number): Promise<DrawingRevisionRow | null> {
    return this.rows.find((row) => row.tenant === tenant && row.drawingId === drawingId && row.version === version) ?? null;
  }

  async chain(tenant: TenantId, drawingId: DrawingId): Promise<readonly DrawingRevisionRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.drawingId === drawingId)
      .sort((a, b) => a.version - b.version);
  }

  async listIndex(tenant: TenantId, query: DrawingIndexQuery): Promise<DrawingIndexPage> {
    const visible = new Set(query.visibleClassifications);
    // 租户 + 前缀过滤后按 drawingId 聚合（全链行都在，供真链尾判定）。
    const byDrawing = new Map<string, DrawingRevisionRow[]>();
    for (const row of this.rows) {
      if (row.tenant !== tenant) continue;
      if (query.drawingIdPrefix !== undefined && !row.drawingId.startsWith(query.drawingIdPrefix)) continue;
      const list = byDrawing.get(row.drawingId) ?? [];
      list.push(row);
      byDrawing.set(row.drawingId, list);
    }
    const indexed: DrawingIndexRow[] = [];
    for (const [drawingId, rows] of byDrawing) {
      // 可见集聚合（端口合同）：全链超许可的图纸不进索引——不泄漏存在性。
      const visibleRows = rows.filter((row) => visible.has(row.classification));
      if (visibleRows.length === 0) continue;
      const latestVisible = visibleRows.reduce((max, row) => (row.version > max.version ? row : max));
      const tailVersion = rows.reduce((max, row) => Math.max(max, row.version), 0);
      indexed.push({
        drawingId,
        latestVisibleVersion: latestVisible.version,
        latestVisibleClassification: latestVisible.classification,
        tailVersion,
      });
    }
    indexed.sort((a, b) => a.drawingId.localeCompare(b.drawingId));
    return {
      rows: indexed.slice(query.offset, query.offset + query.limit),
      total: indexed.length,
    };
  }
}

/** 变更通知内存实现（(tenant, drawingId, toVersion) 唯一；toVersion 升序读）。 */
export class InMemoryDrawingChangeNoticeStore implements DrawingChangeNoticePort {
  private readonly rows: DrawingChangeNotice[] = [];

  async publish(input: AppendDrawingChangeNoticeInput): Promise<DrawingChangeNotice> {
    if (
      this.rows.some(
        (row) =>
          row.tenant === input.tenant && row.drawingId === input.drawingId && row.toVersion === input.toVersion,
      )
    ) {
      throw new DrawingConflictError(
        `图纸 ${input.drawingId} 的变更通知 to v${input.toVersion} 已落账（发布联动幂等锚点）`,
      );
    }
    const row: DrawingChangeNotice = { ...input, noticeId: newDrawingChangeNoticeId(), createdAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }

  async readByDrawing(
    tenant: TenantId,
    drawingId: DrawingId,
    query?: DrawingChangeQuery,
  ): Promise<readonly DrawingChangeNotice[]> {
    return this.rows
      .filter(
        (row) =>
          row.tenant === tenant &&
          row.drawingId === drawingId &&
          (query?.sinceVersion === undefined || row.toVersion > query.sinceVersion),
      )
      .sort((a, b) => a.toVersion - b.toVersion);
  }
}

/** 查看留痕内存实现（append-only；seq = 追加序）。 */
export class InMemoryDrawingViewTrailStore implements DrawingViewTrailStore {
  private readonly rows: DrawingViewTrailRow[] = [];

  async insert(input: AppendDrawingViewInput): Promise<DrawingViewTrailRow> {
    const row: DrawingViewTrailRow = {
      ...input,
      id: newDrawingViewTrailRowId(),
      seq: this.rows.length + 1,
      objectVersion: 1,
    };
    this.rows.push(row);
    return row;
  }

  async list(tenant: TenantId, filter?: ListDrawingViewsFilter): Promise<readonly DrawingViewTrailRow[]> {
    return this.rows
      .filter((row) => row.tenant === tenant)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.drawingId !== undefined && row.drawingId !== filter.drawingId) return false;
        if (filter.viewedBy !== undefined && row.viewedBy !== filter.viewedBy) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 域事件内存实现（保序保存；eventId 去重防线）。 */
export class InMemoryDrawingDomainEventStore implements DrawingDomainEventStore {
  private readonly events: BusinessEvent[] = [];
  private readonly seen = new Set<string>();

  async append(event: BusinessEvent): Promise<void> {
    if (this.seen.has(event.eventId)) {
      throw new DrawingConflictError(`事件 '${event.eventId}' 已落账（eventId 幂等锚点）`);
    }
    this.seen.add(event.eventId);
    this.events.push(event);
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter((event) => event.tenantId === tenant)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

/** 命令幂等账本内存实现。 */
export class InMemoryDrawingOperationStore implements DrawingOperationStore {
  private readonly claimedKeys = new Set<string>(); // key: `${tenant}|${operationId}`

  async claim(tenant: TenantId, operationId: string, _commandKind: string): Promise<boolean> {
    const key = `${tenant}|${operationId}`;
    if (this.claimedKeys.has(key)) return false;
    this.claimedKeys.add(key);
    return true;
  }
}

/** 内存端口全集（零 DB boot 装配）。 */
export function inMemoryDrawingStores(): DrawingStores {
  return {
    revisions: new InMemoryDrawingRevisionStore(),
    notices: new InMemoryDrawingChangeNoticeStore(),
    views: new InMemoryDrawingViewTrailStore(),
    events: new InMemoryDrawingDomainEventStore(),
    operations: new InMemoryDrawingOperationStore(),
  };
}
