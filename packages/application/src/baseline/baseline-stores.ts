/**
 * baseline 存储端口（M2-W2 P1 + M2-W7 P2/P3 件；体例同 masterdata-stores：端口
 * 在本包定义业务形状，内存实现先行（in-memory-baseline-stores.ts），PG adapter
 * 由 business-store 按 `./baseline` 子路径接入）。
 *
 * 表形态取舍（与 M1 各表对照，依据 evidence-columns.v1 + m2-drafts README 纪律 2
 * "全部业务表带公共列"）：
 *  - 四对象是**版本化主数据**：带完整证据公共列 + supersedes 自引用修正链 +
 *    append-only 触发器（对齐 work_order_records 的体例）——与 items/resources
 *    那类"可改行"配置主数据不同：版本不可变、修正只能加新版本行；
 *  - 物料校验运行（material validation run）是**执行事实**：单行落账（v1、
 *    无修正链），行内 JSON 载荷存逐行判定；事件另落事件表；
 *  - baseline_command_operations 是**幂等账本**（运营表，非业务事实）：
 *    smes.command.v1 不变量 3（operationId 已落账拒绝重复执行）的持久化锚点，
 *    同 outbox 一类不套证据列/触发器。
 *
 * 端口合同（实现方保证）：
 *  - insert 在 (tenant, code, objectVersion) 唯一冲突时抛 BaselineConflictError
 *    （并发同版本写入竞态的唯一防线）；validationRun.insert 在 id 重复时抛同错；
 *  - id 与 createdAt 由**实现方生成**（PG=uuidv7/库时钟，内存=唯一串/本地时钟），
 *    调用方不传——行 id 在 insert 返回值里回给服务层；
 *  - 全部读操作按租户收口（跨租户不可见）。
 */
import type { BusinessEvent, TenantId } from '@smes/business-core';
import type { MaterialLineJudgment, MaterialValidationSummary } from './material-validation.js';
import type { VersionedMasterFields } from './baseline-versioning.js';
import type { FaultReportId } from './baseline-ids.js';

// ---- 版本化主数据行（P1 三表） ----

/** 工序（ProcessDef）版本行——机加工序库，派工引用（按 code）。 */
export interface ProcessDefRow extends VersionedMasterFields {
  readonly name: string;
  /** 工序分类（自由文本，可空；行业词只进数据不进代码，ADR-0010）。 */
  readonly category: string | null;
  readonly description: string | null;
}

/** 设备台账（EquipmentRecord）版本行。 */
export interface EquipmentRow extends VersionedMasterFields {
  readonly name: string;
  /** 设备类型/型号（自由文本，可空）。 */
  readonly type: string | null;
  /** 位置/所属工段（自由文本，可空）。 */
  readonly location: string | null;
}

/** 外协计价规则版本行（工序单价 × 利润率）。 */
export interface OutsourcingPriceRuleRow extends VersionedMasterFields {
  /** 规则名（可空，人读备注性质）。 */
  readonly name: string | null;
  /** 计价工序的业务码（引用 ProcessDef.code；跨模块引用走业务码，不落外键）。 */
  readonly processCode: string;
  /** 工序单价（分，整数精确；见 outsourcing-price.ts 量纲域）。 */
  readonly unitPriceMinor: number;
  /** 利润率（万分比整数，1500=15%）。 */
  readonly marginPermyriad: number;
}

