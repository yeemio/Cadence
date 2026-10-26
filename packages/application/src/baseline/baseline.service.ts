/**
 * BaselineService —— 技术准备用例编排（M2-W2 P1：工序库 / 物料校验执行 /
 * 外协计价规则 / 设备台账；M2-W7 P2/P3 件：工艺路线 / 额定工时 / 故障上报 /
 * 下图统计事实）。零框架业务类（不 import @nestjs/*）。
 *
 * 写路径 = smes.command.v1 命令执行（结果三分 CommittedOutcome/RejectedOutcome/
 * IndeterminateOutcome）：
 *  - 幂等（口径统一：先解析校验后记账，同 reporting）：载荷解析与业务校验
 *    全部通过后、首个持久写之前 claim operationId（不变量 3）——被拒命令不
 *    占用 id，同 id 修正重发可重新评估；committed 后同 id 重发被拒；
 *  - 乐观锁：expectedRevision 与目标业务码当前 objectVersion 不符 → rejected（不变量 2）；
 *  - 落账顺序：版本行/事实行 → 事件（+Outbox）。行已落而事件追加失败的窗口返回
 *    indeterminate(retrySafe=false)（不自动重试，人工对账——中断窗口取舍同
 *    approval 的"投影先行、账本紧随"，见 approval.service.ts 文件头）；
 *  - 并发竞态（唯一约束冲突）→ rejected：此时 operationId 已 claim，须换新
 *    operationId 重发。
 *
 * 故障单（P2）走 engine-flow 状态机（配置注入可整体替换，ADR-0010 条 2）：
 * 落账顺序 = 建 open 投影 → 机器事件（ASSIGN/RESOLVE）→ 投影乐观推进 →
 * 域事件发布（FaultReported → 待办+IM / FaultResolved → 消待办）——机器账本
 * 是重放事实源，重放结果与投影行不一致即数据级冲突（BaselineConflictError），
 * 体例同 inspection.service.ts。
 *
 * 读路径 = 版本化主数据当前版视图（draft/active 落库值 + superseded 推导态）。
 *
 * 跨模块端口（模块间只经端口互调，m2-drafts README 纪律 6）：
 *  - OutsourcingPriceLookup：dispatch 外协派工实时取价（对账锚点：
 *    price = unit × (1 + margin)，outsourcing-price.ts 纯函数）；
 *  - MaterialValidationExecutor：listing 发起物料校验（构造命令信封后调 execute；
 *    权限码最小集无 material-validation 写码——执行走端口不经 HTTP，见合同 §5）；
 *  - StandardTimeLookup：hours 额定工时对标取数（M2-W7；形状见 baseline-ports.ts）。
 */
import type { BusinessEvent, CommandOutcome, TenantId } from '@smes/business-core';
import { UserId } from '@smes/business-core';
import {
  createInMemoryApprovalEventStore,
  startApprovalFlow,
  type ApprovalEventStore,
  type ApprovalFlowConfig,
  type ApprovalFlowRuntime,
} from '@smes/engine-flow';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoItem, TodoStore } from '../workbench/workbench-stores.js';
import { NOOP_NOTIFY_CHANNEL, type NotifyChannel } from '../inspection/inspection-ports.js';
import { BaselineConflictError, BaselineInputError, BaselineNotFoundError } from './baseline-errors.js';
import {
  BASELINE_AGGREGATE_TYPES,
  makeEquipmentRegisteredEvent,
  makeFaultReportedEvent,
  makeFaultResolvedEvent,
  makeMaterialValidatedEvent,
  makeOutsourcingRuleSetEvent,
  makeProcessDefinedEvent,
  makeRoutingRevisedEvent,
  makeStandardTimeDefinedEvent,
  type BaselineProvenance,
} from './baseline-events.js';
import { FaultReportId, isBaselineUuidLiteral, newFaultReportId } from './baseline-ids.js';
import {
  BASELINE_COMMAND_KINDS,
  parseEquipmentRegisterPayload,
  parseEquipmentRevisePayload,
  parseFaultReportPayload,
  parseFaultResolvePayload,
  parseMaterialValidatePayload,
  parseOutsourcingRuleSetPayload,
  parseOutsourcingRuleRevisePayload,
  parseProcessDefinePayload,
  parseProcessRevisePayload,
  parseRoutingDefinePayload,
  parseRoutingRevisePayload,
  parseStandardTimeDefinePayload,
  type BaselineCommandEnvelope,
} from './baseline-input.js';
import type { ItemStore } from '../masterdata/masterdata-stores.js';
import {
  DEFAULT_MATERIAL_VALIDATION_THRESHOLDS,
  validateMaterialLines,
  type MaterialValidationThresholds,
} from './material-validation.js';
import {
  decimalToMinor,
  pickActiveRuleForProcess,
  quoteOutsourcingRule,
  type OutsourcingPriceQuote,
} from './outsourcing-price.js';
import type {
  BaselineStores,
  EquipmentRow,
  FaultReport,
  MaterialValidationRunRow,
  MaterialValidationRunSummaryView,
  OutsourcingPriceRuleRow,
  ProcessDefRow,
  RoutingRow,
  StandardTimeRow,
} from './baseline-stores.js';
import {
  BASELINE_AUDIT_STATUS_UNAUDITED,
  currentVersion,
  effectiveStatus,
  isSuperseded,
  sortByVersion,
  type EffectiveMasterStatus,
} from './baseline-versioning.js';
import { DEFAULT_FAULT_REPORT_FLOW_CONFIG, faultReportStateLabel } from './baseline-fault-config.js';
import {
  BASELINE_TODO_SOURCE,
  EMPTY_WORKORDER_DRAWING_SOURCE,
  type DrawingReceiptFact,
  type StandardTimeBenchmark,
  type StandardTimeLookup,
  type WorkOrderDrawingSource,
} from './baseline-ports.js';

