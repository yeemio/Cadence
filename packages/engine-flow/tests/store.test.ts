import { describe, expect, it } from 'vitest';
import { EventId, UserId } from '@smes/business-core';
import {
  DEFAULT_APPROVAL_FLOW_CONFIG,
  createInMemoryApprovalEventStore,
  createInMemoryApprovalRecordStore,
  makeApprovalEvent,
  makeApprovalRecord,
  startApprovalFlow,
  type ApprovalEvent,
  type ApprovalRecord,
} from '../src/index.js';

const wo001 = { id: 'wo-001', type: 'workorder' };
const wo002 = { id: 'wo-002', type: 'workorder' };

function makeStoredEvent(n: number, aggregate: { id: string; type: string } = wo001): ApprovalEvent {
  return makeApprovalEvent({
    eventId: EventId.create(`evt-${String(n).padStart(3, '0')}`),
    eventType: 'smes.general-approval.v1.approved',
    // EvidenceColumns 口径：revision = payload.objectVersion = 迁移后版本
    aggregate: { ...aggregate, revision: n },
    occurredAt: '2026-10-25T10:00:00.000Z',
    payload: {
      flowId: 'general-approval',
      from: 'in_review',
      to: 'approved',
      event: 'APPROVE',
      objectVersion: n,
      actor: UserId.create('user-002'),
      reason: '对照放行标准通过',
    },
  });
}

function makeStoredRecord(n: number, reviewer = 'user-002'): ApprovalRecord {
  return makeApprovalRecord({
    reviewer: UserId.create(reviewer),
    decision: 'approve',
    reason: '对照放行标准通过',
    objectVersion: n,
    decidedAt: '2026-10-25T10:00:00.000Z',
  });
}

describe('ApprovalRecordStore（内存实现）', () => {
  it('append 后按聚合查询：append 顺序返回，条目与数组均冻结', async () => {
    const store = createInMemoryApprovalRecordStore();
    await store.append({ aggregate: wo001, record: makeStoredRecord(3) });
    await store.append({ aggregate: wo001, record: makeStoredRecord(4) });
    await store.append({ aggregate: wo002, record: makeStoredRecord(1) });

    const entries = await store.byAggregate(wo001);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.record.objectVersion)).toEqual([3, 4]);
    expect(entries[0]?.aggregate).toEqual(wo001);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0]?.aggregate)).toBe(true);

    const other = await store.byAggregate(wo002);
    expect(other).toHaveLength(1);
    expect(other[0]?.record.objectVersion).toBe(1);
  });

  it('未知聚合返回空数组；非法聚合键即抛', async () => {
    const store = createInMemoryApprovalRecordStore();
    expect(await store.byAggregate(wo001)).toEqual([]);
    await expect(store.append({ aggregate: { id: '', type: 'workorder' }, record: makeStoredRecord(1) })).rejects.toThrow(
      /aggregate key/,
    );
    await expect(store.byAggregate({ id: 'x', type: '' })).rejects.toThrow(/aggregate key/);
  });
});

