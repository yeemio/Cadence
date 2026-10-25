/**
 * MaintenanceService —— 维保执行域用例编排（M3，m3-drafts/02-maintenance.md v1.0）。
 * 零框架业务类（不 import @nestjs/*；注册面/激活开关接线归组合根与总控）。
 *
 * 三域编排：
 *  - 维保计划 = 版本化主数据（发布/修订 = 新版本行，历史记录溯源旧版可解释——
 *    合同 §3 plan.publish；体例同 payroll 规则发布）；
 *  - 维保任务 = 状态机投影行（engine-flow 配置承载：scheduled → executing →
 *    done + cancelled 回退支；G2 落账顺序：建单先落 scheduled@v1 投影再驱动
 *    迁移；迁移走行级乐观锁条件更新，事件留痕 from→to）；
 *  - 三态记录 = append-only 执行留痕事实（点检 pass/fail / 保养动作完成 /
 *    维修处置 restored+faultRef；修正走冲销/补录不改原行）。
 *
 * 命令七件（合同 §3，G1 口径：先解析校验后记账——被拒命令不占用 operationId）：
 *  - maintenance.plan.publish.v1：发布/修订计划（演进 = 新版本，expectedRevision
 *    乐观锁）；
 *  - maintenance.plan.due-scan.v1：到期扫描（信封命令，体例对齐
 *    purchase.overdue.scan.v1 / inspection.overdue.scan.v1：幂等去重锚 =
 *    (tenant, due:<planId>:<occurrenceKey>) 唯一约束；到期集合 = 计划锚点
 *    （首发时刻）至 asOf 的全部到期 occurrence，同计划集合同 asOof 生成集合
 *    确定——对账锚，合同 §7）；
 *  - maintenance.task.create.v1（手工/故障联动建任务：faultRef 携带即 fault 联动，
 *    双侧零 import——组合根粘合，差异表 #4）；
 *  - maintenance.task.start/complete/cancel.v1：状态机迁移（仅 scheduled 可撤）；
 *  - maintenance.record.append.v1：三态记录追加（checkpoint fail →
 *    CheckpointFailed 事件 → 待办推送维修跟进；不合格转故障上报由人触发
 *    baseline.fault.report，不自动——差异表 #5）。
 *
 * 事件追加失败窗口返回 indeterminate(retrySafe=true)（重放安全，取舍同
 * payroll：事实幂等键完整——版本唯一约束 + 任务到期锚点唯一约束 + 事件 eventId）。
 */
import type {
  BusinessEvent,
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
  UserId,
} from '@smes/business-core';
import type { ApprovalFlowConfig } from '@smes/engine-flow';
import { MaintenanceNotFoundError, isMaintenanceConflict } from './maintenance-errors.js';
import {
  MAINTENANCE_AGGREGATE_TYPES,
  MAINTENANCE_EVENT_TYPES,
  makeCheckpointFailedEvent,
  makeMaintenanceActivityAppendedEvent,
  makeMaintenancePlanPublishedEvent,
  makeMaintenanceTaskCreatedEvent,
  makeMaintenanceTaskTransitionedEvent,
  type MaintenanceEventProvenance,
} from './maintenance-events.js';
import {
  DEFAULT_MAINTENANCE_TASK_FLOW_CONFIG,
  TASK_TRANSITION_EVENTS,
  dueOccurrences,
  planDueTaskKind,
  resolveTaskTransition,
} from './maintenance-config.js';
import {
  parseDueScanPayload,
  parsePlanPublishPayload,
  parseRecordAppendPayload,
  parseTaskCancelPayload,
  parseTaskCreatePayload,
  parseTaskRefPayload,
  type MaintenanceCommandEnvelope,
  type MaintenanceRecordAppendPayload,
} from './maintenance-input.js';
import type {
  MaintenanceActivityQuery,
  MaintenanceActivityRow,
  MaintenancePlanRow,
  MaintenanceStores,
  MaintenanceTaskRow,
  AppendMaintenanceActivityInput,
  ListMaintenanceTasksFilter,
} from './maintenance-stores.js';
import type { ResourceRef } from './ports.js';

// ---- 结果形状 ----

