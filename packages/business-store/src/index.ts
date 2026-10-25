/**
 * @smes/business-store —— PostgreSQL 16 + Prisma 存储基座（M1 增量 2-A）。
 *
 * 公共面：uuidv7 生成、证据公共列构造器（ISO↔Date 唯一换算点）、
 * WorkOrderRecord 构造（证据列复用模式首个消费者）、BusinessEvent ↔ 事件表行映射、
 * Outbox 行构造、append-only 写门。
 *
 * PrismaClient 装配不在本模块（后续增量接入组合根时落地）；本包 src 不 import
 * @prisma/client——typecheck/test 不依赖 prisma generate 或活库。
 */

// ---- id 生成（PG 无内建 uuidv7；应用侧权威生成） ----
export { uuidv7, isUuid, isUuidv7 } from './ids/uuidv7.js';

// ---- 证据标准公共列（contracts/evidence-columns.v1.md） ----
export {
  buildEvidenceColumns,
  fromEvidenceRow,
} from './evidence/evidence-columns.js';
export type {
  EvidenceColumnsRow,
  EvidenceColumnsInput,
} from './evidence/evidence-columns.js';

// ---- 示例事实表：WorkOrderRecord（ADR-0010 通用词汇） ----
export {
  buildWorkOrderRecordCreate,
  workOrderRecordScope,
} from './evidence/work-order-record.js';
export type {
  WorkOrderRecordRow,
  WorkOrderRecordInput,
} from './evidence/work-order-record.js';

// ---- 事件表行映射（BusinessEvent 载荷） ----
export { toBusinessEventRow, fromBusinessEventRow } from './events/event-row.js';
export type { BusinessEventRow } from './events/event-row.js';

// ---- Outbox ----
export { initialOutboxRow, toOutboxRecord } from './events/outbox-row.js';
export type { OutboxRow } from './events/outbox-row.js';

// ---- append-only 纪律（应用层写门） ----
export { asAppendOnly, nextObjectVersion } from './append-only/append-only.js';
export type { AppendOnlyDelegate } from './append-only/append-only.js';
