/**
 * ApprovalService —— 审批用例编排（M1 收尾波-①，engine-flow 的组合根消费者）。
 *
 * 零框架业务类（不 import @nestjs/*）。编排三件事：
 *
 * 1. 状态机：经 engine-flow runtime 驱动（默认配置起步，配置/命令动词可注入）。
 *    start = 建案 + 提交（SUBMIT）+ 可选进审跳步（START_REVIEW，仅在当前状态
 *    合法时发送——默认配置由此落到 in_review 待审态）；act = 按决策类
 *    （approve/reject/escalate/withdraw）反查配置迁移规则取命令动词提交，
 *    守卫与版本声明原样进引擎（守卫拒绝 = 状态冲突，不落任何账）。
 *
 * 2. 持久化与事实源：案件行（ApprovalCaseStore）是投影，事件账本
 *    （engine-flow ApprovalEventStore）是事实源——act 先重放该案件全部事件
 *    重建运行时（重放态必须与案件行一致，否则状态冲突），再提交新决策；
 *    落库顺序：事件 → 决策记录 → 案件行乐观推进（advance 带期望版本）。
 *    engine 聚合锚定 = 案件本身（type='approval-case'）：记录/事件按案件分桶、
 *    引擎 objectVersion 与案件行版本同源（初始 1，每迁移 +1），业务对象引用
 *    （subjectRef）只作案件行上的通用引用列，不进引擎聚合。
 *
 * 3. 待办联动：start 进入待审态 → 经 workbench TodoStore 逐审批人派待办
 *    （source='approval'，refId=案件 id）；审批人决策 → 本人该案件的待办
 *    自动完成（complete 幂等合同复用）。
 */
import { randomUUID } from 'node:crypto';
import { UserId, type TenantId } from '@smes/business-core';
import {
  DEFAULT_APPROVAL_FLOW_CONFIG,
  startApprovalFlow,
  type ApprovalDecisionKind,
  type ApprovalDecisionInput,
  type ApprovalEvent,
  type ApprovalEventStore,
  type ApprovalFlowConfig,
  type ApprovalRecord,
  type ApprovalRecordStore,
  type ApprovalRecordStoreEntry,
  type ApprovalSendOutcome,
  type ApprovalSubjectRef,
} from '@smes/engine-flow';
import type { UserStore } from '../org/org-stores.js';
import type { TodoItem, TodoStore } from '../workbench/workbench-stores.js';
import {
  ApprovalConflictError,
  ApprovalInputError,
  ApprovalNotFoundError,
  ApprovalStateError,
} from './approval-errors.js';
import { parseDecisionInput, parseStartApprovalInput, parseCaseIdParam, parseStateFilter } from './approval-input.js';
import type { ApprovalCase, ApprovalCaseStore } from './approval-stores.js';

/** 引擎聚合锚定：案件聚合类型（记录/事件按案件分桶）。 */
export const APPROVAL_CASE_AGGREGATE_TYPE = 'approval-case';

/** 待办联动的来源模块码 / 引用类型（与 workbench source/refType 同形状）。 */
export const APPROVAL_TODO_SOURCE = 'approval';

export interface ApprovalServiceOptions {
  /** 审批流配置（缺省 DEFAULT_APPROVAL_FLOW_CONFIG；租户/行业可整体替换）。 */
  readonly config: ApprovalFlowConfig;
  /** 发起命令动词（缺省 'SUBMIT'——默认配置的提交动词）。 */
  readonly submitEvent: string;
  /**
   * 进审跳步命令动词：发起提交后若该命令在当前状态合法则自动发送（默认配置
   * 由此从 submitted 落到 in_review 待审态）；null = 不跳步（停在设计态）。
   */
  readonly reviewEvent: string | null;
  /**
   * 租户级配置解析器（T1 接线 #102）：返回该租户当前启用的持久化审批流配置
   * （approval-config 模块的 active 行），null/undefined = 回落静态 options.config。
   * 每次发起/决策按租户现解析——配置页"启用指定版本"后新案即按新配置驱动；
   * 在途案件由引擎重放守卫兜底（配置换代导致重放不一致即状态冲突，不静默漂移）。
   */
  readonly flowConfigResolver?:
    | ((tenant: TenantId) => Promise<ApprovalFlowConfig | null>)
    | undefined;
  /**
   * 审批人目录（D-11）：org 域 UserStore 只读复用（租户收口查询端口，同
   * TodoStore 复用 workbench 的跨域端口先例；组合根注入与 org/auth 同一
   * 实例）。发起审批时逐审批人校验"本租户内存在且 active"，任一不满足 →
   * ApprovalInputError（400）——不产生无人处理的审批单。缺省不校验（单模块
   * 装配/零 DB boot 语义完整，缺省纪律同 flowConfigResolver）。
   */
  readonly userStore?: UserStore | undefined;
}

