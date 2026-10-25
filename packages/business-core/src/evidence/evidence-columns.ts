/**
 * 证据标准公共列（architecture/contracts/evidence-columns.v1.md）。
 *
 * 每张业务事实表都带这组列；供 append-only 事件表、审计与
 * /connect/v1 只读连接器（integration-connect，OwlCodaE 消费）统一口径。
 *
 * 注意：auditStatus 的合法值集合由各领域规格（M2 清洁室产出）定义，
 * 本包不预设枚举——不从现系统抄字段口径（ADR-0002）。
 */
export interface EvidenceColumns {
  /** uuidv7 主键（时间有序） */
  readonly id: string;
  /** 乐观锁版本，>= 1；CommandEnvelope.expectedRevision 对账的锚点 */
  readonly objectVersion: number;
  /** 审核状态；合法值由领域规格定义 */
  readonly auditStatus: string;
  /** JSONB 溯源（operationId、命令信封摘要、来源系统等） */
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** 本记录取代的前任记录 id（append-only 修正链） */
  readonly supersedes?: string;
  /** 业务时间（可补录） */
  readonly businessTime?: string;
  /** 可用时间（对账 / 连接器口径） */
  readonly availableTime?: string;
}
