/**
 * P1-c 图号索引 PG 适配器桩单测（不依赖活库，模式同 attachment-objects.test.ts：
 * 桩表=真实表语义的可见子集——tenantId 过滤 + classification 过滤 + distinct
 * 语义），锚定两件事：
 *  1. 查询形状：findMany 用 distinct:['drawingId'] + orderBy drawingId asc/
 *     version desc（DISTINCT ON 取每图可见集内最大 version）+ skip/take 分页；
 *     groupBy 同 where 计 total；真链尾查询限定页内 ids（status 判定专用）；
 *  2. 行映射：rows=许可内链尾+等级；total 与 rows 同过滤口径；页内图纸
 *     tailVersion 联结。容器级贯通（PG 真实 DISTINCT ON 语义）归总控复证。
 */
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import { PgDrawingRevisionStore } from '../src/drawing/pg-drawing-stores.js';

interface StubRow {
  readonly tenantId: string;
  readonly drawingId: string;
  readonly version: number;
  readonly classification: string;
}

interface FindManyArgs {
  readonly where?: {
    readonly tenantId: string;
    readonly drawingId?: { readonly startsWith?: string; readonly in?: readonly string[] } | undefined;
    readonly classification?: { readonly in: readonly string[] } | undefined;
  };
  readonly orderBy?: readonly { readonly drawingId?: 'asc'; readonly version?: 'desc' }[];
  readonly distinct?: readonly string[];
  readonly skip?: number;
  readonly take?: number;
  readonly select?: Readonly<Record<string, boolean>>;
}

interface GroupByArgs {
  readonly by: readonly string[];
  readonly where?: FindManyArgs['where'];
  readonly _max?: { readonly version: boolean };
}

class StubDrawingRevisionTable {
  readonly rows: StubRow[] = [];
  readonly findManyCalls: FindManyArgs[] = [];
  readonly groupByCalls: GroupByArgs[] = [];

  client(): PrismaClient {
    const table = this;
    return {
      drawingRevisionRecord: {
        // 桩语义：按 Prisma distinct 文档——distinct 后每值保留 orderBy 意义下
        // 的首行（drawingId asc, version desc ⇒ 每图最大 version），再 skip/take。
        async findMany(args: FindManyArgs): Promise<StubRow[]> {
          table.findManyCalls.push(args);
          let rows = table.rows.filter(
            (row) =>
              args.where === undefined ||
              (row.tenantId === args.where.tenantId &&
                (args.where.drawingId?.startsWith === undefined ||
                  row.drawingId.startsWith(args.where.drawingId.startsWith)) &&
                (args.where.drawingId?.in === undefined || args.where.drawingId.in.includes(row.drawingId)) &&
                (args.where.classification?.in === undefined ||
                  args.where.classification.in.includes(row.classification))),
          );
          if (args.distinct?.includes('drawingId')) {
            const seen = new Set<string>();
            rows = [...rows]
              .sort(
                (a, b) =>
                  a.drawingId.localeCompare(b.drawingId) ||
                  (args.orderBy?.[1]?.version === 'desc' ? b.version - a.version : a.version - b.version),
              )
              .filter((row) => {
                if (seen.has(row.drawingId)) return false;
                seen.add(row.drawingId);
                return true;
              })
              .sort((a, b) => a.drawingId.localeCompare(b.drawingId));
          }
          return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
        },
        async groupBy(args: GroupByArgs): Promise<Array<{ drawingId: string; _max?: { version: number | null } }>> {
          table.groupByCalls.push(args);
          const matching = table.rows.filter(
            (row) =>
              args.where === undefined ||
              (row.tenantId === args.where.tenantId &&
                (args.where.drawingId?.startsWith === undefined ||
                  row.drawingId.startsWith(args.where.drawingId.startsWith)) &&
                (args.where.drawingId?.in === undefined || args.where.drawingId.in.includes(row.drawingId)) &&
                (args.where.classification?.in === undefined ||
                  args.where.classification.in.includes(row.classification))),
          );
          const byDrawing = new Map<string, StubRow[]>();
          for (const row of matching) {
            const list = byDrawing.get(row.drawingId) ?? [];
            list.push(row);
            byDrawing.set(row.drawingId, list);
          }
          return [...byDrawing.entries()].map(([drawingId, list]) => ({
            drawingId,
            ...(args._max?.version === true
              ? { _max: { version: list.reduce((max, row) => Math.max(max, row.version), 0) } }
              : {}),
          }));
        },
      },
    } as unknown as PrismaClient;
  }
}

