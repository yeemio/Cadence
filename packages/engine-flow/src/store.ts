/**
 * 持久化端口：审批记录存储 + 审批事件存储（append-only）。
 *
 * 引擎仍是纯域、零 IO：本文件只定义端口形状（business-store 后续接 PG 的接缝）
 * 与确定性的内存实现（测试 / 单进程演示用）。**不实现 PG/Prisma**。
 *
 * 端口形态取舍：方法为异步（Promise）——PG 实现天然异步，端口按异步定形才能
 * 让 business-store 落地时不改调用方；内存实现即时 resolve，无真实 IO。
 *
 * EvidenceColumns 口径映射（architecture/contracts/evidence-columns.v1.md）——
 * 未来 PG 事件表（由 business-store 实现）各列的来源与补齐点：
 *
 * | EvidenceColumns 列     | 事件表来源                                        | 补齐点（business-store 入账时） |
 * | ---------------------- | ------------------------------------------------- | ------------------------------- |
 * | id（uuidv7）           | eventId（EventId.create，uuidv7）                 | —                               |
 * | object_version         | aggregate.revision = payload.objectVersion（迁移后版本） | —                          |
 * | business_time          | occurredAt（迁移时刻）                            | 适配层可按补录口径覆盖          |
 * | available_time         | —                                                 | 入账时补（对外可见时刻）        |
 * | provenance（JSONB）    | —                                                 | 入账时补（operationId / 命令信封摘要） |
 * | tenant_id（全表纪律）  | —                                                 | toBusinessEventInput 已固定补齐形状（events.ts） |
 * | audit_status           | 事件表不适用（业务事实表口径，合法值由领域规格定义） | —                             |
 * | supersedes             | 事件表不适用（append-only；重复 append 按 eventId 拒绝即幂等去重） | —            |
 *
 * 上述映射的可校验不变量（见 tests/store.test.ts）：
 * 1) 每条事件 aggregate.revision === payload.objectVersion（objectVersion=revision 口径）；
 * 2) 事件深冻结不可变，存储只追加从不改写；游标（ApprovalEventCursor）单调递增，
 *    内存实现取全局追加序号（1 起），映射 PG 侧 bigserial / uuidv7 时间序。
 */
import { deepFreeze } from './internal/freeze.js';
import type { ApprovalEvent } from './events.js';
import type { ApprovalRecord } from './record.js';

/** 聚合键：记录/事件归属的聚合标识（不含 revision——revision 随版本推进）。 */
export interface ApprovalAggregateKey {
  readonly id: string;
  readonly type: string;
}

function assertAggregateKey(aggregate: ApprovalAggregateKey): void {
  if (
    typeof aggregate?.id !== 'string' ||
    aggregate.id.length === 0 ||
    typeof aggregate?.type !== 'string' ||
    aggregate.type.length === 0
  ) {
    throw new Error('invalid aggregate key: id and type must be non-empty strings');
  }
}

const keyOf = (aggregate: ApprovalAggregateKey): string => `${aggregate.type}\u0000${aggregate.id}`;

// ---- 审批记录存储 ----

/** 记账条目：一条决策记录 + 它归属的聚合。 */
export interface ApprovalRecordStoreEntry {
  readonly aggregate: ApprovalAggregateKey;
  readonly record: ApprovalRecord;
}

export interface ApprovalRecordStore {
  /** 追加一条决策记录（append-only，按聚合顺序保留）。 */
  append(entry: ApprovalRecordStoreEntry): Promise<void>;
  /** 按聚合查全部决策记录（append 顺序；返回冻结数组）。 */
  byAggregate(aggregate: ApprovalAggregateKey): Promise<readonly ApprovalRecordStoreEntry[]>;
}

export function createInMemoryApprovalRecordStore(): ApprovalRecordStore {
  const byKey = new Map<string, ApprovalRecordStoreEntry[]>();
  return {
    append: async (entry) => {
      assertAggregateKey(entry?.aggregate);
      if (entry.record === null || typeof entry.record !== 'object') {
        throw new Error('invalid record store entry: record must be an ApprovalRecord object');
      }
      const key = keyOf(entry.aggregate);
      const bucket = byKey.get(key) ?? [];
      bucket.push(deepFreeze({ aggregate: deepFreeze({ ...entry.aggregate }), record: entry.record }));
      byKey.set(key, bucket);
    },
    byAggregate: async (aggregate) => {
      assertAggregateKey(aggregate);
      return Object.freeze([...(byKey.get(keyOf(aggregate)) ?? [])]);
    },
  };
}

// ---- 审批事件存储 ----

/** 游标：存储内全局追加序号（1 起，单调递增）；调用方只回传 readByAggregate 给出的游标。 */
export type ApprovalEventCursor = number;

export interface ApprovalEventPage {
  readonly events: readonly ApprovalEvent[];
  /**
   * 本页最后一条事件的全局序号；null = 本页为空（传入游标之后该聚合无新事件，即已追平）。
   * 轮询约定：持续以最近一次非空页的 nextCursor 续读，空页即歇。
   */
  readonly nextCursor: ApprovalEventCursor | null;
}

export interface ApprovalEventStore {
  /**
   * 追加一条迁移事件（append-only）。同一 eventId 重复 append 即抛——
   * 幂等去重纪律：重放/重试不得产生第二行。
   */
  append(event: ApprovalEvent): Promise<void>;
  /**
   * 按聚合游标读事件：返回该聚合中序号大于 afterCursor 的全部事件（序号升序），
   * nextCursor = 本页最后一条的序号（本页空则 null）。
   * 轮询循环：读页 → 处理 → 以 nextCursor 续读；nextCursor 为 null 即已追平。
   */
  readByAggregate(
    aggregate: ApprovalAggregateKey,
    options?: { readonly afterCursor?: ApprovalEventCursor },
  ): Promise<ApprovalEventPage>;
}

interface StoredEvent {
  readonly seq: ApprovalEventCursor;
  readonly event: ApprovalEvent;
}

export function createInMemoryApprovalEventStore(): ApprovalEventStore {
  let nextSeq: ApprovalEventCursor = 0;
  const byEventId = new Map<string, StoredEvent>();
  const byKey = new Map<string, StoredEvent[]>();
  return {
    append: async (event) => {
      if (event === null || typeof event !== 'object' || typeof event.eventId !== 'string') {
        throw new Error('invalid event store entry: expected an ApprovalEvent object');
      }
      assertAggregateKey(event.aggregate);
      if (byEventId.has(event.eventId)) {
        throw new Error(`append-only violation: eventId "${event.eventId}" is already stored`);
      }
      nextSeq += 1;
      const stored: StoredEvent = { seq: nextSeq, event };
      byEventId.set(event.eventId, stored);
      const key = keyOf(event.aggregate);
      const bucket = byKey.get(key) ?? [];
      bucket.push(stored);
      byKey.set(key, bucket);
    },
    readByAggregate: async (aggregate, options) => {
      assertAggregateKey(aggregate);
      const after = options?.afterCursor ?? 0;
      if (!Number.isInteger(after) || after < 0) {
        throw new Error('invalid afterCursor: expected a cursor previously returned by this store');
      }
      const stored = (byKey.get(keyOf(aggregate)) ?? []).filter((s) => s.seq > after);
      return deepFreeze({
        events: Object.freeze(stored.map((s) => s.event)),
        nextCursor: stored.length === 0 ? null : stored[stored.length - 1]!.seq,
      });
    },
  };
}