export interface ApprovalStartResult {
  readonly case: ApprovalCase;
  readonly events: readonly ApprovalEvent[];
  readonly todosCreated: readonly TodoItem[];
}

export interface ApprovalActResult {
  readonly case: ApprovalCase;
  /** 决策类迁移产出的审批记录（非决策迁移无——本端点只接决策类，恒存在）。 */
  readonly record?: ApprovalRecord;
  readonly event: ApprovalEvent;
  readonly todosCompleted: readonly TodoItem[];
}

export interface ApprovalCaseDetail {
  readonly case: ApprovalCase;
  readonly records: readonly ApprovalRecord[];
  readonly events: readonly ApprovalEvent[];
}

export class ApprovalService {
  constructor(
    private readonly cases: ApprovalCaseStore,
    private readonly records: ApprovalRecordStore,
    private readonly events: ApprovalEventStore,
    private readonly todos: TodoStore,
    private readonly options: ApprovalServiceOptions = {
      config: DEFAULT_APPROVAL_FLOW_CONFIG,
      submitEvent: 'SUBMIT',
      reviewEvent: 'START_REVIEW',
    },
  ) {}

  /**
   * 本次操作的生效配置：租户级解析器优先（持久化 active 行），无解析器/
   * 未命中回落静态 options.config（缺省 DEFAULT_APPROVAL_FLOW_CONFIG）。
   */
  private async configFor(tenant: TenantId): Promise<ApprovalFlowConfig> {
    if (this.options.flowConfigResolver === undefined) return this.options.config;
    const resolved = await this.options.flowConfigResolver(tenant);
    return resolved ?? this.options.config;
  }

  /** 发起审批：建案 + 提交流程（+ 进审跳步）→ 逐审批人派待办。 */
  async start(tenant: TenantId, actor: UserId, input: unknown): Promise<ApprovalStartResult> {
    const payload = parseStartApprovalInput(input);
    await this.ensureApproversAvailable(tenant, payload.approvers); // D-11：任何落账/派待办之前
    const config = await this.configFor(tenant);
    const caseId = `case-${randomUUID()}`;
    const subject: ApprovalSubjectRef = {
      aggregate: { id: caseId, type: APPROVAL_CASE_AGGREGATE_TYPE },
      initialObjectVersion: 1,
    };
    const runtime = startApprovalFlow({ config, subject });
    try {
      const submitInput: ApprovalDecisionInput = { by: actor, reason: payload.reason };
      this.mustTransition(runtime.send(this.options.submitEvent, submitInput), '发起提交');
      const reviewEvent = this.options.reviewEvent;
      if (reviewEvent !== null && runtime.can(reviewEvent, submitInput)) {
        this.mustTransition(runtime.send(reviewEvent, submitInput), '进入待审');
      }
      if (runtime.isFinal()) {
        throw new ApprovalStateError('配置语义异常：发起后即终态，不存在待审环节');
      }

      // 落库顺序（PG 适配层合同）：案件行先建——engine 记录/事件端口的 PG 实现
      // 经案件行解析租户（聚合锚定 = 案件，见 business-store ./approval），
      // 案件行不存在即孤儿账目拒写；故投影先行、账本紧随。中断窗口（行已建、
      // 账未落）在下次 act 的重放对账处以状态冲突暴露，不静默漂移。
      const created = await this.cases.create({
        tenant,
        id: caseId,
        flowConfigId: config.flowId,
        state: runtime.state(),
        objectVersion: runtime.objectVersion(),
        subjectRef: payload.subjectRef,
        submitter: actor,
      });
      const aggregate = subject.aggregate;
      for (const event of runtime.events()) {
        await this.events.append(event);
      }
      for (const record of runtime.records()) {
        await this.records.append({ aggregate, record } satisfies ApprovalRecordStoreEntry);
      }

      // 待办联动：进入待审态 → 每名审批人一条（source='approval'，refId=案件 id）。
      const title = payload.title ?? `审批：${payload.subjectRef.type}/${payload.subjectRef.id}`;
      const todosCreated: TodoItem[] = [];
      for (const approver of payload.approvers) {
        todosCreated.push(
          await this.todos.create({
            tenant,
            assignee: approver,
            title,
            source: APPROVAL_TODO_SOURCE,
            refType: APPROVAL_CASE_AGGREGATE_TYPE,
            refId: caseId,
          }),
        );
      }
      return { case: created, events: runtime.events(), todosCreated };
    } finally {
      runtime.stop(); // 释放引擎在途定时器（默认配置无，守卫自定义配置）
    }
  }

