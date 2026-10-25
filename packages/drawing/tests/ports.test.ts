import { describe, expect, expectTypeOf, it } from 'vitest';
import { TenantId, UserId, WorkOrderId } from '@smes/business-core';
import {
  DrawingChangeNoticeId,
  DrawingId,
  DrawingRevisionId,
  inMemoryDrawingStores,
  type AppendDrawingChangeNoticeInput,
  type DrawingChangeNotice,
  type DrawingChangeNoticePort,
  type DrawingChangeQuery,
  type DrawingRef,
  type DrawingRevisionRow,
  type DrawingViewer,
} from '../src/index.js';

/**
 * 端口形状（类型级）。M3 冻结合同 v1.0 §8 定稿形状：品牌化
 * DrawingId/DrawingRevisionId/DrawingChangeNoticeId（差异表 #2）、修订行含
 * 保密等级（#4）、通知端口收口为发布联动事实存储面（#1，tenant 定域 +
 * publish 返回落账行）。原 3 用例的断言意图不变（可构造可冻结 / 钉版引用 /
 * 端口异步自洽 + sinceVersion 游标），仅按定稿形状最小适配——payroll 先例。
 */
describe('drawing 端口形状（类型级）', () => {
  const tenant = TenantId.create('t-1');

  it('DrawingRevisionRow 可构造、可冻结（append-only 修订；supersedes 修正链语义）', () => {
    const v1: DrawingRevisionRow = Object.freeze({
      id: DrawingRevisionId.create('dr-1'),
      tenant,
      drawingId: DrawingId.create('dwg-2026-001'),
      version: 1,
      fileRef: 'storage://drawings/dwg-2026-001/v1.pdf',
      changeNote: '首发',
      classification: 'public',
      changedBy: UserId.create('user-1'),
      changedAt: '2026-10-01T09:00:00Z',
      supersedes: null,
      objectVersion: 1,
      auditStatus: 'published',
      createdAt: '2026-10-01T09:00:01Z',
    });
    const v2: DrawingRevisionRow = Object.freeze({
      id: DrawingRevisionId.create('dr-2'),
      tenant,
      drawingId: v1.drawingId,
      version: 2,
      fileRef: 'storage://drawings/dwg-2026-001/v2.pdf',
      changeNote: '增加 M8 孔位',
      classification: 'restricted',
      changedBy: UserId.create('user-1'),
      changedAt: '2026-10-20T15:00:00Z',
      supersedes: v1.id,
      supersedesVersion: 1,
      objectVersion: 1,
      auditStatus: 'published',
      createdAt: '2026-10-20T15:00:01Z',
    });
    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v2)).toBe(true);
    expect(v2.supersedesVersion).toBe(1);
    expect(v2.supersedes).toBe(v1.id);
    expectTypeOf(v2.changedBy).toEqualTypeOf<UserId>();
    expectTypeOf(v1.classification).toEqualTypeOf<string>();
  });

  it('DrawingRef 钉修订号：挂 v3 不随 v4 漂移；品牌化身份不可互赋', () => {
    const ref: DrawingRef = Object.freeze({ drawingId: DrawingId.create('dwg-2026-001'), version: 3 });
    expect(Object.isFrozen(ref)).toBe(true);
    expectTypeOf(ref.version).toEqualTypeOf<number>();
    // 引用是纯数据：同 drawingId 不同 version 是不同引用
    expect(ref).not.toEqual({ drawingId: ref.drawingId, version: 4 });
    // 品牌隔离：裸字符串不能当品牌化 id（编译期拦截；品牌可读作 string）
    // @ts-expect-error 裸字符串不能当 DrawingId
    const notBranded: DrawingId = 'dwg-2026-001';
    // @ts-expect-error WorkOrderId 不是 DrawingId（品牌隔离，编译期拦截）
    expectTypeOf<WorkOrderId>().toMatchTypeOf<DrawingId>();
    expect(notBranded).toBe('dwg-2026-001');
    expect(DrawingId.create('dwg-x')).toBe('dwg-x');
  });

  it('DrawingChangeNoticePort 可实现并可异步消费（内存实现自洽；sinceVersion 游标）', async () => {
    const stores = inMemoryDrawingStores();
    const port: DrawingChangeNoticePort = stores.notices;
    const drawingId = DrawingId.create('dwg-2026-001');
    const input = (fromVersion: number, toVersion: number): AppendDrawingChangeNoticeInput => ({
      tenant,
      drawingId,
      fromVersion,
      toVersion,
      changeNote: toVersion === 2 ? '增加 M8 孔位' : '孔位公差收紧',
      publishedAt: `2026-10-2${toVersion}T15:05:00Z`,
      objectVersion: 1,
      auditStatus: 'published',
    });
    const first: DrawingChangeNotice = await port.publish(input(0, 1));
    await port.publish(input(1, 2));
    await port.publish(input(2, 3));
    expectTypeOf(first.noticeId).toEqualTypeOf<DrawingChangeNoticeId>();
    expect((await port.readByDrawing(tenant, drawingId)).length).toBe(3);
    // 挂 v2 的消费方：只关心 toVersion > 2 的通知
    const query: DrawingChangeQuery = { sinceVersion: 2 };
    const fresh = await port.readByDrawing(tenant, drawingId, query);
    expect(fresh.length).toBe(1);
    expect(fresh[0]?.toVersion).toBe(3);
    expect(await port.readByDrawing(tenant, DrawingId.create('dwg-other'))).toEqual([]);
    // (tenant, drawingId, toVersion) 幂等锚点：重复落账冲突
    await expect(port.publish(input(2, 3))).rejects.toThrowError(/已落账/);
  });

  it('DrawingViewer 形状（查看者=身份+保密许可；许可值与等级同源值集）', () => {
    const viewer: DrawingViewer = Object.freeze({
      userId: UserId.create('u-tech-1'),
      clearance: 'restricted',
    });
    expect(Object.isFrozen(viewer)).toBe(true);
    expectTypeOf(viewer.userId).toEqualTypeOf<UserId>();
    expectTypeOf(viewer.clearance).toEqualTypeOf<string>();
  });
});
