/**
 * dispatch 售后报销存储端口（U5 A12，文档《售后派工》§2.4 的 Cadence 重述）。
 *
 * 体例同 dispatch-stores：端口在本包定义业务形状，内存实现先行
 * （in-memory-aftercare-claim-stores.ts），PG adapter 由 business-store 在
 * `./dispatch` 子路径追加（表结构见 prisma/migrations/*_aftercare_claim_module
 * ——组合根接线归合流）。
 *
 * 表形态取舍（对齐 dispatch_orders / outsourcing_lines 既定裁定）：报销单与
 * 报销行是**版本化运营数据**（挂售后派工单、费用可改、行身份创建即冻结），
 * 不套证据公共列、不设 append-only 触发器；域事件落既有 event_records +
 * outbox_records（经 DispatchDomainEventStore）。幂等记账复用既有
 * dispatch_operations（DispatchOperationStore）。
 *
 * 口径重述（文档 §2.4 → 本端口）：
 *  - 一单一报销：mes_after_sales_reimburse 按 dispatchOrderId 查/存 →
 *    (tenant, dispatchId) 唯一（文档「该派工单已存在报销记录，请直接编辑」）；
 *  - 明细行 = 审批通过报工 × 售后人（一人一行）→ 行按 reportId 键控
 *    （Cadence 报工单申报人单人，文档 reportId+userId 键收敛为 reportId）；
 *  - 报工日期/售后人/审批工时只读 → 行身份三快照（reportDate / worker /
 *    approvedMinutes）创建时冻结，update 只重写四费 + 备注；
 *  - 四费（食宿/交通/加班/其他）非必填、未填默认 0、有值须 ≥0 →
 *    四列 NOT NULL DEFAULT 0（整数分；合计读面计算，不落冗余列）；
 *  - 费用写入 mes_after_sales_report_worker → 独立 aftercare_claim_lines
 *    （Cadence 无报工分工表，写入面收敛本模块）。
 */
import type { TenantId, UserId } from '@smes/business-core';

// ---- 报销行（版本化数据；身份字段创建即冻结） ----

/**
 * 售后报销行：一条审批通过报工一行。身份快照（reportDate / worker /
 * approvedBy / approvedMinutes）来自报工侧事实，创建时冻结只读；四费与备注
 * 经 aftercare.claim.update 重写。
 */
export interface AftercareClaimLine {
  /** acll-<uuidv7>（模块 id 生成器；存储面按不透明串收）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly claimId: string;
  /** 行号（单内 1 起递增；同单唯一）。 */
  readonly lineNo: number;
  /** 审批通过报工（WorkReport id，跨模块 opaque；单内唯一 = 明细键）。 */
  readonly reportId: string;
  /** 报工日期快照（报工 businessTime，ISO 8601）。 */
  readonly reportDate: string;
  /** 售后人快照（报工申报人）。 */
  readonly worker: UserId;
  /** 审批人快照（报工核查人；可空）。 */
  readonly approvedBy: UserId | null;
  /** 审批工时快照（分钟；Cadence 报工单值工时，无正班/加班分列）。 */
  readonly approvedMinutes: number;
  // ---- 四类费用（分，整数精确；未填默认 0，有值 ≥0） ----
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  /** 行备注（文本，可空）。 */
  readonly remark: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---- 报销单（挂售后派工单，行级乐观版本） ----

/** 售后报销单：挂一张售后派工单（kind=aftermarket），行集随单原子落。 */
export interface AftercareClaim {
  /** acl-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 所挂售后派工单（DispatchOrder id，opaque）。 */
  readonly dispatchId: string;
  /** 单据版本：创建 = 1，每次 update +1（乐观锁口径）。 */
  readonly objectVersion: number;
  /** 明细行集（lineNo 升序）。 */
  readonly lines: readonly AftercareClaimLine[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAftercareClaimInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly dispatchId: string;
  /** 行集（原子整批；行号按序 1 起服务端赋值）。 */
  readonly lines: readonly CreateAftercareClaimLineInput[];
}

export interface CreateAftercareClaimLineInput {
  readonly id: string;
  readonly reportId: string;
  readonly reportDate: string;
  readonly worker: UserId;
  readonly approvedBy: UserId | null;
  readonly approvedMinutes: number;
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  readonly remark: string | null;
}

/** 费用重写项（aftercare.claim.update；按 reportId 键控既有行）。 */
export interface AftercareClaimFeeUpdate {
  readonly reportId: string;
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  readonly remark: string | null;
}

/**
 * 售后报销存储端口。实现方保证：
 *  - create 原子落单 + 整批行（(tenant, dispatchId) 唯一——重复报销抛
 *    DispatchConflictError；行集为空拒绝——须有审批通过报工才有行）；
 *  - find / findByDispatch 返回单 + 行集（lineNo 升序）；
 *  - updateFees 为乐观更新：仅当 objectVersion === expectedObjectVersion 时
 *    整批重写行费用/备注并 +1 版本；未命中（不存在/版本不符/updates 与既有
 *    行集不一一对应）返回 null——用例层按"存在但版本不符 → rejected 乐观锁"
 *    与"不存在 → rejected 404 语义"分叉（体例同 OutsourcingLineStore.backfillPrice）。
 */
export interface AftercareClaimStore {
  create(input: CreateAftercareClaimInput): Promise<AftercareClaim>;
  find(tenant: TenantId, id: string): Promise<AftercareClaim | null>;
  /** 按派工单取报销（一单一报销；无 = null）。 */
  findByDispatch(tenant: TenantId, dispatchId: string): Promise<AftercareClaim | null>;
  updateFees(
    tenant: TenantId,
    claimId: string,
    expectedObjectVersion: number,
    updates: readonly AftercareClaimFeeUpdate[],
  ): Promise<AftercareClaim | null>;
}

// ---- 金额合计（读面计算，不落冗余列；A5 售后成本块取数口径） ----

/** 行小计 = 四费之和（文档 §2.4.3 小计列）。 */
export function aftercareLineTotalMinor(line: AftercareClaimLine): number {
  return line.lodgingMinor + line.trafficMinor + line.overtimeMinor + line.otherMinor;
}

/** 报销合计 = 各行小计之和（文档 §2.4.3 自动合计）。 */
export function aftercareClaimTotalMinor(claim: AftercareClaim): number {
  return claim.lines.reduce((sum, line) => sum + aftercareLineTotalMinor(line), 0);
}