  /**
   * 审批人可用性校验（D-11）：逐人经租户收口目录查询，本租户内不存在或
   * active=false → ApprovalInputError（400）。端口按 (tenant, id) 收口——
   * "属于其他租户"与"不存在"同形 null，错误信息不区分二者（不泄漏他租户
   * 用户存在性）；未注入目录（模块缺省）不校验，既有单模块行为零变化。
   */
  private async ensureApproversAvailable(tenant: TenantId, approvers: readonly UserId[]): Promise<void> {
    const userStore = this.options.userStore;
    if (userStore === undefined) return;
    for (const approver of approvers) {
      const account = await userStore.find(tenant, approver);
      if (account === null || !account.active) {
        throw new ApprovalInputError(`审批人 '${approver}' 不存在或不可用（须为当前租户内活动用户）`);
      }
    }
  }

  /** 案件详情：案件行 + 决策记录 + 迁移事件（事件账本可查口径）。 */
  async get(tenant: TenantId, caseIdParam: string): Promise<ApprovalCaseDetail> {
    const caseId = parseCaseIdParam(caseIdParam);
    const found = await this.cases.find(tenant, caseId);
    if (found === null) {
      throw new ApprovalNotFoundError(`租户 '${tenant}' 内不存在审批案件 '${caseId}'`);
    }
    const aggregate = { id: caseId, type: APPROVAL_CASE_AGGREGATE_TYPE };
    const [recordEntries, eventPage] = await Promise.all([
      this.records.byAggregate(aggregate),
      this.events.readByAggregate(aggregate),
    ]);
    return {
      case: found,
      records: recordEntries.map((entry) => entry.record),
      events: eventPage.events,
    };
  }

  /** 案件列表（可选状态精确过滤；新的在前）。 */
  async list(tenant: TenantId, stateFilter: unknown): Promise<readonly ApprovalCase[]> {
    const state = parseStateFilter(stateFilter);
    return this.cases.list(tenant, state === undefined ? undefined : { state });
  }