describe('ApprovalEventStore（内存实现，append-only + 游标）', () => {
  it('append 后整页读回；跨聚合互不串账；nextCursor = 本页最后序号（空页才 null）', async () => {
    const store = createInMemoryApprovalEventStore();
    await store.append(makeStoredEvent(2, wo001)); // seq 1
    await store.append(makeStoredEvent(3, wo001)); // seq 2
    await store.append(makeStoredEvent(1, wo002)); // seq 3

    const page = await store.readByAggregate(wo001);
    expect(page.events.map((e) => e.payload.objectVersion)).toEqual([2, 3]);
    expect(page.nextCursor).toBe(2); // 本页最后一条的全局序号（非空页不 null）
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.events)).toBe(true);

    const other = await store.readByAggregate(wo002);
    expect(other.events.map((e) => e.payload.objectVersion)).toEqual([1]);
    expect(other.nextCursor).toBe(3);
  });

  it('游标增量读：afterCursor 只返回其后事件；游标是全局序号，跨聚合交错仍正确', async () => {
    const store = createInMemoryApprovalEventStore();
    await store.append(makeStoredEvent(1, wo001)); // seq 1（evt-001）
    await store.append(makeStoredEvent(2, wo002)); // seq 2（evt-002）
    await store.append(makeStoredEvent(3, wo001)); // seq 3（evt-003）
    await store.append(makeStoredEvent(4, wo002)); // seq 4（evt-004）

    const first = await store.readByAggregate(wo001);
    expect(first.events.map((e) => e.payload.objectVersion)).toEqual([1, 3]);
    expect(first.nextCursor).toBe(3); // 全局序号（PG bigserial 接缝）

    const after = await store.readByAggregate(wo001, { afterCursor: first.nextCursor! });
    expect(after.events).toEqual([]);
    expect(after.nextCursor).toBeNull(); // 空页 = 追平

    // 游标是全局序号：从 seq 1 之后读 wo002，得到它在 seq 2 / seq 4 的两条（seq 3 属于 wo001）
    const mixed = await store.readByAggregate(wo002, { afterCursor: 1 });
    expect(mixed.events.map((e) => e.payload.objectVersion)).toEqual([2, 4]);
    expect(mixed.nextCursor).toBe(4);
    const tail = await store.readByAggregate(wo002, { afterCursor: 3 });
    expect(tail.events.map((e) => e.payload.objectVersion)).toEqual([4]);
    expect(tail.nextCursor).toBe(4);
  });

  it('append-only 纪律：同一 eventId 重复 append 即抛，且不改变已存内容', async () => {
    const store = createInMemoryApprovalEventStore();
    const event = makeStoredEvent(2);
    await store.append(event);
    await expect(store.append(event)).rejects.toThrow(/append-only violation/);
    await expect(store.append(makeStoredEvent(2))).rejects.toThrow(/append-only violation/); // 同 eventId 重建对象同样拒绝

    const page = await store.readByAggregate(wo001);
    expect(page.events).toHaveLength(1); // 失败 append 未留痕
  });

  it('EvidenceColumns 对齐不变量：每条事件 aggregate.revision === payload.objectVersion，且随游标单调', async () => {
    const store = createInMemoryApprovalEventStore();
    for (let n = 2; n <= 5; n += 1) {
      await store.append(makeStoredEvent(n));
    }
    const page = await store.readByAggregate(wo001);
    for (const event of page.events) {
      expect(event.aggregate.revision).toBe(event.payload.objectVersion); // objectVersion=revision 口径
    }
    expect((page.nextCursor ?? 0)).toBeGreaterThan(0);
  });
});

describe('运行时账本 → 存储（端到端形状证明）', () => {
  it('跑完一段默认流后落账：事件与记录读回与运行时账本一致', async () => {
    let eventNo = 0;
    const flow = startApprovalFlow({
      config: DEFAULT_APPROVAL_FLOW_CONFIG,
      subject: { aggregate: { id: 'wo-001', type: 'workorder' }, initialObjectVersion: 1 },
      now: () => '2026-10-25T10:00:00.000Z',
      newEventId: () => EventId.create(`evt-${String((eventNo += 1)).padStart(3, '0')}`),
    });
    flow.send('SUBMIT', { by: UserId.create('user-001'), reason: '提交送审' });
    flow.send('START_REVIEW', { by: UserId.create('user-002'), reason: '开始评审' });
    flow.send('APPROVE', { by: UserId.create('user-002'), reason: '对照放行标准通过' });

    const eventStore = createInMemoryApprovalEventStore();
    const recordStore = createInMemoryApprovalRecordStore();
    for (const event of flow.events()) {
      await eventStore.append(event);
    }
    for (const record of flow.records()) {
      await recordStore.append({ aggregate: wo001, record });
    }

    const page = await eventStore.readByAggregate(wo001);
    expect(page.events).toEqual(flow.events());
    expect(page.nextCursor).toBe(3); // 3 条事件，本页最后序号
    const caughtUp = await eventStore.readByAggregate(wo001, { afterCursor: page.nextCursor! });
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.nextCursor).toBeNull(); // 轮询追平

    const entries = await recordStore.byAggregate(wo001);
    expect(entries.map((e) => e.record)).toEqual(flow.records());
  });
});
