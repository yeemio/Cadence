/**
 * 离线策略纯形状（M5 预研；词汇纪律 ADR-0010：offline/queue/network/replay
 * 全部是 Web 通用词，非领域内核词汇，不进 business-core）。
 *
 * 两块形状，均为纯域（无浏览器 API 直连——浏览器装配经注入/适配器进来）：
 * 1. OfflineQueue<T>：离线待重放队列——幂等键去重、FIFO 重放顺序、
 *    失败项保留原位重试、localStorage 序列化往返（键名约定见
 *    offlineQueueStorageKey）、容量上限淘汰。
 * 2. NetworkStateModel：在线/离线/恢复（restored）事件流，订阅式；
 *    connectBrowserNetworkState 把 navigator 事件桥进模型（结构注入，可测）。
 *
 * 语义取舍（写明）：
 * - 幂等键 keep-first：同键二次入队不重复、不覆盖——首次入队代表原始意图，
 *   重复入队视为同一动作的设备/用户重试（返回 'duplicate' 供 UI 提示）。
 * - 重放严格 FIFO、队头阻塞：replay 按入队顺序逐条发送，遇失败即停
 *   （后到的上报可能依赖先到的结果，乱序重放语义风险大于吞吐损失；
 *   跳过失败项续放是 M5 正式线的备选策略，此处不实现）。
 * - 失败保留原位：markFailed 不移到队尾——重试保持原始顺序语义，
 *   只累加 attempts 计数。
 * - 容量淘汰 drop-oldest：队列满时淘汰等待最久的项（最旧项陈旧风险最高，
 *   现场最新动作优先保留）；被淘汰项经 enqueue 返回值 evicted 交还调用方，
 *   由装配层决定如何提示用户。
 * - 序列化容错：整包非法/信封名不匹配 → hydrate 返回 null（调用方回退新
 *   队列）；条目级非法（键/attempts/seq/payload 形状不过守卫）静默丢弃——
 *   与 token-session「损坏内容一律读作空」先例同向，但保留合法条目。
 */
// ---------------------------------------------------------------------------
// OfflineQueue<T>（泛型队列；payload 形状由组合根代入）
// ---------------------------------------------------------------------------

/** 队列条目：幂等键 + 载荷 + 重试计数 + FIFO 序号。 */
export interface OfflineQueueEntry<T> {
  /** 幂等键（调用方生成——同键即同一动作，重放端据此去重）。 */
  readonly key: string;
  readonly payload: T;
  /** 已重放失败次数（首次入队为 0）。 */
  readonly attempts: number;
  /** 入队序号（队列内单调递增；hydrate 后接续已存最大序号）。 */
  readonly seq: number;
}

export type EnqueueOutcome = 'enqueued' | 'duplicate';

export interface EnqueueResult<T> {
  readonly outcome: EnqueueOutcome;
  /** 容量淘汰的牺牲项（drop-oldest；未淘汰为 null）。 */
  readonly evicted: OfflineQueueEntry<T> | null;
}

export interface ReplaySummary {
  /** 本次尝试发送的条数（含失败那一条）。 */
  readonly attempted: number;
  /** 发送成功出队的条数。 */
  readonly done: number;
  /** 是否因失败中止（严格 FIFO 队头阻塞，至多 1）。 */
  readonly failed: number;
  /** 重放结束后仍留在队列中的条数。 */
  readonly remaining: number;
}

export interface OfflineQueueOptions {
  /** 队列名（序列化键名的作用域段 + 信封校验；同存储槽不同名视为损坏）。 */
  readonly name: string;
  /** 容量上限，默认 100（超出淘汰最旧）。 */
  readonly maxItems?: number;
  /** hydrate 时的 payload 形状守卫（缺省接受任意 JSON 值）。 */
  readonly isPayload?: (value: unknown) => boolean;
}

