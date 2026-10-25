/**
 * 工艺路线（RoutingId，P2）行为测试：define/revise 版本链（业务键 = 图号）、
 * 按图号查询、事件词汇（routing-revised 同族 action 判别）、守门拒绝路径。
 */
import { describe, expect, it } from 'vitest';
import { BASELINE_COMMAND_KINDS } from '../../src/baseline/baseline-input.js';
import { BASELINE_EVENT_TYPES } from '../../src/baseline/baseline-events.js';
import { committedEvents, envelope, freshOperationId, newService, t1, t2 } from './helpers.js';

const steps = [
  { processCode: 'OP-10', remark: '粗车' },
  { processCode: 'OP-20' },
  { processCode: 'OP-30', remark: null },
];

const defineRouting = (drawingNo: string, stepList = steps) =>
  envelope(BASELINE_COMMAND_KINDS.routingDefine, { drawingNo, steps: stepList });

const reviseRouting = (drawingNo: string, payload: Record<string, unknown>, expectedRevision: number) =>
  envelope(BASELINE_COMMAND_KINDS.routingRevise, { drawingNo, ...payload }, { expectedRevision, operationId: freshOperationId() });

describe('routing.define（图号维度建链）', () => {
  it('首版落账 v1 active，工序序列按位置回填 seq；事件 routing-revised(action=define)', async () => {
    const service = newService();
    const outcome = await service.execute(t1, defineRouting('DW-1001', [...steps, { processCode: 'OP-40', remark: '精磨' }]));
    // name 在 define 载荷中可选——此处显式带上以便断言
    expect(outcome.status).toBe('committed');
    const event = committedEvents(outcome)[0]!;
    expect(event.eventType).toBe(BASELINE_EVENT_TYPES.routingRevised);
    expect(event.payload).toMatchObject({ action: 'define', code: 'DW-1001', objectVersion: 1, supersedes: null });
    expect(event.aggregate).toMatchObject({ id: 'DW-1001', revision: 1 });

    const detail = await service.getRouting(t1, 'DW-1001');
    expect(detail.current.objectVersion).toBe(1);
    expect(detail.current.status).toBe('active');
    expect(detail.current.name).toBeNull();
    expect(detail.current.steps).toEqual([
      { seq: 1, processCode: 'OP-10', remark: '粗车' },
      { seq: 2, processCode: 'OP-20', remark: null },
      { seq: 3, processCode: 'OP-30', remark: null },
      { seq: 4, processCode: 'OP-40', remark: '精磨' },
    ]);
  });

  it('重复定义同图号 → rejected（已存在，请走 revise）；expectedRevision 非 initial 同拒', async () => {
    const service = newService();
    expect((await service.execute(t1, defineRouting('DW-1002', steps.slice(0, 1)))).status).toBe('committed');

    const dup = await service.execute(t1, defineRouting('DW-1002'));
    expect(dup).toMatchObject({ status: 'rejected' });
    expect((dup as { reason: string }).reason).toContain('已存在');

    const wrongRev = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.routingDefine, { drawingNo: 'DW-1003', steps }, { expectedRevision: 3 }),
    );
    expect(wrongRev).toMatchObject({ status: 'rejected' });
    expect((wrongRev as { reason: string }).reason).toContain("'initial'");
  });

  it('载荷守门：空 steps / 非法图号 / 非法工序码 → rejected（信封成立、载荷拒绝）', async () => {
    const service = newService();
    const empty = await service.execute(t1, defineRouting('DW-1004', []));
    expect(empty).toMatchObject({ status: 'rejected' });
    expect((empty as { reason: string }).reason).toContain('steps');

    const badCode = await service.execute(t1, defineRouting('图号带空格 非法'));
    expect(badCode).toMatchObject({ status: 'rejected' });

    const badStep = await service.execute(t1, defineRouting('DW-1005', [{ processCode: '带 空 格' }]));
    expect(badStep).toMatchObject({ status: 'rejected' });
  });
});

describe('routing.revise（新版本 supersedes）', () => {
  it('v1 → v2：supersedes 指向 v1 行；steps 未给沿用当前版；事件 action=revise', async () => {
    const service = newService();
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.routingDefine, { drawingNo: 'DW-2001', name: '轴加工', steps }));
    const revise = await service.execute(t1, reviseRouting('DW-2001', { name: '轴加工改' }, 1));
    expect(revise.status).toBe('committed');
    const event = committedEvents(revise)[0]!;
    expect(event.payload).toMatchObject({ action: 'revise', objectVersion: 2 });
    expect((event.payload as { supersedes: string | null }).supersedes).not.toBeNull();

    const detail = await service.getRouting(t1, 'DW-2001');
    expect(detail.current.objectVersion).toBe(2);
    expect(detail.current.name).toBe('轴加工改');
    expect(detail.current.steps).toHaveLength(3); // 未给 steps 沿用 v1 序列
    expect(detail.versions.map((v) => v.objectVersion)).toEqual([1, 2]);
    expect(detail.versions[0]!.status).toBe('superseded'); // 推导态
    expect(detail.current.status).toBe('active');
  });

  it('乐观锁：expectedRevision 落后 → rejected；不存在图号 → rejected', async () => {
    const service = newService();
    await service.execute(t1, defineRouting('DW-2002'));

    const stale = await service.execute(t1, reviseRouting('DW-2002', { steps: steps.slice(0, 2) }, 2));
    expect(stale).toMatchObject({ status: 'rejected' });
    expect((stale as { reason: string }).reason).toContain('乐观锁冲突');

    const missing = await service.execute(t1, reviseRouting('DW-NONE', {}, 1));
    expect(missing).toMatchObject({ status: 'rejected' });
    expect((missing as { reason: string }).reason).toContain('不存在');
  });

  it('查询按图号：列表当前版聚合（每图号一行）；跨租户不可见', async () => {
    const service = newService();
    await service.execute(t1, defineRouting('DW-3001'));
    await service.execute(t1, defineRouting('DW-3002', steps.slice(0, 1)));
    const list = await service.listRoutings(t1);
    expect(list.map((row) => row.code).sort()).toEqual(['DW-3001', 'DW-3002']);
    expect(await service.listRoutings(t2)).toEqual([]);
  });
});