/** 计划版本视图（版本链 + 推导态）。 */
export interface MaintenancePlanView {
  /** 版本行 id（mpl-<uuidv7>）。 */
  readonly id: string;
  readonly planId: string;
  readonly name: string | null;
  readonly resourceRef: string;
  readonly cycle: Readonly<Record<string, unknown>>;
  readonly checkpoints: readonly unknown[];
  readonly upkeepActions: readonly string[];
  readonly objectVersion: number;
  /** current = 该 planId 当前版本；superseded = 历史版本。 */
  readonly status: 'current' | 'superseded';
  readonly supersedes: string | null;
  readonly createdAt: string;
}

/** 到期扫描回执（对账锚：asOf + 计划数 + 生成任务集）。 */
export interface MaintenanceDueScanResult {
  readonly asOf: string;
  readonly plansScanned: number;
  readonly tasksCreated: number;
  readonly tasks: readonly MaintenanceTaskRow[];
}

export interface MaintenanceCommitted extends CommittedOutcome {
  /** maintenance.plan.publish 回执。 */
  readonly plan?: MaintenancePlanView;
  /** maintenance.plan.due-scan 回执。 */
  readonly scan?: MaintenanceDueScanResult;
  /** maintenance.task.* 回执（迁移后投影行）。 */
  readonly task?: MaintenanceTaskRow;
  /** maintenance.record.append 回执（append-only 留痕行）。 */
  readonly record?: MaintenanceActivityRow;
}

export type MaintenanceCommandResult = MaintenanceCommitted | RejectedOutcome | IndeterminateOutcome;

export interface MaintenanceServiceOptions {
  /** 时钟注入（事件 occurredAt 与缺省执行时刻取时点；测试确定性）。 */
  readonly now?: () => string;
  /** 任务状态机配置（缺省 DEFAULT_MAINTENANCE_TASK_FLOW_CONFIG；整体替换=配置换代）。 */
  readonly taskConfig?: ApprovalFlowConfig;
}

// ---- 纯函数：计划当前版（对齐 payroll currentRuleVersions 体例） ----

/** 每计划业务身份取当前版本（版本链末位；listAll 已按版本升序）。 */
export function currentPlanVersions(rows: readonly MaintenancePlanRow[]): readonly MaintenancePlanRow[] {
  const latest = new Map<string, MaintenancePlanRow>();
  for (const row of rows) {
    const current = latest.get(row.planId);
    if (current === undefined || row.objectVersion > current.objectVersion) latest.set(row.planId, row);
  }
  return [...latest.values()].sort((a, b) => a.planId.localeCompare(b.planId));
}

/** 每计划业务身份取链锚（首发版本行——due-scan 到期 occurrence 的锚点）。 */
export function planAnchors(rows: readonly MaintenancePlanRow[]): ReadonlyMap<string, MaintenancePlanRow> {
  const first = new Map<string, MaintenancePlanRow>();
  for (const row of rows) {
    const anchor = first.get(row.planId);
    if (anchor === undefined || row.objectVersion < anchor.objectVersion) first.set(row.planId, row);
  }
  return first;
}

// ---- 服务 ----

export class MaintenanceService {
  private readonly now: () => string;
  private readonly taskConfig: ApprovalFlowConfig;