export interface OfflineQueue<T> {
  /** 入队（幂等键去重 keep-first；满员 drop-oldest）。 */
  enqueue(key: string, payload: T): EnqueueResult<T>;
  /** 待重放清单（按 seq 的 FIFO 副本，可直接进 React state）。 */
  pending(): readonly OfflineQueueEntry<T>[];
  size(): number;
  has(key: string): boolean;
  /** 重放成功出队；键不存在返回 false。 */
  markDone(key: string): boolean;
  /** 重放失败保留原位（attempts + 1）；键不存在返回 false。 */
  markFailed(key: string): boolean;
  /**
   * 严格 FIFO 重放：逐条 await send；成功 markDone 出队，失败 markFailed
   * 保留后即停（队头阻塞，取舍见文件头）。send 抛错即该条失败。
   */
  replay(send: (entry: OfflineQueueEntry<T>) => Promise<void>): Promise<ReplaySummary>;
  /** 序列化为 localStorage 字符串（信封 {v,name,items}）。 */
  serialize(): string;
}

const DEFAULT_MAX_ITEMS = 100;
const SNAPSHOT_VERSION = 1;

/** localStorage 键名约定：`cadence.offline-queue.v1.<name>`（对齐会话键风格）。 */
export const OFFLINE_QUEUE_STORAGE_KEY_PREFIX = 'cadence.offline-queue.v1';

export function offlineQueueStorageKey(name: string): string {
  return `${OFFLINE_QUEUE_STORAGE_KEY_PREFIX}.${name}`;
}

function isValidKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

function sortBySeq<T>(list: readonly OfflineQueueEntry<T>[]): OfflineQueueEntry<T>[] {
  return [...list].sort((a, b) => a.seq - b.seq);
}

/** 模块内受信构造路径（hydrate 用）：条目已过形状校验，直接重建内部态。 */
function buildQueue<T>(options: OfflineQueueOptions, initial: readonly OfflineQueueEntry<T>[]): OfflineQueue<T> {
  const name = options.name;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  if (!isValidKey(name)) {
    throw new Error('invalid offline queue: name must be a non-empty string without whitespace');
  }
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error('invalid offline queue: maxItems must be an integer >= 1');
  }

  let items: OfflineQueueEntry<T>[] = sortBySeq(initial);
  let nextSeq = items.reduce((max, item) => Math.max(max, item.seq), 0) + 1;

  function markFailedInPlace(key: string): boolean {
    let found = false;
    items = items.map((item) => {
      if (item.key !== key) return item;
      found = true;
      return { ...item, attempts: item.attempts + 1 }; // 原位保留，只累加计数
    });
    return found;
  }

  function markDoneByKey(key: string): boolean {
    if (!items.some((item) => item.key === key)) return false;
    items = items.filter((item) => item.key !== key);
    return true;
  }

  return {
    enqueue(key: string, payload: T): EnqueueResult<T> {
      if (!isValidKey(key)) {
        throw new Error('invalid offline queue: idempotency key must be non-empty without whitespace');
      }
      if (items.some((item) => item.key === key)) {
        return { outcome: 'duplicate', evicted: null }; // keep-first：原始意图保留
      }
      const entry: OfflineQueueEntry<T> = { key, payload, attempts: 0, seq: nextSeq++ };
      let evicted: OfflineQueueEntry<T> | null = null;
      if (items.length >= maxItems) {
        const oldest = items[0]; // 内部态恒按 seq 有序，队首即最旧
        if (oldest !== undefined) {
          items = items.slice(1);
          evicted = oldest;
        }
      }
      items = [...items, entry];
      return { outcome: 'enqueued', evicted };
    },
    pending(): readonly OfflineQueueEntry<T>[] {
      return Object.freeze(items.map((item) => Object.freeze({ ...item })));
    },
    size(): number {
      return items.length;
    },
    has(key: string): boolean {
      return items.some((item) => item.key === key);
    },
    markDone: markDoneByKey,
    markFailed: markFailedInPlace,
    async replay(send: (entry: OfflineQueueEntry<T>) => Promise<void>): Promise<ReplaySummary> {
      let attempted = 0;
      let done = 0;
      // 快照迭代 + 队内标记——replay 期间新入队项 seq 更大天然排后，不进本轮
      for (const entry of [...items]) {
        attempted += 1;
        try {
          await send(entry);
        } catch {
          markFailedInPlace(entry.key);
          return { attempted, done, failed: 1, remaining: items.length };
        }
        markDoneByKey(entry.key);
        done += 1;
      }
      return { attempted, done, failed: 0, remaining: items.length };
    },
    serialize(): string {
      return JSON.stringify({
        v: SNAPSHOT_VERSION,
        name,
        items: items.map((item) => ({
          key: item.key,
          payload: item.payload,
          attempts: item.attempts,
          seq: item.seq,
        })),
      });
    },
  };
}