/** dispatch 实时取价端口（本服务为默认实现）。 */
export interface OutsourcingPriceLookup {
  resolve(tenant: TenantId, processCode: string): Promise<OutsourcingPriceQuote>;
}

/** listing 物料校验执行端口（本服务为默认实现；入参为完整命令信封）。 */
export interface MaterialValidationExecutor {
  execute(tenant: TenantId, envelope: BaselineCommandEnvelope): Promise<CommandOutcome>;
}

export interface BaselineServiceOptions {
  /** 物料校验阈值（缺省 DEFAULT_MATERIAL_VALIDATION_THRESHOLDS；对账阶段校准）。 */
  readonly thresholds?: MaterialValidationThresholds;
  /** 时钟注入（事件 occurredAt 的取时点）。 */
  readonly now?: () => Date;
  /** 故障单状态机配置（缺省 DEFAULT_FAULT_REPORT_FLOW_CONFIG；可整体替换 = 换合法集）。 */
  readonly faultConfig?: ApprovalFlowConfig;
}

/**
 * 故障线跨模块端口集（P2；构造入参可整体缺省——未注入时回落内存机器账本 +
 * 内存待办 + no-op IM，bare 构造（P1 体例三参）零破坏且故障命令仍可执行）。
 */
export interface BaselineFaultPorts {
  /** 状态机事件账本（engine-flow 端口；缺省 = 内存实现）。 */
  readonly machineEvents?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口；缺省 = 内存实现——组合根应注入共享实例）。 */
  readonly todos?: TodoStore | undefined;
  /** IM 推送端口（integration-im / 组合根实现；缺省 = no-op）。 */
  readonly notify?: NotifyChannel | undefined;
  /** 工作令附件图纸计数来源（workorder 线实现；缺省 = 空实现）。 */
  readonly workOrderDrawings?: WorkOrderDrawingSource | undefined;
}

// ---- 读视图 ----

export interface MasterVersionView {
  readonly id: string;
  readonly code: string;
  readonly objectVersion: number;
  readonly status: EffectiveMasterStatus;
  readonly supersedes: string | null;
  readonly createdAt: string;
  readonly businessTime?: string;
}

export interface ProcessDefView extends MasterVersionView {
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
}

export interface EquipmentView extends MasterVersionView {
  readonly name: string;
  readonly type: string | null;
  readonly location: string | null;
}

export interface OutsourcingPriceRuleView extends MasterVersionView {
  readonly name: string | null;
  readonly processCode: string;
  readonly unitPriceMinor: number;
  readonly marginPermyriad: number;
}

export interface RoutingView extends MasterVersionView {
  readonly name: string | null;
  /** 工序序列（seq 升序；processCode 引用工序库）。 */
  readonly steps: readonly { seq: number; processCode: string; remark: string | null }[];
}

export interface StandardTimeView extends MasterVersionView {
  readonly scope: 'process' | 'product';
  readonly targetCode: string;
  readonly standardSeconds: number;
  readonly preparationSeconds: number;
}

export interface MasterDetail<Version> {
  readonly current: Version;
  readonly versions: readonly Version[];
}

function toProcessView(row: ProcessDefRow, chain: readonly ProcessDefRow[]): ProcessDefView {
  return {
    id: row.id,
    code: row.code,
    objectVersion: row.objectVersion,
    status: effectiveStatus(row, chain),
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    name: row.name,
    category: row.category,
    description: row.description,
  };
}

function toEquipmentView(row: EquipmentRow, chain: readonly EquipmentRow[]): EquipmentView {
  return {
    id: row.id,
    code: row.code,
    objectVersion: row.objectVersion,
    status: effectiveStatus(row, chain),
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    name: row.name,
    type: row.type,
    location: row.location,
  };
}

function toRuleView(row: OutsourcingPriceRuleRow, chain: readonly OutsourcingPriceRuleRow[]): OutsourcingPriceRuleView {
  return {
    id: row.id,
    code: row.code,
    objectVersion: row.objectVersion,
    status: effectiveStatus(row, chain),
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    name: row.name,
    processCode: row.processCode,
    unitPriceMinor: row.unitPriceMinor,
    marginPermyriad: row.marginPermyriad,
  };
}

