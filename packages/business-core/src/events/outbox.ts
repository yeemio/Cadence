/**
 * Outbox 记录形状（证据标准：append-only 事件表 + Outbox）。
 * 仅定形状；投递器与存储由 business-store（M1+）实现。
 */
export interface OutboxRecord {
  readonly eventId: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly lastAttemptAt?: string;
  readonly nextAttemptAt?: string;
  /** null = 尚未送达 */
  readonly deliveredAt: string | null;
}