export function createOfflineQueue<T>(options: OfflineQueueOptions): OfflineQueue<T> {
  return buildQueue(options, []);
}

/**
 * 序列化往返：null/整包非法/信封名不匹配/版本不符 → null（调用方回退新队列）；
 * 条目级非法（键/attempts/seq/payload 形状不过守卫）静默丢弃。
 */
export function hydrateOfflineQueue<T>(
  raw: string | null,
  options: OfflineQueueOptions,
): OfflineQueue<T> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as { v?: unknown; name?: unknown; items?: unknown };
  if (envelope.v !== SNAPSHOT_VERSION) return null;
  if (envelope.name !== options.name) return null;
  if (!Array.isArray(envelope.items)) return null;

  const entries: OfflineQueueEntry<T>[] = [];
  for (const value of envelope.items) {
    if (typeof value !== 'object' || value === null) continue;
    const item = value as Record<string, unknown>;
    if (!isValidKey(item['key'])) continue;
    const attempts = item['attempts'];
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) continue;
    const seq = item['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) continue;
    if (options.isPayload !== undefined && !options.isPayload(item['payload'])) continue;
    entries.push({ key: item['key'], payload: item['payload'] as T, attempts, seq });
  }
  // 条目已过形状校验（含 seq 单调可排序），经受信构造路径重建
  return buildQueue(options, sortBySeq(entries));
}

// ---------------------------------------------------------------------------
// 网络状态模型（订阅式事件流：online / offline / restored）
// ---------------------------------------------------------------------------

/**
 * 事件三态（三种 kind 都可达）：
 * - 'online'：初态未知（构造未给初值）时首次报告在线——无恢复语义；
 * - 'offline'：由在线转离线；
 * - 'restored'：离线 → 在线的恢复转换（重放提示的触发事件）。
 */
export type NetworkEventKind = 'online' | 'offline' | 'restored';

export interface NetworkEvent {
  readonly kind: NetworkEventKind;
  /** 事件后的在线态。 */
  readonly online: boolean;
}

export interface NetworkSnapshot {
  /** null = 未知（构造未给初值且尚无报告）。 */
  readonly online: boolean | null;
}

export interface NetworkStateModel {
  getState(): NetworkSnapshot;
  /** 订阅转换事件（仅在状态真正翻转时发布；重复报告不发布）。 */
  subscribe(listener: (event: NetworkEvent) => void): () => void;
  reportOnline(): void;
  reportOffline(): void;
}

/** 初值可省（省略 = 未知态，首次报告在线发布 'online' 事件）。 */
export function createNetworkStateModel(initialOnline?: boolean): NetworkStateModel {
  let online: boolean | null = initialOnline ?? null;
  const listeners = new Set<(event: NetworkEvent) => void>();

  function report(nextOnline: boolean): void {
    if (online === nextOnline) return; // 幂等：重复报告不发布事件
    const kind: NetworkEventKind = online === false ? 'restored' : online === null ? 'online' : 'offline';
    online = nextOnline;
    const event: NetworkEvent = { kind, online };
    for (const listener of [...listeners]) listener(event);
  }

  return {
    getState: () => ({ online }),
    subscribe(listener: (event: NetworkEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportOnline(): void {
      report(true);
    },
    reportOffline(): void {
      report(false);
    },
  };
}

/** navigator 的结构子集（可注入假体；浏览器装配传 navigator 即可）。 */
export interface BrowserNetworkSource {
  readonly onLine: boolean;
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

/**
 * 浏览器桥：navigator online/offline 事件 → 模型报告。接线时会先做一次
 * 对齐（与构造初值不一致即发布一次转换事件）。返回拆除函数。
 */
export function connectBrowserNetworkState(
  model: NetworkStateModel,
  source: BrowserNetworkSource,
): () => void {
  const sync = (): void => {
    if (source.onLine) {
      model.reportOnline();
    } else {
      model.reportOffline();
    }
  };
  sync();
  source.addEventListener('online', sync);
  source.addEventListener('offline', sync);
  return () => {
    source.removeEventListener('online', sync);
    source.removeEventListener('offline', sync);
  };
}
