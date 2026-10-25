/**
 * 离线策略纯形状测试（M5 预研，node 纯逻辑）：
 * - OfflineQueue：幂等键去重（keep-first）/ FIFO 重放顺序 / 失败保留原位重试 /
 *   序列化往返（键名约定 + 容错）/ 容量淘汰（drop-oldest）
 * - NetworkStateModel：online/offline/restored 三事件 + 订阅式 + 浏览器桥
 */
import { describe, expect, it } from 'vitest';
import {
  connectBrowserNetworkState,
  createNetworkStateModel,
  createOfflineQueue,
  hydrateOfflineQueue,
  offlineQueueStorageKey,
} from '../src/offline.js';
import type { NetworkEvent } from '../src/offline.js';

interface DraftPayload {
  readonly ref: string;
  readonly quantity: number;
}

function draft(ref: string, quantity: number): DraftPayload {
  return { ref, quantity };
}

describe('OfflineQueue：幂等键去重（keep-first）', () => {
  it('同键二次入队不重复：返回 duplicate、原始条目保留', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    const first = queue.enqueue('k1', draft('WO-1', 5));
    const second = queue.enqueue('k1', draft('WO-1', 99)); // 同键不同载荷：视为同一动作的重试
    expect(first.outcome).toBe('enqueued');
    expect(second.outcome).toBe('duplicate');
    expect(queue.size()).toBe(1);
    const pending = queue.pending();
    expect(pending[0]?.payload.quantity).toBe(5); // keep-first：首次意图保留
  });

  it('不同键正常入队；空键/含空白键抛错', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    expect(queue.size()).toBe(2);
    expect(() => queue.enqueue('', draft('WO-3', 3))).toThrow();
    expect(() => queue.enqueue('bad key', draft('WO-3', 3))).toThrow();
  });
});

describe('OfflineQueue：FIFO 顺序', () => {
  it('pending 与重放都按入队顺序', async () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    queue.enqueue('k3', draft('WO-3', 3));
    expect(queue.pending().map((item) => item.payload.ref)).toEqual(['WO-1', 'WO-2', 'WO-3']);

    const sent: string[] = [];
    const summary = await queue.replay(async (entry) => {
      sent.push(entry.payload.ref);
    });
    expect(sent).toEqual(['WO-1', 'WO-2', 'WO-3']); // FIFO 重放
    expect(summary).toEqual({ attempted: 3, done: 3, failed: 0, remaining: 0 });
    expect(queue.size()).toBe(0);
  });

  it('markDone 出队后，后来者仍保持相对顺序', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    queue.enqueue('k3', draft('WO-3', 3));
    expect(queue.markDone('k2')).toBe(true);
    expect(queue.pending().map((item) => item.key)).toEqual(['k1', 'k3']);
    expect(queue.markDone('missing')).toBe(false); // 键不存在
  });
});

describe('OfflineQueue：失败项保留重试', () => {
  it('markFailed 原位保留 + attempts 累加，不移队尾', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    expect(queue.markFailed('k1')).toBe(true);
    expect(queue.size()).toBe(2);
    expect(queue.pending()[0]).toMatchObject({ key: 'k1', attempts: 1 }); // 仍在队首
    queue.markFailed('k1');
    expect(queue.pending()[0]?.attempts).toBe(2);
    expect(queue.markFailed('missing')).toBe(false);
  });

  it('replay 遇失败即停（队头阻塞）：失败项保留、后续不动', async () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    const summary = await queue.replay(async (entry) => {
      if (entry.key === 'k1') throw new Error('network still down');
    });
    expect(summary).toEqual({ attempted: 1, done: 0, failed: 1, remaining: 2 });
    const pending = queue.pending();
    expect(pending[0]).toMatchObject({ key: 'k1', attempts: 1 });
    expect(pending[1]).toMatchObject({ key: 'k2', attempts: 0 }); // 未被尝试

    // 恢复后重放：k1 重试成功、k2 正常随后（FIFO 语义完整）
    const second = await queue.replay(async () => undefined);
    expect(second).toEqual({ attempted: 2, done: 2, failed: 0, remaining: 0 });
  });

  it('replay 期间新入队项不进本轮（seq 排后）', async () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    const seen: string[] = [];
    await queue.replay(async (entry) => {
      seen.push(entry.key);
      queue.enqueue('k-new', draft('WO-9', 9)); // 重放中新增
    });
    expect(seen).toEqual(['k1']);
    expect(queue.pending().map((item) => item.key)).toEqual(['k-new']);
  });
});