function toRoutingView(row: RoutingRow, chain: readonly RoutingRow[]): RoutingView {
  return {
    id: row.id,
    code: row.code,
    objectVersion: row.objectVersion,
    status: effectiveStatus(row, chain),
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    name: row.name,
    steps: [...row.steps].sort((a, b) => a.seq - b.seq),
  };
}

function toStandardTimeView(row: StandardTimeRow, chain: readonly StandardTimeRow[]): StandardTimeView {
  return {
    id: row.id,
    code: row.code,
    objectVersion: row.objectVersion,
    status: effectiveStatus(row, chain),
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    scope: row.scope,
    targetCode: row.targetCode,
    standardSeconds: row.standardSeconds,
    preparationSeconds: row.preparationSeconds,
  };
}

/** 版本化主数据行最小形状（守门/推导参与约束）。 */
interface MasterRow {
  readonly id: string;
  readonly code: string;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

/** 待办/机器账本侧的用户 id 品牌化（载荷存串、端口收品牌 id 的唯一换算点）。 */
function brandUserId(value: string): UserId {
  return UserId.create(value);
}

export class BaselineService implements OutsourcingPriceLookup, MaterialValidationExecutor, StandardTimeLookup {
  private readonly thresholds: MaterialValidationThresholds;
  private readonly now: () => Date;
  private readonly faultConfig: ApprovalFlowConfig;
  private readonly machineEvents: ApprovalEventStore;
  private readonly todos: TodoStore;
  private readonly notify: NotifyChannel;
  private readonly workOrderDrawings: WorkOrderDrawingSource;

  constructor(
    private readonly stores: BaselineStores,
    private readonly itemLibrary: ItemStore,
    options: BaselineServiceOptions = {},
    faultPorts: BaselineFaultPorts = {},
  ) {
    this.thresholds = options.thresholds ?? DEFAULT_MATERIAL_VALIDATION_THRESHOLDS;
    this.now = options.now ?? (() => new Date());
    this.faultConfig = options.faultConfig ?? DEFAULT_FAULT_REPORT_FLOW_CONFIG;
    this.machineEvents = faultPorts.machineEvents ?? createInMemoryApprovalEventStore();
    this.todos = faultPorts.todos ?? new InMemoryTodoStore();
    this.notify = faultPorts.notify ?? NOOP_NOTIFY_CHANNEL;
    this.workOrderDrawings = faultPorts.workOrderDrawings ?? EMPTY_WORKORDER_DRAWING_SOURCE;
  }

  // ---- 命令执行（写路径） ----