/** 创建输入（无 id/objectVersion/supersedes——由服务层与实现方组装）。 */
export interface CreateProcessDefInput extends Omit<ProcessDefRow, 'id' | 'tenant' | 'objectVersion' | 'supersedes' | 'createdAt'> {
  readonly tenant: TenantId;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

export interface CreateEquipmentInput extends Omit<EquipmentRow, 'id' | 'tenant' | 'objectVersion' | 'supersedes' | 'createdAt'> {
  readonly tenant: TenantId;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

export interface CreateOutsourcingPriceRuleInput
  extends Omit<OutsourcingPriceRuleRow, 'id' | 'tenant' | 'objectVersion' | 'supersedes' | 'createdAt'> {
  readonly tenant: TenantId;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

/**
 * 版本化主数据存储端口（三表同形状）。versions 返回该业务码全部版本行
 * （升序由实现方保证）；listAll 返回全部行（服务层推导当前版与有效态）。
 */
export interface ProcessDefStore {
  insert(input: CreateProcessDefInput): Promise<ProcessDefRow>;
  versions(tenant: TenantId, code: string): Promise<readonly ProcessDefRow[]>;
  listAll(tenant: TenantId): Promise<readonly ProcessDefRow[]>;
}

export interface EquipmentStore {
  insert(input: CreateEquipmentInput): Promise<EquipmentRow>;
  versions(tenant: TenantId, code: string): Promise<readonly EquipmentRow[]>;
  listAll(tenant: TenantId): Promise<readonly EquipmentRow[]>;
}

export interface OutsourcingPriceRuleStore {
  insert(input: CreateOutsourcingPriceRuleInput): Promise<OutsourcingPriceRuleRow>;
  versions(tenant: TenantId, code: string): Promise<readonly OutsourcingPriceRuleRow[]>;
  listAll(tenant: TenantId): Promise<readonly OutsourcingPriceRuleRow[]>;
}

// ---- 版本化主数据行（P2/P3 件：工艺路线 + 额定工时，M2-W7） ----

/** 工艺路线工序步（零件×工序序列的原子行；seq 由载荷数组位置回填 1 起单调）。 */
export interface RoutingStep {
  /** 工序顺序（1 起）。 */
  readonly seq: number;
  /** 工序业务码（引用 ProcessDef.code；跨模块引用走业务码，不落外键）。 */
  readonly processCode: string;
  /** 工步备注（可空）。 */
  readonly remark: string | null;
}

/**
 * 工艺路线（Routing）版本行（合同 §2：零件×工序序列，图号维度）。
 * 业务键 code = 图号——租户内一张图纸一条版本链（(tenant, code, objectVersion)
 * 唯一即同图号版本唯一），"按图号查工艺路线"直落 versions/get 读路径。
 */
export interface RoutingRow extends VersionedMasterFields {
  /** 路线名（可空，人读备注性质）。 */
  readonly name: string | null;
  /** 工序序列（载荷 JSONB；非空、seq 严格递增——载荷层解析守门）。 */
  readonly steps: readonly RoutingStep[];
}

export interface CreateRoutingInput
  extends Omit<RoutingRow, 'id' | 'tenant' | 'objectVersion' | 'supersedes' | 'createdAt'> {
  readonly tenant: TenantId;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

/** 额定工时对标维度（合同 §3 查询口径：额定工时按工序/产品）。 */
export type StandardTimeScope = 'process' | 'product';

/**
 * 额定工时（StandardTime）版本行（合同 §2：工序/产品标准工时+预备工时额度，P3）。
 * 量纲 = 秒整数（全程整数精确，无浮点误差；供 hours 对标端口消费——形状见
 * baseline-ports.ts StandardTimeBenchmark）。targetCode 跨维度引用工序码或
 * 产品图号（业务码引用，不落外键）。
 */
export interface StandardTimeRow extends VersionedMasterFields {
  /** 对标维度：process=按工序 / product=按产品（图号）。 */
  readonly scope: StandardTimeScope;
  /** 对标目标业务码（工序码或产品图号）。 */
  readonly targetCode: string;
  /** 每件标准工时（秒，正整数）。 */
  readonly standardSeconds: number;
  /** 每批/每任务预备工时额度（秒，非负整数，缺省 0）。 */
  readonly preparationSeconds: number;
}

export interface CreateStandardTimeInput
  extends Omit<StandardTimeRow, 'id' | 'tenant' | 'objectVersion' | 'supersedes' | 'createdAt'> {
  readonly tenant: TenantId;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

/** P2/P3 版本化主数据存储端口（同 P1 三端口形状）。 */
export interface RoutingStore {
  insert(input: CreateRoutingInput): Promise<RoutingRow>;
  versions(tenant: TenantId, code: string): Promise<readonly RoutingRow[]>;
  listAll(tenant: TenantId): Promise<readonly RoutingRow[]>;
}

export interface StandardTimeStore {
  insert(input: CreateStandardTimeInput): Promise<StandardTimeRow>;
  versions(tenant: TenantId, code: string): Promise<readonly StandardTimeRow[]>;
  listAll(tenant: TenantId): Promise<readonly StandardTimeRow[]>;
}

// ---- 物料校验运行（执行事实） ----

/** 校验运行行（一次 material.validate 命令的完整判定账）。 */
export interface MaterialValidationRunRow {
  /** 运行 id（由实现方生成；事件聚合锚点）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 发起人（命令信封 issuedBy）。 */
  readonly issuedBy: string;
  readonly createdAt: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly summary: MaterialValidationSummary;
  readonly lines: readonly MaterialLineJudgment[];
}

/** 运行列表视图（不含逐行判定载荷）。 */
export type MaterialValidationRunSummaryView = Omit<MaterialValidationRunRow, 'lines'>;

export interface MaterialValidationRunStore {
  insert(run: Omit<MaterialValidationRunRow, 'id' | 'createdAt'>): Promise<MaterialValidationRunRow>;
  get(tenant: TenantId, runId: string): Promise<MaterialValidationRunRow | null>;
  /** 按创建时刻降序（新的在前，与既有列表端点同序）。 */
  list(tenant: TenantId): Promise<readonly MaterialValidationRunSummaryView[]>;
}

// ---- 故障单投影行（P2：状态机驱动，体例同 inspection 投影） ----

/**
 * 故障单（FaultReport）投影行（合同 §2：异常/停机上报→推送维修）。投影而非
 * 事实表：state 随 ASSIGN/RESOLVE/REJECT 迁移 UPDATE，advance 带乐观版本检查
 * （重放事实源 = engine-flow 机器事件账本，service 侧重放对账——体例同
 * inspection 的 inspections 表取舍）。
 */
export interface FaultReport {
  /** 投影行 id（fr-<uuidv7>，service 侧生成）。 */
  readonly id: FaultReportId;
  readonly tenant: TenantId;
  /** 状态机配置标识（engine-flow config.flowId）。 */
  readonly flowConfigId: string;
  /** 当前状态 id（open/assigned/resolved）。 */
  readonly state: string;
  /** 状态机版本：创建 = 1（open），每次成功迁移 +1（ASSIGN→2、RESOLVE→3）。 */
  readonly objectVersion: number;
  /** 故障设备业务码（引用 equipment_records.code；业务码挂接，不落外键）。 */
  readonly equipmentCode: string;
  /** 故障描述（上报留痕）。 */
  readonly description: string;
  /** 上报人（命令信封 issuedBy）。 */
  readonly reportedBy: string;
  /** 维修人员（assigned 起非空；open 态 null）。 */
  readonly assignee: string | null;
  readonly assignedAt: string | null;
  /** 闭环备注（resolved 起可非空）。 */
  readonly resolutionRemark: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateFaultReportInput {
  readonly tenant: TenantId;
  readonly id: FaultReportId;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly equipmentCode: string;
  readonly description: string;
  readonly reportedBy: string;
}

export interface ListFaultReportsFilter {
  /** 状态精确过滤（可选；维修队列键）。 */
  readonly state?: string | undefined;
}

/** advance 随迁移回填的字段（report/resolve 各写所需）。 */
export interface FaultReportAdvanceExtra {
  readonly assignee?: string;
  readonly assignedAt?: string;
  readonly resolutionRemark?: string | null;
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
}

/**
 * 故障单投影存储端口（合同同 NonconformStore：租户收口 + 乐观 advance +
 * createdAt 降序列表新的在前）。create 同租户同 id 冲突 → BaselineConflictError。
 */
export interface FaultReportStore {
  create(input: CreateFaultReportInput): Promise<FaultReport>;
  find(tenant: TenantId, id: FaultReportId): Promise<FaultReport | null>;
  list(tenant: TenantId, filter?: ListFaultReportsFilter): Promise<readonly FaultReport[]>;
  advance(
    tenant: TenantId,
    id: FaultReportId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: FaultReportAdvanceExtra,
  ): Promise<FaultReport>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * baseline 事件端口：append = 事件行 + Outbox 行**同事务**落账（PG 实现方合同；
 * 内存实现仅保序保存）。幂等锚点 = eventId 自然主键（重复 append 抛 BaselineConflictError）。
 */
export interface BaselineEventStore {
  append(event: BusinessEvent): Promise<void>;
  /** 按租户读全部事件（occurredAt 升序；测试与审计口径，非对账主路径）。 */
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/**
 * 命令幂等账本（smes.command.v1 不变量 3）：claim 返回 true = 首次落账，
 * false = 该 operationId 已执行过（调用方拒绝重复执行，不重试同信封）。
 */
export interface BaselineOperationLedger {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（BaselineService 构造入参形状；P2/P3 件追加三存储）。 */
export interface BaselineStores {
  readonly processes: ProcessDefStore;
  readonly equipment: EquipmentStore;
  readonly outsourcingRules: OutsourcingPriceRuleStore;
  readonly validationRuns: MaterialValidationRunStore;
  readonly events: BaselineEventStore;
  readonly operations: BaselineOperationLedger;
  /** 工艺路线版本链存储（P2）。 */
  readonly routings: RoutingStore;
  /** 额定工时版本链存储（P3）。 */
  readonly standardTimes: StandardTimeStore;
  /** 故障单投影存储（P2）。 */
  readonly faultReports: FaultReportStore;
}