describe('OfflineQueue：序列化往返与键名约定', () => {
  it('键名约定：cadence.offline-queue.v1.<name>', () => {
    expect(offlineQueueStorageKey('report-draft')).toBe('cadence.offline-queue.v1.report-draft');
  });

  it('round-trip：载荷/顺序/attempts 全保留，seq 接续', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'report-draft' });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    queue.markFailed('k1'); // attempts=1

    const raw = queue.serialize();
    const restored = hydrateOfflineQueue<DraftPayload>(raw, { name: 'report-draft' });
    expect(restored).not.toBeNull();
    const pending = restored!.pending();
    expect(pending.map((item) => [item.key, item.payload.ref, item.attempts])).toEqual([
      ['k1', 'WO-1', 1],
      ['k2', 'WO-2', 0],
    ]);

    // 空队列也能往返；新入队 seq 接续（排序仍在旧项之后）
    restored!.enqueue('k3', draft('WO-3', 3));
    expect(restored!.pending().map((item) => item.key)).toEqual(['k1', 'k2', 'k3']);
  });

  it('容错：null/坏 JSON/信封错名/版本不符 → null；坏条目静默丢弃', () => {
    expect(hydrateOfflineQueue<DraftPayload>(null, { name: 'q' })).toBeNull();
    expect(hydrateOfflineQueue<DraftPayload>('{not json', { name: 'q' })).toBeNull();
    expect(hydrateOfflineQueue<DraftPayload>('{"v":1,"name":"other","items":[]}', { name: 'q' })).toBeNull();
    expect(hydrateOfflineQueue<DraftPayload>('{"v":2,"name":"q","items":[]}', { name: 'q' })).toBeNull();

    const mixed =
      '{"v":1,"name":"q","items":[' +
      '{"key":"good","payload":{"ref":"WO-1","quantity":1},"attempts":0,"seq":1},' +
      '{"key":"bad key","payload":1,"attempts":0,"seq":2},' +
      '{"key":"k3","payload":{"ref":"WO-3","quantity":3},"attempts":-1,"seq":3}' +
      ']}';
    const restored = hydrateOfflineQueue<DraftPayload>(mixed, { name: 'q' });
    expect(restored?.pending().map((item) => item.key)).toEqual(['good']);

    // payload 守卫不过 → 丢弃该条（守卫在 options 上注入）
    const guarded = '{"v":1,"name":"q","items":[{"key":"k","payload":"not-draft","attempts":0,"seq":1}]}';
    expect(
      hydrateOfflineQueue<DraftPayload>(guarded, {
        name: 'q',
        isPayload: (value): boolean =>
          typeof value === 'object' && value !== null && 'ref' in value && 'quantity' in value,
      })?.size(),
    ).toBe(0);
  });
});

describe('OfflineQueue：容量上限淘汰（drop-oldest）', () => {
  it('满员入队淘汰最旧，evicted 返回被淘汰项', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'q', maxItems: 2 });
    queue.enqueue('k1', draft('WO-1', 1));
    queue.enqueue('k2', draft('WO-2', 2));
    const result = queue.enqueue('k3', draft('WO-3', 3));
    expect(result.outcome).toBe('enqueued');
    expect(result.evicted).toMatchObject({ key: 'k1', payload: { ref: 'WO-1' } });
    expect(queue.pending().map((item) => item.key)).toEqual(['k2', 'k3']); // 最新动作保留
    expect(queue.has('k1')).toBe(false);
  });

  it('maxItems 非法值抛错', () => {
    expect(() => createOfflineQueue<DraftPayload>({ name: 'q', maxItems: 0 })).toThrow();
    expect(() => createOfflineQueue({ name: 'bad name' })).toThrow();
  });

  it('maxItems=1 连续淘汰：k1→k2→k3 终态只剩 k3（每次入队淘汰前一仅剩项）', () => {
    const queue = createOfflineQueue<DraftPayload>({ name: 'q', maxItems: 1 });
    const r1 = queue.enqueue('k1', draft('WO-1', 1));
    const r2 = queue.enqueue('k2', draft('WO-2', 2));
    const r3 = queue.enqueue('k3', draft('WO-3', 3));
    expect(r1.evicted).toBeNull(); // 首项入队无淘汰
    expect(r2.evicted).toMatchObject({ key: 'k1', payload: { ref: 'WO-1' } });
    expect(r3.evicted).toMatchObject({ key: 'k2', payload: { ref: 'WO-2' } });
    expect(queue.pending().map((item) => item.key)).toEqual(['k3']);
    expect(queue.has('k1')).toBe(false);
    expect(queue.has('k2')).toBe(false);
    expect(queue.size()).toBe(1);
  });
});

describe('NetworkStateModel：在线/离线/恢复事件（订阅式）', () => {
  it('初态未知：首次报告在线发布 online；在线→离线发布 offline；离线→在线发布 restored', () => {
    const model = createNetworkStateModel();
    expect(model.getState().online).toBeNull();
    const events: NetworkEvent[] = [];
    const off = model.subscribe((event) => events.push(event));

    model.reportOnline();
    model.reportOnline(); // 重复报告不发布
    model.reportOffline();
    model.reportOnline(); // 恢复
    off();
    model.reportOffline(); // 已退订：不再收到（但状态仍翻转——退订只停事件流）

    expect(events).toEqual([
      { kind: 'online', online: true },
      { kind: 'offline', online: false },
      { kind: 'restored', online: true },
    ]);
    expect(model.getState().online).toBe(false);
  });

  it('构造带初值：无首报事件，翻转语义同上', () => {
    const model = createNetworkStateModel(true);
    const events: NetworkEvent[] = [];
    model.subscribe((event) => events.push(event));
    model.reportOnline(); // 初值已在线：无事件
    model.reportOffline();
    expect(events).toEqual([{ kind: 'offline', online: false }]);
  });

  it('浏览器桥：navigator 事件驱动模型（结构注入假体）', () => {
    const listeners = new Map<string, () => void>();
    const fakeNavigator = {
      onLine: true,
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, listener);
      },
      removeEventListener(_type: string) {
        // 测试内不拆除断言
      },
    };
    const model = createNetworkStateModel();
    const events: NetworkEvent[] = [];
    model.subscribe((event) => events.push(event));
    const disconnect = connectBrowserNetworkState(model, fakeNavigator);

    expect(model.getState().online).toBe(true); // 接线对齐：首报 online
    fakeNavigator.onLine = false;
    listeners.get('offline')?.();
    fakeNavigator.onLine = true;
    listeners.get('online')?.();
    expect(events.map((event) => event.kind)).toEqual(['online', 'offline', 'restored']);
    expect(typeof disconnect).toBe('function');
  });
});