  /**
   * 执行一条命令信封。pathId = 资源路径参数（fault.resolve 的目标故障单）——
   * 提供时即为目标聚合（体例同 inspection.execute 的 pathId；P1 命令无路径目标，
   * 该参数缺省不影响既有调用方）。
   */
  async execute(tenant: TenantId, envelope: BaselineCommandEnvelope, pathId?: string): Promise<CommandOutcome> {
    const { kind, payload } = envelope.command;
    try {
      switch (kind) {
        case BASELINE_COMMAND_KINDS.processDefine:
          return await this.defineProcess(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.processRevise:
          return await this.reviseProcess(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.equipmentRegister:
          return await this.registerEquipment(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.equipmentRevise:
          return await this.reviseEquipment(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.outsourcingRuleSet:
          return await this.setOutsourcingRule(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.outsourcingRuleRevise:
          return await this.reviseOutsourcingRule(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.materialValidate:
          return await this.validateMaterial(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.routingDefine:
          return await this.defineRouting(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.routingRevise:
          return await this.reviseRouting(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.standardtimeDefine:
          return await this.defineStandardTime(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.faultReport:
          return await this.reportFault(tenant, envelope, payload);
        case BASELINE_COMMAND_KINDS.faultResolve:
          return await this.resolveFault(tenant, envelope, payload, pathId);
      }
    } catch (error) {
      // 业务拒绝：载荷非法 / 乐观锁前置检查（claim 前——不占用 operationId，同 id
      // 可改后重发）/ claim 后的并发唯一约束冲突（operationId 已占用，须换新信封）。
      if (error instanceof BaselineInputError || error instanceof BaselineConflictError) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（口径统一：先解析校验后记账）。调用点在各命令 handler 的
   * 载荷解析与业务校验全部通过、首个持久写之前——被拒命令不占用 operationId，
   * 同 id 修正重发可重新评估；已 committed 的同 id 重发在此被拒（不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: BaselineCommandEnvelope): Promise<CommandOutcome | null> {
    const claimed = await this.stores.operations.claim(tenant, envelope.operationId, envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: BaselineCommandEnvelope): BaselineProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  /** define/register/set 语义守门：expectedRevision 必须 'initial' 且业务码不存在。 */
  private rejectIfDefineMismatch(
    label: string,
    code: string,
    versions: readonly MasterRow[],
    expectedRevision: BaselineCommandEnvelope['expectedRevision'],
  ): string | null {
    if (expectedRevision !== 'initial') {
      return `${label} '${code}' 定义命令（define/register/set）的 expectedRevision 须为 'initial'，收到 ${String(expectedRevision)}`;
    }
    const current = currentVersion(versions);
    if (current !== null) {
      return `${label} '${code}' 已存在（当前 v${current.objectVersion}），修订请走 revise 命令并声明 expectedRevision`;
    }
    return null;
  }

  /** revise 语义守门：expectedRevision 必须为数字且等于当前版本。 */
  private rejectIfReviseMismatch(
    label: string,
    code: string,
    versions: readonly MasterRow[],
    expectedRevision: BaselineCommandEnvelope['expectedRevision'],
  ): string | null {
    if (expectedRevision === 'initial') {
      return `${label} '${code}' 修订命令的 expectedRevision 须为数字（当前 objectVersion），收到 'initial'`;
    }
    const current = currentVersion(versions);
    if (current === null) {
      return `${label} '${code}' 不存在，无版本可修订（定义请走 define/register/set 命令）`;
    }
    if (expectedRevision !== current.objectVersion) {
      return `乐观锁冲突：${label} '${code}' 声明 expectedRevision=${String(expectedRevision)}，当前 objectVersion=${current.objectVersion}（不重试同信封）`;
    }
    return null;
  }

  /** 事件落账；失败 = 已知中断窗口（行已落、事件未落）→ indeterminate。 */
  private async commitEvent(event: BusinessEvent, newRevision: number): Promise<CommandOutcome> {
    try {
      await this.stores.events.append(event);
      return { status: 'committed', newRevision, events: [event] };
    } catch (error) {
      return {
        status: 'indeterminate',
        reason: `行已落账但事件追加失败（${error instanceof Error ? error.message : String(error)}）：retrySafe=false，须人工对账后再决定是否重发`,
        retrySafe: false,
      };
    }
  }

  // ---- 工序库 ----

  private async defineProcess(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseProcessDefinePayload(payload);
    const versions = await this.stores.processes.versions(tenant, parsed.code);
    const mismatch = this.rejectIfDefineMismatch('工序', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.processes.insert({
      tenant,
      code: parsed.code,
      name: parsed.name,
      category: parsed.category ?? null,
      description: parsed.description ?? null,
      status: parsed.status ?? 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeProcessDefinedEvent(tenant, row, 'define', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  private async reviseProcess(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseProcessRevisePayload(payload);
    const versions = await this.stores.processes.versions(tenant, parsed.code);
    const mismatch = this.rejectIfReviseMismatch('工序', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };
    const current = currentVersion(versions);
    if (current === null) return { status: 'rejected', reason: `工序 '${parsed.code}' 不存在` };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.processes.insert({
      tenant,
      code: parsed.code,
      name: parsed.name ?? current.name,
      category: parsed.category !== undefined ? parsed.category : current.category,
      description: parsed.description !== undefined ? parsed.description : current.description,
      status: parsed.status ?? current.status,
      objectVersion: current.objectVersion + 1,
      supersedes: current.id,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeProcessDefinedEvent(tenant, row, 'revise', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  // ---- 设备台账 ----

  private async registerEquipment(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseEquipmentRegisterPayload(payload);
    const versions = await this.stores.equipment.versions(tenant, parsed.code);
    const mismatch = this.rejectIfDefineMismatch('设备', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.equipment.insert({
      tenant,
      code: parsed.code,
      name: parsed.name,
      type: parsed.type ?? null,
      location: parsed.location ?? null,
      status: parsed.status ?? 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeEquipmentRegisteredEvent(tenant, row, 'define', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  private async reviseEquipment(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseEquipmentRevisePayload(payload);
    const versions = await this.stores.equipment.versions(tenant, parsed.code);
    const mismatch = this.rejectIfReviseMismatch('设备', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };
    const current = currentVersion(versions);
    if (current === null) return { status: 'rejected', reason: `设备 '${parsed.code}' 不存在` };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.equipment.insert({
      tenant,
      code: parsed.code,
      name: parsed.name ?? current.name,
      type: parsed.type !== undefined ? parsed.type : current.type,
      location: parsed.location !== undefined ? parsed.location : current.location,
      status: parsed.status ?? current.status,
      objectVersion: current.objectVersion + 1,
      supersedes: current.id,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeEquipmentRegisteredEvent(tenant, row, 'revise', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  // ---- 外协计价规则 ----

  private async setOutsourcingRule(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseOutsourcingRuleSetPayload(payload);
    const versions = await this.stores.outsourcingRules.versions(tenant, parsed.code);
    const mismatch = this.rejectIfDefineMismatch('外协计价规则', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.outsourcingRules.insert({
      tenant,
      code: parsed.code,
      name: parsed.name ?? null,
      processCode: parsed.processCode,
      unitPriceMinor: decimalToMinor(parsed.unitPrice, 'unitPrice'),
      marginPermyriad: parsed.marginPermyriad,
      status: parsed.status ?? 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeOutsourcingRuleSetEvent(tenant, row, 'define', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  private async reviseOutsourcingRule(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseOutsourcingRuleRevisePayload(payload);
    const versions = await this.stores.outsourcingRules.versions(tenant, parsed.code);
    const mismatch = this.rejectIfReviseMismatch('外协计价规则', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };
    const current = currentVersion(versions);
    if (current === null) return { status: 'rejected', reason: `外协计价规则 '${parsed.code}' 不存在` };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.outsourcingRules.insert({
      tenant,
      code: parsed.code,
      name: parsed.name !== undefined ? parsed.name : current.name,
      processCode: parsed.processCode ?? current.processCode,
      unitPriceMinor: parsed.unitPrice !== undefined ? decimalToMinor(parsed.unitPrice, 'unitPrice') : current.unitPriceMinor,
      marginPermyriad: parsed.marginPermyriad ?? current.marginPermyriad,
      status: parsed.status ?? current.status,
      objectVersion: current.objectVersion + 1,
      supersedes: current.id,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeOutsourcingRuleSetEvent(tenant, row, 'revise', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  // ---- 工艺路线（P2：业务键 = 图号，版本链同 P1 体例） ----

  private stepsWithSeq(steps: readonly { processCode: string; remark?: string | null }[]): RoutingRow['steps'] {
    return steps.map((step, index) => ({
      seq: index + 1,
      processCode: step.processCode,
      remark: step.remark ?? null,
    }));
  }

  private async defineRouting(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseRoutingDefinePayload(payload);
    const versions = await this.stores.routings.versions(tenant, parsed.drawingNo);
    const mismatch = this.rejectIfDefineMismatch('工艺路线', parsed.drawingNo, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.routings.insert({
      tenant,
      code: parsed.drawingNo,
      name: parsed.name ?? null,
      steps: this.stepsWithSeq(parsed.steps),
      status: parsed.status ?? 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeRoutingRevisedEvent(tenant, row, 'define', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  private async reviseRouting(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseRoutingRevisePayload(payload);
    const versions = await this.stores.routings.versions(tenant, parsed.drawingNo);
    const mismatch = this.rejectIfReviseMismatch('工艺路线', parsed.drawingNo, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };
    const current = currentVersion(versions);
    if (current === null) return { status: 'rejected', reason: `工艺路线 '${parsed.drawingNo}' 不存在` };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.routings.insert({
      tenant,
      code: parsed.drawingNo,
      name: parsed.name !== undefined ? parsed.name : current.name,
      steps: parsed.steps !== undefined ? this.stepsWithSeq(parsed.steps) : current.steps,
      status: parsed.status ?? current.status,
      objectVersion: current.objectVersion + 1,
      supersedes: current.id,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeRoutingRevisedEvent(tenant, row, 'revise', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  // ---- 额定工时（P3） ----

  private async defineStandardTime(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseStandardTimeDefinePayload(payload);
    const versions = await this.stores.standardTimes.versions(tenant, parsed.code);
    const mismatch = this.rejectIfDefineMismatch('额定工时', parsed.code, versions, envelope.expectedRevision);
    if (mismatch !== null) return { status: 'rejected', reason: mismatch };

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.standardTimes.insert({
      tenant,
      code: parsed.code,
      scope: parsed.scope,
      targetCode: parsed.targetCode,
      standardSeconds: parsed.standardSeconds,
      preparationSeconds: parsed.preparationSeconds ?? 0,
      status: parsed.status ?? 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeStandardTimeDefinedEvent(tenant, row, 'define', this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, row.objectVersion);
  }

  // ---- 故障上报（P2：状态机驱动，体例同 inspection 判定迁移） ----

  /**
   * fault.report：建 open 投影 → 驱动 ASSIGN 迁移（上报即派修）→ 进 assigned
   * 触发 IM 推送（NotifyChannel）+ 维修待办（TodoStore）→ 发 FaultReported。
   * IM/待办在域事件落账之后触发（通知式合同：实现方不抛错则忽略失败语义；
   * 组合根接线 integration-im / 共享 TodoStore 后生效）。
   */
  private async reportFault(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseFaultReportPayload(payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `fault.report 的 expectedRevision 须为 'initial'（上报是创建命令），收到 ${String(envelope.expectedRevision)}`,
      };
    }

    // 先解析校验后记账（口径统一）：校验通过、首笔投影落账前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const id = newFaultReportId();
    const created = await this.stores.faultReports.create({
      tenant,
      id: FaultReportId.create(id),
      flowConfigId: this.faultConfig.flowId,
      state: this.faultConfig.initial,
      objectVersion: 1,
      equipmentCode: parsed.equipmentCode,
      description: parsed.description,
      reportedBy: String(envelope.issuedBy),
    });

    const runtime = await this.replayFaultReport(created);
    try {
      const outcome = runtime.send('ASSIGN', {
        by: envelope.issuedBy,
        reason: parsed.description,
        objectVersion: created.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return { status: 'rejected', reason: `状态 '${created.state}' 对 ASSIGN 返回 ${outcome.status}（配置守卫或规则不一致）` };
      }
      await this.machineEvents.append(outcome.event);
      const now = this.now().toISOString();
      const advanced = await this.stores.faultReports.advance(
        tenant,
        created.id,
        created.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { assignee: parsed.assignee, assignedAt: now },
      );

      // assigned 进入联动：维修待办（assignee 名下）+ IM 推送（合同 §2：推送节点；
      // 通知式合同——NotifyChannel 实现方不抛错；待办存储失败随存储异常上抛）。
      const todo = await this.todos.create({
        tenant,
        assignee: brandUserId(parsed.assignee),
        title: `设备故障待处理：${parsed.equipmentCode}（${faultReportStateLabel(advanced.state)}）`,
        source: BASELINE_TODO_SOURCE,
        refType: BASELINE_AGGREGATE_TYPES.faultReport,
        refId: advanced.id as string,
      });
      await this.notify.notify(tenant, {
        title: '设备故障派修',
        body: `设备 ${parsed.equipmentCode} 故障已派给维修人员：${parsed.description}`,
        refType: BASELINE_AGGREGATE_TYPES.faultReport,
        refId: advanced.id as string,
      });

      const event = makeFaultReportedEvent(tenant, advanced, todo.id, this.provenanceOf(envelope), now);
      return this.commitEvent(event, advanced.objectVersion);
    } finally {
      runtime.stop();
    }
  }

  /**
   * fault.resolve：assigned → resolved 闭环（消待办）→ 发 FaultResolved。
   * pathId = 故障单 id（:id/resolution 端点注入；缺省时 404 语义报错）。
   */
  private async resolveFault(
    tenant: TenantId,
    envelope: BaselineCommandEnvelope,
    payload: unknown,
    pathId: string | undefined,
  ): Promise<CommandOutcome> {
    const parsed = parseFaultResolvePayload(payload);
    if (pathId === undefined || pathId.trim().length === 0) {
      return { status: 'rejected', reason: "命令 'baseline.fault.resolve.v1' 需要路径参数目标 id（控制器装配缺口）" };
    }
    const id = FaultReportId.create(pathId.trim());
    const report = await this.stores.faultReports.find(tenant, id);
    if (report === null) {
      return { status: 'rejected', reason: `租户 '${tenant}' 内不存在故障单 '${pathId}'` };
    }
    if (report.flowConfigId !== this.faultConfig.flowId) {
      return {
        status: 'rejected',
        reason: `故障单由配置 '${report.flowConfigId}' 驱动，与当前装配配置 '${this.faultConfig.flowId}' 不符`,
      };
    }
    if (envelope.expectedRevision === 'initial') {
      return {
        status: 'rejected',
        reason: `命令 'baseline.fault.resolve.v1' 作用于既有对象：expectedRevision 须为当前 objectVersion 数字（当前 ${report.objectVersion}）`,
      };
    }
    if (envelope.expectedRevision !== report.objectVersion) {
      return {
        status: 'rejected',
        reason: `乐观锁冲突：expectedRevision=${String(envelope.expectedRevision)}，故障单当前 objectVersion=${report.objectVersion}（不重试同信封）`,
      };
    }
    if (report.state !== 'assigned') {
      return { status: 'rejected', reason: `故障单 '${pathId}' 已处 '${report.state}'（${faultReportStateLabel(report.state)}），仅已派修单可闭环` };
    }

    // 先解析校验后记账（口径统一）：存在性/配置/乐观锁/状态守门全过、机器事件
    // 落账前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const runtime = await this.replayFaultReport(report);
    try {
      const outcome = runtime.send('RESOLVE', {
        by: envelope.issuedBy,
        reason: parsed.remark ?? '故障闭环',
        objectVersion: report.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return { status: 'rejected', reason: `状态 '${report.state}' 对 RESOLVE 返回 ${outcome.status}` };
      }
      await this.machineEvents.append(outcome.event);
      const now = this.now().toISOString();
      const advanced = await this.stores.faultReports.advance(
        tenant,
        id,
        report.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { resolutionRemark: parsed.remark ?? null, resolvedBy: String(envelope.issuedBy), resolvedAt: now },
      );

      // 闭环消待办：清 assignee 名下该故障单的 open 待办（Done-when：闭环）。
      if (report.assignee !== null) {
        await this.completeFaultTodos(tenant, report.assignee, advanced.id as string);
      }

      const event = makeFaultResolvedEvent(tenant, advanced, this.provenanceOf(envelope), now);
      return this.commitEvent(event, advanced.objectVersion);
    } finally {
      runtime.stop();
    }
  }

  /** 重放故障单机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayFaultReport(report: FaultReport): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: report.id as string, type: BASELINE_AGGREGATE_TYPES.faultReport };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.faultConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now().toISOString(),
    });
    for (const event of page.events) {
      const outcome = runtime.send(event.payload.event, {
        by: brandUserId(event.payload.actor),
        reason: event.payload.reason,
        objectVersion: event.payload.objectVersion - 1,
      });
      if (outcome.status !== 'transitioned') {
        runtime.stop();
        throw new BaselineConflictError(
          `故障账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== report.state || runtime.objectVersion() !== report.objectVersion) {
      runtime.stop();
      throw new BaselineConflictError(
        `故障账本与故障单行不一致：故障单 ${report.state}@v${report.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 完成维修人员名下（source=baseline + refType=故障单聚合）的 open 待办。 */
  private async completeFaultTodos(
    tenant: TenantId,
    assignee: string,
    faultReportId: string,
  ): Promise<readonly TodoItem[]> {
    const own = await this.todos.listOwn(tenant, brandUserId(assignee));
    const completed: TodoItem[] = [];
    for (const todo of own) {
      if (
        todo.source === BASELINE_TODO_SOURCE &&
        todo.refType === BASELINE_AGGREGATE_TYPES.faultReport &&
        todo.refId === faultReportId &&
        todo.status === 'open'
      ) {
        const done = await this.todos.complete(tenant, brandUserId(assignee), todo.id);
        if (done !== null) completed.push(done);
      }
    }
    return completed;
  }

  // ---- 物料校验执行 ----

  private async validateMaterial(tenant: TenantId, envelope: BaselineCommandEnvelope, payload: unknown): Promise<CommandOutcome> {
    const parsed = parseMaterialValidatePayload(payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `material.validate 的 expectedRevision 须为 'initial'（校验是执行事实，无目标版本可锁），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    const items = await this.itemLibrary.list(tenant);
    const { judgments, summary } = validateMaterialLines(parsed.lines, items, this.thresholds);

    // 先解析校验后记账（口径统一）：载荷解析与判定计算完成、校验运行行落账前
    // claim（validateMaterialLines 恒产出行——量与阈值异常在解析层已拒）。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const run = await this.stores.validationRuns.insert({
      tenant,
      issuedBy: String(envelope.issuedBy),
      objectVersion: 1,
      auditStatus: BASELINE_AUDIT_STATUS_UNAUDITED,
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
      summary,
      lines: judgments,
    });
    const event = makeMaterialValidatedEvent(tenant, run, this.provenanceOf(envelope), this.now().toISOString());
    return this.commitEvent(event, run.objectVersion);
  }

  // ---- 查询（读路径） ----

  async listProcesses(tenant: TenantId, statusFilter?: string): Promise<readonly ProcessDefView[]> {
    const rows = await this.stores.processes.listAll(tenant);
    return this.currentViews(rows, statusFilter, toProcessView);
  }

  async getProcess(tenant: TenantId, code: string): Promise<MasterDetail<ProcessDefView>> {
    const chain = await this.stores.processes.versions(tenant, code);
    const current = currentVersion(chain);
    if (current === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在工序 '${code}'`);
    return { current: toProcessView(current, chain), versions: sortByVersion(chain).map((row) => toProcessView(row, chain)) };
  }

  async listEquipment(tenant: TenantId, statusFilter?: string): Promise<readonly EquipmentView[]> {
    const rows = await this.stores.equipment.listAll(tenant);
    return this.currentViews(rows, statusFilter, toEquipmentView);
  }

  async getEquipment(tenant: TenantId, code: string): Promise<MasterDetail<EquipmentView>> {
    const chain = await this.stores.equipment.versions(tenant, code);
    const current = currentVersion(chain);
    if (current === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在设备 '${code}'`);
    return { current: toEquipmentView(current, chain), versions: sortByVersion(chain).map((row) => toEquipmentView(row, chain)) };
  }

  async listOutsourcingRules(tenant: TenantId, statusFilter?: string): Promise<readonly OutsourcingPriceRuleView[]> {
    const rows = await this.stores.outsourcingRules.listAll(tenant);
    return this.currentViews(rows, statusFilter, toRuleView);
  }

  async getOutsourcingRule(tenant: TenantId, code: string): Promise<MasterDetail<OutsourcingPriceRuleView>> {
    const chain = await this.stores.outsourcingRules.versions(tenant, code);
    const current = currentVersion(chain);
    if (current === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在外协计价规则 '${code}'`);
    return { current: toRuleView(current, chain), versions: sortByVersion(chain).map((row) => toRuleView(row, chain)) };
  }

  // ---- P2/P3 件查询（工艺路线按图号 / 额定工时按工序·产品 / 故障单列表） ----

  async listRoutings(tenant: TenantId, statusFilter?: string): Promise<readonly RoutingView[]> {
    const rows = await this.stores.routings.listAll(tenant);
    return this.currentViews(rows, statusFilter, toRoutingView);
  }

  /** 按图号查工艺路线（合同 §3：业务键 = 图号；返回当前版 + 全版本链）。 */
  async getRouting(tenant: TenantId, drawingNo: string): Promise<MasterDetail<RoutingView>> {
    const chain = await this.stores.routings.versions(tenant, drawingNo);
    const current = currentVersion(chain);
    if (current === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在图号 '${drawingNo}' 的工艺路线`);
    return { current: toRoutingView(current, chain), versions: sortByVersion(chain).map((row) => toRoutingView(row, chain)) };
  }

  async listStandardTimes(
    tenant: TenantId,
    statusFilter?: string,
    scope?: 'process' | 'product',
    targetCode?: string,
  ): Promise<readonly StandardTimeView[]> {
    const rows = await this.stores.standardTimes.listAll(tenant);
    const filtered = rows.filter(
      (row) =>
        (scope === undefined || row.scope === scope) && (targetCode === undefined || row.targetCode === targetCode),
    );
    return this.currentViews(filtered, statusFilter, toStandardTimeView);
  }

  async getStandardTime(tenant: TenantId, code: string): Promise<MasterDetail<StandardTimeView>> {
    const chain = await this.stores.standardTimes.versions(tenant, code);
    const current = currentVersion(chain);
    if (current === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在额定工时 '${code}'`);
    return { current: toStandardTimeView(current, chain), versions: sortByVersion(chain).map((row) => toStandardTimeView(row, chain)) };
  }

  /** 故障单列表（维修队列；state 可选过滤，新的在前）。 */
  async listFaultReports(tenant: TenantId, stateFilter?: string): Promise<readonly FaultReport[]> {
    return this.stores.faultReports.list(tenant, stateFilter === undefined ? undefined : { state: stateFilter });
  }

  /** 故障单详情（不存在抛 404 语义错误）。 */
  async getFaultReport(tenant: TenantId, id: string): Promise<FaultReport> {
    const report = await this.stores.faultReports.find(tenant, FaultReportId.create(id));
    if (report === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在故障单 '${id}'`);
    return report;
  }

  /** hours 额定工时对标端口：active 当前版（未被取代）命中 → 快照；无 → 404 语义。 */
  async resolveStandardTime(
    tenant: TenantId,
    scope: 'process' | 'product',
    targetCode: string,
  ): Promise<StandardTimeBenchmark> {
    const rows = await this.stores.standardTimes.listAll(tenant);
    const candidates = rows.filter(
      (row) => row.scope === scope && row.targetCode === targetCode && row.status === 'active',
    );
    const current = currentVersion(candidates);
    if (current === null || isSuperseded(current, rows)) {
      throw new BaselineNotFoundError(
        `租户 '${tenant}' 内对标目标 '${scope}:${targetCode}' 无生效额定工时（active 且未被取代）`,
      );
    }
    return {
      standardTimeCode: current.code,
      scope: current.scope,
      targetCode: current.targetCode,
      standardSeconds: current.standardSeconds,
      preparationSeconds: current.preparationSeconds,
    };
  }

  /** 下图统计事实查询（合同 §4/§8：数据源 = workorder 附件图纸计数；本模块只透出事实，口径归 engine-reporting）。 */
  async listDrawingReceiptFacts(tenant: TenantId): Promise<readonly DrawingReceiptFact[]> {
    return this.workOrderDrawings.listDrawingCounts(tenant);
  }

  /** 当前版视图（每业务码取 max 版本行；可选有效态过滤 draft/active/superseded）。 */
  private currentViews<Row extends MasterRow, View extends { readonly code: string; readonly status: EffectiveMasterStatus }>(
    rows: readonly Row[],
    statusFilter: string | undefined,
    toView: (row: Row, chain: readonly Row[]) => View,
  ): readonly View[] {
    const byCode = new Map<string, Row[]>();
    for (const row of rows) {
      const bucket = byCode.get(row.code);
      if (bucket === undefined) byCode.set(row.code, [row]);
      else bucket.push(row);
    }
    const views: View[] = [];
    for (const chain of byCode.values()) {
      const current = currentVersion(chain);
      if (current === null) continue;
      const view = toView(current, chain);
      if (statusFilter === undefined || view.status === statusFilter) views.push(view);
    }
    return views.sort((a, b) => a.code.localeCompare(b.code));
  }

  async listValidationRuns(tenant: TenantId): Promise<readonly MaterialValidationRunSummaryView[]> {
    return this.stores.validationRuns.list(tenant);
  }

  async getValidationRun(tenant: TenantId, runId: string): Promise<MaterialValidationRunRow> {
    // D-7：运行行 id 是裸 uuid 列，非 uuid 字面量必不存在——先按 404 语义短路，
    // 不触存储（PG 适配层对非 uuid 串会抛 Prisma P2023 上浮 500）；消息与存储 miss 同形。
    if (!isBaselineUuidLiteral(runId)) {
      throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在校验运行 '${runId}'`);
    }
    const run = await this.stores.validationRuns.get(tenant, runId);
    if (run === null) throw new BaselineNotFoundError(`租户 '${tenant}' 内不存在校验运行 '${runId}'`);
    return run;
  }

  /** dispatch 实时取价：active 当前版规则 → 报价；无可用规则 → 404 语义。 */
  async resolve(tenant: TenantId, processCode: string): Promise<OutsourcingPriceQuote> {
    const rules = await this.stores.outsourcingRules.listAll(tenant);
    const rule = pickActiveRuleForProcess(rules, processCode, (entry, chain) => isSuperseded(entry, chain));
    if (rule === null) {
      throw new BaselineNotFoundError(`租户 '${tenant}' 内工序 '${processCode}' 无生效外协计价规则（active 且未被取代）`);
    }
    return quoteOutsourcingRule(rule);
  }

  /** 事件读（审计/调试口径，occurredAt 升序）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }
}