  /**
   * 审批决策：重放事件账本重建运行时 → 版本检查 → 守卫与迁移 →
   * 事件/记录落账 → 案件行乐观推进 → 决策人本人待办自动完成。
   */
  async act(
    tenant: TenantId,
    caseIdParam: string,
    actor: UserId,
    input: unknown,
  ): Promise<ApprovalActResult> {
    const caseId = parseCaseIdParam(caseIdParam);
    const payload = parseDecisionInput(input);
    const found = await this.cases.find(tenant, caseId);
    if (found === null) {
      throw new ApprovalNotFoundError(`租户 '${tenant}' 内不存在审批案件 '${caseId}'`);
    }
    const config = await this.configFor(tenant);
    if (found.flowConfigId !== config.flowId) {
      throw new ApprovalStateError(
        `案件由配置 '${found.flowConfigId}' 驱动，与当前生效配置 '${config.flowId}' 不符`,
      );
    }
    if (payload.objectVersion !== undefined && payload.objectVersion !== found.objectVersion) {
      throw new ApprovalConflictError(
        `版本冲突：决策声明 objectVersion=${payload.objectVersion}，案件当前 ${found.objectVersion}`,
      );
    }

    const runtime = await this.replay(found, config);
    try {
      const verb = this.decisionVerb(runtime.state(), payload.decision, config);
      const sendInput: ApprovalDecisionInput = {
        by: actor,
        reason: payload.reason,
        // 版本声明原样透传：不声明则守卫按引擎口径判定（versionGuard 对缺省 fail-closed）。
        ...(payload.objectVersion === undefined ? {} : { objectVersion: payload.objectVersion }),
      };
      const outcome = runtime.send(verb, sendInput);
      if (outcome.status === 'unhandled') {
        throw new ApprovalStateError(
          `状态 '${outcome.from}' 不支持决策 '${payload.decision}'（配置无对应迁移规则）`,
        );
      }
      if (outcome.status === 'blocked') {
        throw new ApprovalStateError(
          `状态 '${outcome.from}' 的决策 '${payload.decision}' 被守卫 '${outcome.guard}' 拒绝`,
        );
      }

      const aggregate = { id: caseId, type: APPROVAL_CASE_AGGREGATE_TYPE };
      await this.events.append(outcome.event);
      if (outcome.record !== undefined) {
        await this.records.append({ aggregate, record: outcome.record } satisfies ApprovalRecordStoreEntry);
      }
      const advanced = await this.cases.advance(
        tenant,
        caseId,
        found.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      const todosCompleted = await this.completeOwnTodos(tenant, actor, caseId);
      return {
        case: advanced,
        ...(outcome.record === undefined ? {} : { record: outcome.record }),
        event: outcome.event,
        todosCompleted,
      };
    } finally {
      runtime.stop();
    }
  }

  /** 重放案件事件账本重建运行时；重放结果必须与案件行一致（事实源 ↔ 投影对账）。 */
  private async replay(
    found: ApprovalCase,
    config: ApprovalFlowConfig,
  ): Promise<ReturnType<typeof startApprovalFlow>> {
    const aggregate = { id: found.id, type: APPROVAL_CASE_AGGREGATE_TYPE };
    const page = await this.events.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config,
      subject: { aggregate, initialObjectVersion: 1 },
    });
    for (const event of page.events) {
      const evidence = event.payload.record?.evidence;
      const sendInput: ApprovalDecisionInput = {
        by: UserId.create(event.payload.actor),
        reason: event.payload.reason,
        ...(evidence === undefined || evidence.length === 0 ? {} : { evidence: [...evidence] }),
        // 声明 = 事件后版本 - 1（提交人所见版本），与 versionGuard 口径一致。
        objectVersion: event.payload.objectVersion - 1,
      };
      const outcome = runtime.send(event.payload.event, sendInput);
      if (outcome.status !== 'transitioned') {
        runtime.stop();
        throw new ApprovalStateError(
          `事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== found.state || runtime.objectVersion() !== found.objectVersion) {
      runtime.stop();
      throw new ApprovalStateError(
        `事件账本与案件行不一致：案件 ${found.state}@v${found.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 按决策类反查配置迁移规则取命令动词；当前状态无该类决策 → 状态冲突。 */
  private decisionVerb(
    state: string,
    decision: ApprovalDecisionKind,
    config: ApprovalFlowConfig,
  ): string {
    const rule = config.transitions.find(
      (candidate) => candidate.from === state && candidate.decision === decision,
    );
    if (rule === undefined) {
      throw new ApprovalStateError(`状态 '${state}' 不支持决策 '${decision}'`);
    }
    return rule.event;
  }

  private mustTransition(outcome: ApprovalSendOutcome, what: string): asserts outcome is Extract<ApprovalSendOutcome, { status: 'transitioned' }> {
    if (outcome.status !== 'transitioned') {
      throw new ApprovalStateError(`${what}失败：状态 '${outcome.from}' 对命令返回 ${outcome.status}`);
    }
  }

  /** 审批人决策后：本人名下该案件（source='approval'）的 open 待办逐条完成。 */
  private async completeOwnTodos(tenant: TenantId, actor: UserId, caseId: string): Promise<readonly TodoItem[]> {
    const own = await this.todos.listOwn(tenant, actor);
    const completed: TodoItem[] = [];
    for (const todo of own) {
      if (todo.source === APPROVAL_TODO_SOURCE && todo.refId === caseId && todo.status === 'open') {
        const done = await this.todos.complete(tenant, actor, todo.id);
        if (done !== null) completed.push(done);
      }
    }
    return completed;
  }
}