const TENANT = TenantId.create('t-pg-drawing-index');

/** 与内存/域测试同构的夹具：dwg-001 混合链 / dwg-002 全公开 / dwg-003 全受限。 */
function seed(table: StubDrawingRevisionTable): void {
  table.rows.push(
    { tenantId: TENANT, drawingId: 'dwg-001', version: 1, classification: 'public' },
    { tenantId: TENANT, drawingId: 'dwg-001', version: 2, classification: 'public' },
    { tenantId: TENANT, drawingId: 'dwg-001', version: 3, classification: 'restricted' },
    { tenantId: TENANT, drawingId: 'dwg-002', version: 1, classification: 'public' },
    { tenantId: TENANT, drawingId: 'dwg-003', version: 1, classification: 'restricted' },
    { tenantId: 't-other', drawingId: 'dwg-001', version: 1, classification: 'public' }, // 他租户
  );
}

describe('PgDrawingRevisionStore.listIndex（P1-c 桩驱动）', () => {
  it('查询形状：distinct+orderBy(drawingId,version desc)+skip/take；total 同 where；真链尾限定页内 ids', async () => {
    const table = new StubDrawingRevisionTable();
    seed(table);
    const store = new PgDrawingRevisionStore(table.client());
    const page = await store.listIndex(TENANT, {
      drawingIdPrefix: 'dwg-00',
      visibleClassifications: ['public'],
      limit: 1,
      offset: 1,
    });
    // 形状锚（findMany 主查询）
    const main = table.findManyCalls[0]!;
    expect(main.distinct).toEqual(['drawingId']);
    expect(main.orderBy).toEqual([{ drawingId: 'asc' }, { version: 'desc' }]);
    expect(main.skip).toBe(1);
    expect(main.take).toBe(1);
    expect(main.where).toMatchObject({
      tenantId: TENANT,
      drawingId: { startsWith: 'dwg-00' },
      classification: { in: ['public'] },
    });
    // total 计数查询同 where
    expect(table.groupByCalls[0]?.where).toEqual(main.where);
    // 真链尾查询：不含 classification 过滤（真链尾可能超许可）+ 限定页内 ids
    const tail = table.groupByCalls[1]!;
    expect(tail.where?.classification).toBeUndefined();
    expect(tail.where?.drawingId).toMatchObject({ in: ['dwg-002'] });
    expect(tail._max).toEqual({ version: true });
  });

  it('行映射：许可内链尾+等级+真链尾联结（status 判定数据源）；total=可见图纸数', async () => {
    const table = new StubDrawingRevisionTable();
    seed(table);
    const store = new PgDrawingRevisionStore(table.client());
    const forPublic = await store.listIndex(TENANT, { visibleClassifications: ['public'], limit: 10, offset: 0 });
    expect(forPublic.rows).toEqual([
      { drawingId: 'dwg-001', latestVisibleVersion: 2, latestVisibleClassification: 'public', tailVersion: 3 },
      { drawingId: 'dwg-002', latestVisibleVersion: 1, latestVisibleClassification: 'public', tailVersion: 1 },
    ]);
    expect(forPublic.total).toBe(2); // dwg-003 全链受限不计入（不泄漏存在性）
    const forRestricted = await store.listIndex(TENANT, {
      visibleClassifications: ['public', 'restricted'],
      limit: 10,
      offset: 0,
    });
    expect(forRestricted.rows).toEqual([
      { drawingId: 'dwg-001', latestVisibleVersion: 3, latestVisibleClassification: 'restricted', tailVersion: 3 },
      { drawingId: 'dwg-002', latestVisibleVersion: 1, latestVisibleClassification: 'public', tailVersion: 1 },
      { drawingId: 'dwg-003', latestVisibleVersion: 1, latestVisibleClassification: 'restricted', tailVersion: 1 },
    ]);
    expect(forRestricted.total).toBe(3);
  });
});