  constructor(
    private readonly stores: MaintenanceStores,
    options: MaintenanceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.taskConfig = options.taskConfig ?? DEFAULT_MAINTENANCE_TASK_FLOW_CONFIG;
  }

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: MaintenanceCommandEnvelope): Promise<MaintenanceCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'maintenance.plan.publish.v1':
          return await this.publishPlan(tenant, envelope);
        case 'maintenance.plan.due-scan.v1':
          return await this.scanDue(tenant, envelope);
        case 'maintenance.task.create.v1':
          return await this.createTask(tenant, envelope);
        case 'maintenance.task.start.v1':
          return await this.transitionTask(tenant, envelope, TASK_TRANSITION_EVENTS.start, 'start');
        case 'maintenance.task.complete.v1':
          return await this.transitionTask(tenant, envelope, TASK_TRANSITION_EVENTS.complete, 'complete');
        case 'maintenance.task.cancel.v1':
          return await this.transitionTask(tenant, envelope, TASK_TRANSITION_EVENTS.cancel, 'cancel');
        case 'maintenance.record.append.v1':
          return await this.appendRecord(tenant, envelope);
      }
    } catch (error) {
      if (isMaintenanceConflict(error)) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（G1：先解析校验后记账）。调用点在各命令 handler 的载荷
   * 解析与业务校验全部通过、首个持久写之前——被拒命令不占用 operationId，
   * 同 id 修正重发可重新评估；已 committed 的同 id 重发在此被拒（不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: MaintenanceCommandEnvelope): Promise<MaintenanceCommandResult | null> {
    const claimed = await this.stores.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: MaintenanceCommandEnvelope): MaintenanceEventProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  /** 事件逐条落账；失败 = 中断窗口 → indeterminate（重放安全：事实幂等键完整）。 */
  private async commitOutcome(
    events: readonly BusinessEvent[],
    extra: Omit<MaintenanceCommitted, keyof CommittedOutcome | 'events'>,
    failureContext: string,
  ): Promise<MaintenanceCommandResult> {
    try {
      for (const event of events) {
        await this.stores.events.append(event);
      }
      return { status: 'committed', newRevision: 1, events, ...extra };
    } catch (error) {
      return {
        status: 'indeterminate',
        reason: `${failureContext}（${error instanceof Error ? error.message : String(error)}）：retrySafe=true——事实幂等键完整，可安全重发新 operationId 重放`,
        retrySafe: true,
      };
    }
  }

  // ---- maintenance.plan.publish.v1 ----

  private async publishPlan(tenant: TenantId, envelope: MaintenanceCommandEnvelope): Promise<MaintenanceCommandResult> {
    const payload = parsePlanPublishPayload(envelope.command.payload);
    const versions = await this.stores.plans.versions(tenant, payload.planId);
    const current = versions.length > 0 ? versions[versions.length - 1]! : null;
    if (envelope.expectedRevision === 'initial') {
      if (current !== null) {
        return {
          status: 'rejected',
          reason: `维保计划 '${payload.planId}' 已存在（当前 v${current.objectVersion}），修订请声明 expectedRevision=${current.objectVersion}`,
        };
      }
    } else {
      if (current === null) {
        return {
          status: 'rejected',
          reason: `维保计划 '${payload.planId}' 不存在，无版本可修订（首发请走 expectedRevision='initial'）`,
        };
      }
      if (envelope.expectedRevision !== current.objectVersion) {
        return {
          status: 'rejected',
          reason: `乐观锁冲突：维保计划 '${payload.planId}' 声明 expectedRevision=${String(envelope.expectedRevision)}，当前 objectVersion=${current.objectVersion}（不重试同信封）`,
        };
      }
    }
    // 先解析校验后记账（G1）：发布/修订语义守门全过、版本行落账前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.plans.insert({
      tenant,
      planId: payload.planId,
      name: payload.name,
      resourceRef: payload.resourceRef,
      cycle: payload.cycle,
      checkpoints: payload.checkpoints,
      upkeepActions: payload.upkeepActions,
      objectVersion: current === null ? 1 : current.objectVersion + 1,
      supersedes: current === null ? null : current.id,
      auditStatus: 'published',
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeMaintenancePlanPublishedEvent(tenant, row, this.provenanceOf(envelope), this.now());
    const result = await this.commitOutcome([event], { plan: this.toPlanView(row, true) }, '计划版本行已落账但事件追加失败');
    return result.status === 'committed'
      ? { ...result, newRevision: row.objectVersion }
      : result;
  }

  // ---- maintenance.plan.due-scan.v1（到期扫描信封命令） ----

  private async scanDue(tenant: TenantId, envelope: MaintenanceCommandEnvelope): Promise<MaintenanceCommandResult> {
    const payload = parseDueScanPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `maintenance.plan.due-scan 的 expectedRevision 须为 'initial'（扫描是执行事实，无目标版本可锁），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    const asOf = payload.asOf ?? this.now();
    const allVersions = await this.stores.plans.listAll(tenant);
    const currents = currentPlanVersions(allVersions);
    const anchors = planAnchors(allVersions);

    // ---- 全量前置计算（纯读；被拒/零到期不占用 operationId） ----
    interface PlannedInsert {
      readonly plan: MaintenancePlanRow;
      readonly key: string;
      readonly dueAt: string;
    }
    const planned: PlannedInsert[] = [];
    for (const plan of currents) {
      const anchor = anchors.get(plan.planId);
      if (anchor === undefined) continue;
      const existing = new Set(
        (await this.stores.tasks.list(tenant, { source: 'plan-due', planId: plan.planId })).map(
          (task) => task.dueKey ?? '',
        ),
      );
      for (const occurrence of dueOccurrences(plan.cycle, anchor.createdAt, asOf)) {
        if (existing.has(occurrence.key)) continue;
        planned.push({ plan, key: occurrence.key, dueAt: occurrence.dueAt });
      }
    }

    // ---- claim 后进入落账区（幂等去重：sourceKey 唯一约束为 DB 级第二防线） ----
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    const events: BusinessEvent[] = [];
    const created: MaintenanceTaskRow[] = [];
    for (const item of planned) {
      let task: MaintenanceTaskRow;
      try {
        task = await this.stores.tasks.insert({
          tenant,
          flowConfigId: this.taskConfig.flowId,
          source: 'plan-due',
          kind: planDueTaskKind(item.plan),
          resourceRef: item.plan.resourceRef,
          planId: item.plan.planId,
          planVersion: item.plan.objectVersion,
          dueKey: item.key,
          dueAt: item.dueAt,
          state: 'scheduled',
          objectVersion: 1,
          createdBy: actor,
          sourceKey: `due:${item.plan.planId}:${item.key}`,
        });
      } catch (error) {
        if (isMaintenanceConflict(error)) continue; // 并发扫描竞态：已生成，跳过
        throw error;
      }
      created.push(task);
      events.push(makeMaintenanceTaskCreatedEvent(tenant, task, provenance, this.now()));
    }
    return this.commitOutcome(
      events,
      {
        scan: { asOf, plansScanned: currents.length, tasksCreated: created.length, tasks: created },
      },
      '到期任务行已落账但事件追加失败',
    );
  }

  // ---- maintenance.task.create.v1（手工/故障联动建任务；G2：先落 scheduled@v1 投影） ----

  private async createTask(tenant: TenantId, envelope: MaintenanceCommandEnvelope): Promise<MaintenanceCommandResult> {
    const payload = parseTaskCreatePayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `maintenance.task.create 的 expectedRevision 须为 'initial'（建单即首发投影 scheduled@v1），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    // 计划溯源校验（挂计划的任务必须引用存在的计划；fault 联动同样可挂）。
    const planLink =
      payload.planId === undefined
        ? undefined
        : await (async () => {
            const versions = await this.stores.plans.versions(tenant, payload.planId!);
            if (versions.length === 0) {
              return { error: `维保计划 '${payload.planId}' 不存在，任务无法溯源（先执行 maintenance.plan.publish）` } as const;
            }
            return { planId: payload.planId!, planVersion: versions[versions.length - 1]!.objectVersion } as const;
          })();
    if (planLink !== undefined && 'error' in planLink) {
      return { status: 'rejected', reason: planLink.error };
    }
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const source = payload.faultRef !== undefined ? 'fault' : 'manual';
    // G2 落账顺序：先落 scheduled@v1 初始投影（建单无首次迁移可驱动——后续
    // start/complete/cancel 才是迁移），再追加创建事件。
    const task = await this.stores.tasks.insert({
      tenant,
      flowConfigId: this.taskConfig.flowId,
      source,
      kind: payload.kind,
      resourceRef: payload.resourceRef,
      ...(payload.faultRef === undefined ? {} : { faultRef: payload.faultRef }),
      ...(planLink === undefined ? {} : planLink),
      ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
      ...(payload.assignee === undefined ? {} : { assignee: payload.assignee }),
      state: 'scheduled',
      objectVersion: 1,
      createdBy: String(envelope.issuedBy),
    });
    const event = makeMaintenanceTaskCreatedEvent(tenant, task, this.provenanceOf(envelope), this.now());
    return this.commitOutcome([event], { task }, '任务投影行已落账但事件追加失败');
  }

  // ---- maintenance.task.start/complete/cancel.v1（状态机迁移；行级乐观锁） ----

  private async transitionTask(
    tenant: TenantId,
    envelope: MaintenanceCommandEnvelope,
    verb: string,
    action: 'start' | 'complete' | 'cancel',
  ): Promise<MaintenanceCommandResult> {
    let taskId: MaintenanceTaskRow['id'];
    let cancelReason: string | undefined;
    if (action === 'cancel') {
      const parsed = parseTaskCancelPayload(envelope.command.payload);
      taskId = parsed.taskId;
      cancelReason = parsed.reason;
    } else {
      taskId = parseTaskRefPayload(envelope.command.payload, `maintenance.task.${action}`).taskId;
    }
    const task = await this.stores.tasks.find(tenant, taskId);
    if (task === null) {
      return { status: 'rejected', reason: `租户 '${tenant}' 内不存在维保任务 '${taskId}'` };
    }
    if (task.flowConfigId !== this.taskConfig.flowId) {
      return {
        status: 'rejected',
        reason: `维保任务 '${taskId}' 由配置 '${task.flowConfigId}' 驱动，与当前装配配置 '${this.taskConfig.flowId}' 不符（配置换代，拒绝迁移）`,
      };
    }
    if (envelope.expectedRevision === 'initial') {
      return {
        status: 'rejected',
        reason: `maintenance.task.${action} 的 expectedRevision 须为任务当前 objectVersion=${task.objectVersion}（迁移乐观锁）`,
      };
    }
    if (envelope.expectedRevision !== task.objectVersion) {
      return {
        status: 'rejected',
        reason: `乐观锁冲突：任务 '${taskId}' 声明 expectedRevision=${String(envelope.expectedRevision)}，当前 objectVersion=${task.objectVersion}（不重试同信封）`,
      };
    }
    const from = task.state;
    const resolved = resolveTaskTransition(this.taskConfig, from, verb);
    if (resolved === null) {
      return {
        status: 'rejected',
        reason: `状态 '${from}' 对命令 '${verb}' 无迁移规则（配置 '${this.taskConfig.flowId}'；仅 scheduled 可撤、executing 不可撤——合同 §2）`,
      };
    }
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const now = this.now();
    const advanced = await this.stores.tasks.advance(tenant, task.id, task.objectVersion, {
      state: resolved.to,
      objectVersion: task.objectVersion + 1,
      ...(action === 'start' ? { startedAt: now } : {}),
      ...(action === 'complete' ? { completedAt: now } : {}),
      ...(action === 'cancel'
        ? { cancelledAt: now, ...(cancelReason === undefined ? {} : { cancelReason }) }
        : {}),
    });
    if (advanced === null) {
      return {
        status: 'rejected',
        reason: `并发竞态：任务 '${taskId}' 的乐观锁在落账窗口失配（objectVersion=${task.objectVersion} 已被并发迁移），请重读任务后重发新 operationId`,
      };
    }
    const eventType =
      action === 'start'
        ? MAINTENANCE_EVENT_TYPES.taskStarted
        : action === 'complete'
          ? MAINTENANCE_EVENT_TYPES.taskCompleted
          : MAINTENANCE_EVENT_TYPES.taskCancelled;
    const event = makeMaintenanceTaskTransitionedEvent(
      tenant,
      eventType,
      advanced,
      from,
      String(envelope.issuedBy),
      cancelReason ?? null,
      now,
      this.provenanceOf(envelope),
    );
    const result = await this.commitOutcome([event], { task: advanced }, '任务迁移已落账但事件追加失败');
    return result.status === 'committed'
      ? { ...result, newRevision: advanced.objectVersion }
      : result;
  }

  // ---- maintenance.record.append.v1（三态记录追加；append-only） ----

  private async appendRecord(tenant: TenantId, envelope: MaintenanceCommandEnvelope): Promise<MaintenanceCommandResult> {
    const payload = parseRecordAppendPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `maintenance.record.append 的 expectedRevision 须为 'initial'（留痕是追加事实，无目标版本可锁），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    // ---- 全量前置校验（G1：以下全部通过才 claim） ----
    // 1) 计划溯源：挂计划的记录必须引用存在的计划；点检项必须是当前版本判据清单
    //    内的项（点检按判据逐项 pass/fail，合同 §7 Done-when）。repair 载荷无
    //    planId（草案形状保持：维修处置挂故障引用，不挂计划判据）。
    const planIdRef = payload.kind === 'repair' ? undefined : payload.planId;
    let planVersion: number | undefined;
    let expectation: string | null = null;
    if (planIdRef !== undefined) {
      const versions = await this.stores.plans.versions(tenant, planIdRef);
      if (versions.length === 0) {
        return { status: 'rejected', reason: `维保计划 '${planIdRef}' 不存在，记录无法溯源（先执行 maintenance.plan.publish）` };
      }
      const current = versions[versions.length - 1]!;
      planVersion = current.objectVersion;
      if (payload.kind === 'checkpoint') {
        const def = current.checkpoints.find((checkpoint) => checkpoint.checkpointId === payload.checkpointId);
        if (def === undefined) {
          return {
            status: 'rejected',
            reason: `点检项 '${payload.checkpointId}' 不在计划 '${planIdRef}' 当前 v${current.objectVersion} 判据清单内（清单：${current.checkpoints.map((c) => c.checkpointId).join('/') || '空'}）`,
          };
        }
        expectation = def.expectation ?? null;
      }
    }
    // 2) 任务关联：关联任务必须存在且设备一致（留痕不强制挂任务，挂则设备收口）。
    if (payload.taskId !== undefined) {
      const task = await this.stores.tasks.find(tenant, payload.taskId);
      if (task === null) {
        return { status: 'rejected', reason: `租户 '${tenant}' 内不存在维保任务 '${payload.taskId}'，记录无法关联` };
      }
      if (task.resourceRef !== payload.resourceRef) {
        return {
          status: 'rejected',
          reason: `记录设备 '${payload.resourceRef}' 与任务 '${payload.taskId}' 设备 '${task.resourceRef}' 不符（留痕设备须与任务一致）`,
        };
      }
    }
    const performedAt = payload.performedAt ?? this.now();
    const provenance = this.provenanceOf(envelope);
    const base: ActivityBaseFields = {
      tenant,
      resourceRef: payload.resourceRef,
      ...(planIdRef === undefined ? {} : { planId: planIdRef }),
      ...(planVersion === undefined ? {} : { planVersion }),
      ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
      performedBy: envelope.issuedBy,
      performedAt,
      ...(payload.note === undefined ? {} : { note: payload.note }),
      occurredAt: this.now(),
      recordedBy: String(envelope.issuedBy),
      auditStatus: 'recorded',
      provenance,
      businessTime: performedAt,
    };
    const input: AppendMaintenanceActivityInput = buildActivityInput(payload, base);
    // ---- claim 后进入落账区 ----
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.activities.insert(input);
    const events: BusinessEvent[] = [makeMaintenanceActivityAppendedEvent(tenant, row, provenance, this.now())];
    if (row.kind === 'checkpoint' && row.result === 'fail') {
      // 点检不合格 → CheckpointFailed（待办推送维修跟进；转故障上报由人触发，不自动）。
      events.push(makeCheckpointFailedEvent(tenant, row, expectation, provenance, this.now()));
    }
    return this.commitOutcome(events, { record: row }, '三态记录行已落账但事件追加失败');
  }

  // ---- 查询（读路径） ----

  private toPlanView(row: MaintenancePlanRow, isCurrent: boolean): MaintenancePlanView {
    return {
      id: row.id,
      planId: row.planId,
      name: row.name,
      resourceRef: row.resourceRef,
      cycle: row.cycle as unknown as Readonly<Record<string, unknown>>,
      checkpoints: row.checkpoints,
      upkeepActions: row.upkeepActions,
      objectVersion: row.objectVersion,
      status: isCurrent ? 'current' : 'superseded',
      supersedes: row.supersedes,
      createdAt: row.createdAt,
    };
  }

  /** 计划表（按设备可选过滤；同计划当前版在前——功能项 18/19 计划维护面）。 */
  async plans(tenant: TenantId, resourceRef?: ResourceRef): Promise<readonly MaintenancePlanView[]> {
    const rows = await this.stores.plans.listAll(tenant);
    const currentVersions = new Map<string, number>();
    for (const row of rows) {
      currentVersions.set(row.planId, Math.max(currentVersions.get(row.planId) ?? 0, row.objectVersion));
    }
    return rows
      .filter((row) => resourceRef === undefined || row.resourceRef === resourceRef)
      .map((row) => this.toPlanView(row, row.objectVersion === currentVersions.get(row.planId)))
      .sort((a, b) => a.planId.localeCompare(b.planId) || b.objectVersion - a.objectVersion);
  }

  /** 计划版本链（改版后历史记录溯源旧版可解释的读面；当前版在前）。 */
  async planVersions(tenant: TenantId, planId: MaintenancePlanRow['planId']): Promise<readonly MaintenancePlanView[]> {
    const rows = await this.stores.plans.versions(tenant, planId);
    if (rows.length === 0) {
      throw new MaintenanceNotFoundError(`租户 '${tenant}' 内不存在维保计划 '${planId}'`);
    }
    return rows
      .map((row) => this.toPlanView(row, row.objectVersion === rows[rows.length - 1]!.objectVersion))
      .sort((a, b) => b.objectVersion - a.objectVersion);
  }

  /** 任务队列（我的/全部；state/kind/resourceRef 过滤）。 */
  async taskQueue(
    tenant: TenantId,
    filter?: ListMaintenanceTasksFilter,
  ): Promise<readonly MaintenanceTaskRow[]> {
    return this.stores.tasks.list(tenant, filter);
  }

  /** 我的任务（本人数据权限——maintenance:read"本人执行"口径；personId 只取调用方身份）。 */
  async myTasks(tenant: TenantId, person: UserId, state?: string): Promise<readonly MaintenanceTaskRow[]> {
    return this.stores.tasks.list(tenant, {
      assignee: person,
      ...(state === undefined ? {} : { state }),
    });
  }

  /** 到期日历（scheduled ∧ dueAt ∈ [from, to]；缺省无界，dueAt 升序）。 */
  async dueCalendar(tenant: TenantId, from?: string, to?: string): Promise<readonly MaintenanceTaskRow[]> {
    const rows = await this.stores.tasks.list(tenant, { state: 'scheduled' });
    return rows
      .filter((task) => task.dueAt !== undefined)
      .filter((task) => from === undefined || Date.parse(task.dueAt!) >= Date.parse(from))
      .filter((task) => to === undefined || Date.parse(task.dueAt!) <= Date.parse(to))
      .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
  }

  /** 设备维保历史（三态记录按设备×kind×时间窗——台账维度下钻，合同 §3/§7）。 */
  async resourceHistory(tenant: TenantId, query?: MaintenanceActivityQuery): Promise<readonly MaintenanceActivityRow[]> {
    return this.stores.activities.list(tenant, query);
  }

  /** 任务详情（含设备与溯源，125/126 移动同 API 的服务面）。 */
  async taskDetail(tenant: TenantId, taskId: MaintenanceTaskRow['id']): Promise<MaintenanceTaskRow> {
    const task = await this.stores.tasks.find(tenant, taskId);
    if (task === null) {
      throw new MaintenanceNotFoundError(`租户 '${tenant}' 内不存在维保任务 '${taskId}'`);
    }
    return task;
  }

  /** 事件读（审计/调试口径，occurredAt 升序）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }
}

// ---- 纯函数：三态记录行构造（对齐口径的唯一实现） ----

/** 三态记录公共字段的构造面（与 MaintenanceActivityCommon 同形；可选列缺省不落键）。 */
interface ActivityBaseFields {
  readonly tenant: TenantId;
  readonly resourceRef: string;
  readonly planId?: MaintenancePlanRow['planId'];
  readonly planVersion?: number;
  readonly taskId?: MaintenanceTaskRow['id'];
  readonly performedBy: UserId;
  readonly performedAt: string;
  readonly note?: string;
  readonly occurredAt: string;
  readonly recordedBy: string;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
}

function buildActivityInput(
  payload: MaintenanceRecordAppendPayload,
  base: ActivityBaseFields,
): AppendMaintenanceActivityInput {
  if (payload.kind === 'checkpoint') {
    return {
      kind: 'checkpoint',
      ...base,
      checkpointId: payload.checkpointId,
      result: payload.result,
    };
  }
  if (payload.kind === 'upkeep') {
    return {
      kind: 'upkeep',
      ...base,
      ...(payload.actionsDone === undefined || payload.actionsDone.length === 0
        ? {}
        : { actionsDone: payload.actionsDone }),
    };
  }
  return {
    kind: 'repair',
    ...base,
    ...(payload.faultRef === undefined ? {} : { faultRef: payload.faultRef }),
    restored: payload.restored,
  };
}
