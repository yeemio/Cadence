/**
 * PayrollService —— 薪酬核算用例编排（M3，m3-drafts/01-payroll.md v1.0）。
 * 零框架业务类（不 import @nestjs/*；注册面/激活开关接线归组合根与总控）。
 * 账本域无状态机（ADR-0010；G2 建单序不适用）：规则=版本化数据（发布/修订=
 * 新版本行，历史核算引用旧版本可复算）；月度核算=可重算快照（supersedes 版本
 * 链，幂等重算零漂移——对齐 hours LaborLedgerMonth / costing CostSnapshot）；
 * 薪酬记录=append-only 产出事实（重算逐条重写新行、不改原行——costing delta
 * 先例）。
 *
 * 命令三件（合同 §3，G1 口径：先解析校验后记账——被拒命令不占用 operationId）：
 *  - payroll.rule.publish.v1：发布/修订计薪规则（86 维护面：按人定价=
 *    scope.personId 规则；工种兜底=无 person 规则；周期兜底=无 scope 规则；
 *    演进=新版本，expectedRevision 乐观锁）；
 *  - payroll.run.month.v1：月度核算/重算（幂等：同规则版本集合同事实重算不
 *    追加新版本行；变更重算=新 operationId → 新 PayRun 版本 supersedes 旧
 *    快照 + EarningsRecord 逐条重写新行）；
 *  - payroll.export.v1：工资核算结果导出（导出端口化；读型命令，不落事实）。
 *
 * 规则匹配优先级（合同 §7/§8 #1，行为等价对账锚）：person 精确 > laborKind >
 * 周期兜底——四档 tier：person+工种 > 仅 person > 仅工种 > 兜底；同档多条命中
 * = 配置歧义，整批 rejected（不静默取首条）。
 *
 * 量纲换算（合同 §2 冻结）：amount(分) = quantity(小时，不取整) ×
 * rate(分/小时整数) × coefficient，half-up 到分（earningsAmountMinor 唯一实现）。
 *
 * 事件追加失败窗口返回 indeterminate(retrySafe=true)（重放安全，取舍同
 * hours/costing：事实幂等键完整——sourceKey + 版本唯一约束）。
 */
import type {
  BusinessEvent,
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
  UserId,
} from '@smes/business-core';
import { UserId as UserIdBrand } from '@smes/business-core';
import { PayrollNotFoundError, isPayrollConflict } from './payroll-errors.js';
import {
  PAYROLL_EVENT_TYPES,
  makePayRunComputedEvent,
  makePayrollRulePublishedEvent,
  type PayrollEventProvenance,
} from './payroll-events.js';
import {
  parsePayrollExportPayload,
  parsePayrollRulePublishPayload,
  parsePayrollRunMonthPayload,
  requirePeriodHours,
  type PayrollCommandEnvelope,
} from './payroll-input.js';
import { isLaborKind, earningsAmountMinor, type LaborKind } from './payroll-config.js';
import { EMPTY_PAYROLL_SOURCE, type PayrollSource, type VerifiedLaborFact } from './ports.js';
import type { PayRunId } from './payroll-ids.js';
import type {
  EarningsRecordRow,
  PayrollRuleRow,
  PayRunRow,
  PayRunRuleRef,
  PayrollStores,
} from './payroll-stores.js';
import { JsonTablesPayrollExportPort, type PayrollExportOutput, type PayrollExportPort } from './payroll-export.js';

// ---- 结果形状 ----

/** 规则版本视图（版本链 + 推导态）。 */
export interface PayrollRuleView {
  /** 版本行 id（prl-<uuidv7>）。 */
  readonly id: string;
  readonly ruleId: string;
  readonly name: string | null;
  readonly basis: PayrollRuleRow['basis'];
  readonly rateMinor: number;
  readonly coefficient: number;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly objectVersion: number;
  /** current = 该 ruleId 当前版本；superseded = 历史版本。 */
  readonly status: 'current' | 'superseded';
  readonly supersedes: string | null;
  readonly createdAt: string;
}

/** 月度核算的单人回执。 */
export interface PayRunGroupResult {
  readonly personId: string;
  readonly payRunId: string;
  readonly objectVersion: number;
  readonly totalQuantity: number;
  readonly totalAmountMinor: number;
  readonly lineCount: number;
  /** true = 本轮追加了新版本快照行；false = 幂等重算（值未变，未追加）。 */
  readonly changed: boolean;
}

export interface PayrollCommitted extends CommittedOutcome {
  /** payroll.rule.publish 回执。 */
  readonly rule?: PayrollRuleView;
  /** payroll.run.month 回执。 */
  readonly periodKey?: string;
  readonly personId?: string | null;
  readonly personsComputed?: number;
  readonly runsWritten?: number;
  readonly recordsWritten?: number;
  readonly runs?: readonly PayRunGroupResult[];
  /** payroll.export 回执（导出端口产物）。 */
  readonly export?: PayrollExportOutput;
}

export type PayrollCommandResult = PayrollCommitted | RejectedOutcome | IndeterminateOutcome;

export interface PayrollServiceOptions {
  /** 时钟注入（事件 occurredAt 与快照 computedAt 取时点；测试确定性）。 */
  readonly now?: () => string;
}

// ---- 读视图 ----

/** 核算结果明细行（下钻 sourceRefs 至 hours LaborEntry）。 */
export interface EarningsLineView {
  readonly recordId: string;
  readonly personId: string;
  readonly periodKey: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly laborKind: LaborKind;
  readonly quantity: number;
  readonly rateMinor: number;
  readonly coefficient: number;
  readonly amountMinor: number;
  readonly payRunId: string;
  readonly sourceRefs: readonly string[];
}

/** 单人核算结果（当前版 PayRun + 明细行）。 */
export interface PersonRunView {
  readonly personId: string;
  readonly periodKey: string;
  readonly payRunId: string;
  readonly objectVersion: number;
  readonly ruleVersions: readonly PayRunRuleRef[];
  readonly totalQuantity: number;
  readonly totalAmountMinor: number;
  readonly lineCount: number;
  readonly status: 'current';
  readonly lines: readonly EarningsLineView[];
}

/** 规则版本对比视图。 */
export interface RuleVersionDiff {
  readonly field: string;
  readonly versionA: string;
  readonly versionB: string;
}

export interface RuleComparison {
  readonly ruleId: string;
  readonly versionA: number;
  readonly versionB: number;
  readonly changed: readonly RuleVersionDiff[];
}

// ---- 规则匹配（纯函数：优先级行为的唯一实现） ----

/** 每规则业务身份取当前版本（版本链末位；listAll 已按版本升序）。 */
export function currentRuleVersions(rows: readonly PayrollRuleRow[]): readonly PayrollRuleRow[] {
  const latest = new Map<string, PayrollRuleRow>();
  for (const row of rows) {
    const key = row.ruleId;
    const current = latest.get(key);
    if (current === undefined || row.objectVersion > current.objectVersion) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

/** 匹配结果（歧义/缺规则都显式暴露，不静默）。 */
export type RuleMatchResult =
  | { readonly matched: true; readonly rule: PayrollRuleRow; readonly tier: 1 | 2 | 3 | 4 }
  | { readonly matched: false; readonly kind: 'no-rule' | 'ambiguous'; readonly detail: string };

/**
 * 规则匹配优先级（合同 §7 对账锚：person 精确 > laborKind > 周期兜底）：
 *   tier 1 = personId + laborKind 双精确；tier 2 = 仅 personId；
 *   tier 3 = 仅 laborKind；tier 4 = 无 scope 兜底。
 * 取首个命中档；同档多条命中 = 配置歧义（no-rule/ambiguous 均显式拒）。
 * projectId 规则不参与月度匹配——VerifiedLaborFact 无项目维度，项目口径
 * 规则静默套用到全量事实会造成金额错配（合同 §10 防过早抽象同精神）。
 */
export function matchPayrollRule(
  currentRules: readonly PayrollRuleRow[],
  personId: UserId,
  laborKind: LaborKind,
): RuleMatchResult {
  const eligible = currentRules.filter(
    (rule) => rule.basis === 'hours' && rule.scope.projectId === undefined,
  );
  const tiers: readonly { readonly tier: 1 | 2 | 3 | 4; readonly rows: readonly PayrollRuleRow[] }[] = [
    {
      tier: 1,
      rows: eligible.filter(
        (rule) => rule.scope.personId === personId && rule.scope.laborKind === laborKind,
      ),
    },
    {
      tier: 2,
      rows: eligible.filter(
        (rule) => rule.scope.personId === personId && rule.scope.laborKind === undefined,
      ),
    },
    {
      tier: 3,
      rows: eligible.filter(
        (rule) => rule.scope.personId === undefined && rule.scope.laborKind === laborKind,
      ),
    },
    {
      tier: 4,
      rows: eligible.filter(
        (rule) => rule.scope.personId === undefined && rule.scope.laborKind === undefined,
      ),
    },
  ];
  for (const { tier, rows } of tiers) {
    if (rows.length === 0) continue;
    if (rows.length > 1) {
      return {
        matched: false,
        kind: 'ambiguous',
        detail: `匹配档 ${tier} 命中多条规则（${rows.map((row) => `${row.ruleId}@v${row.objectVersion}`).join('/')}）——同档歧义，请收敛规则配置后重发`,
      };
    }
    return { matched: true, rule: rows[0]!, tier };
  }
  return {
    matched: false,
    kind: 'no-rule',
    detail: `无可匹配计薪规则（人员 ${personId} × 工种 ${laborKind}；需按人规则/工种兜底/周期兜底之一，projectId 规则不参与月度匹配）`,
  };
}

// ---- 核算行构造（纯数据；快照与记录共用的中间形状） ----

interface ComputedLine {
  readonly personId: UserId;
  readonly laborKind: LaborKind;
  readonly ruleId: PayrollRuleRow['ruleId'];
  readonly ruleVersion: number;
  readonly rateMinor: number;
  readonly coefficient: number;
  readonly quantity: number;
  readonly amountMinor: number;
  readonly sourceRefs: readonly string[];
}

/** 单人期望快照（lines 已按 laborKind 排序——比较与落账共用）。 */
interface ComputedPerson {
  readonly personId: UserId;
  readonly lines: readonly ComputedLine[];
  readonly ruleVersions: readonly PayRunRuleRef[];
  readonly totalQuantity: number;
  readonly totalAmountMinor: number;
}

/** 行级幂等比较签名（逐字段精确比较——零漂移纪律：同输入同输出）。 */
function lineSignature(line: ComputedLine): string {
  return [
    line.personId,
    line.laborKind,
    line.ruleId,
    `v${line.ruleVersion}`,
    String(line.rateMinor),
    String(line.coefficient),
    String(line.quantity),
    String(line.amountMinor),
    [...line.sourceRefs].sort().join(','),
  ].join('|');
}

function currentRecordsSignature(lines: readonly EarningsRecordRow[]): string[] {
  return [...lines]
    .sort((a, b) => a.laborKind.localeCompare(b.laborKind))
    .map((line) =>
      [
        line.personId,
        line.laborKind,
        line.ruleId,
        `v${line.ruleVersion}`,
        String(line.rateMinor),
        String(line.coefficient),
        String(line.quantity),
        String(line.amountMinor),
        [...line.sourceRefs].sort().join(','),
      ].join('|'),
    );
}

// ---- 服务 ----

export class PayrollService {
  private readonly now: () => string;

  constructor(
    private readonly stores: PayrollStores,
    private readonly source: PayrollSource = EMPTY_PAYROLL_SOURCE,
    private readonly exportPort: PayrollExportPort = new JsonTablesPayrollExportPort(),
    options: PayrollServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: PayrollCommandEnvelope): Promise<PayrollCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'payroll.rule.publish.v1':
          return await this.publishRule(tenant, envelope);
        case 'payroll.run.month.v1':
          return await this.runMonth(tenant, envelope);
        case 'payroll.export.v1':
          return await this.exportPayroll(tenant, envelope);
      }
    } catch (error) {
      if (isPayrollConflict(error)) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（G1：先解析校验后记账）。调用点在各命令 handler 的载荷
   * 解析与业务校验全部通过、首个持久写（或导出效果）之前——被拒命令不占用
   * operationId，同 id 修正重发可重新评估；已 committed 的同 id 重发在此被拒
   * （不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: PayrollCommandEnvelope): Promise<PayrollCommandResult | null> {
    const claimed = await this.stores.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: PayrollCommandEnvelope): PayrollEventProvenance {
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
    extra: Omit<PayrollCommitted, keyof CommittedOutcome | 'events'>,
    failureContext: string,
  ): Promise<PayrollCommandResult> {
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

  // ---- payroll.rule.publish.v1 ----

  private async publishRule(tenant: TenantId, envelope: PayrollCommandEnvelope): Promise<PayrollCommandResult> {
    const payload = parsePayrollRulePublishPayload(envelope.command.payload);
    const versions = await this.stores.rules.versions(tenant, payload.ruleId);
    const current = versions.length > 0 ? versions[versions.length - 1]! : null;
    if (envelope.expectedRevision === 'initial') {
      if (current !== null) {
        return {
          status: 'rejected',
          reason: `计薪规则 '${payload.ruleId}' 已存在（当前 v${current.objectVersion}），修订请声明 expectedRevision=${current.objectVersion}`,
        };
      }
    } else {
      if (current === null) {
        return {
          status: 'rejected',
          reason: `计薪规则 '${payload.ruleId}' 不存在，无版本可修订（首发请走 expectedRevision='initial'）`,
        };
      }
      if (envelope.expectedRevision !== current.objectVersion) {
        return {
          status: 'rejected',
          reason: `乐观锁冲突：计薪规则 '${payload.ruleId}' 声明 expectedRevision=${String(envelope.expectedRevision)}，当前 objectVersion=${current.objectVersion}（不重试同信封）`,
        };
      }
    }
    // 先解析校验后记账（G1）：发布/修订语义守门全过、版本行落账前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.rules.insert({
      tenant,
      ruleId: payload.ruleId,
      name: payload.name,
      basis: payload.basis,
      rateMinor: payload.rateMinor,
      coefficient: payload.coefficient,
      scope: payload.scope,
      objectVersion: current === null ? 1 : current.objectVersion + 1,
      supersedes: current === null ? null : current.id,
      auditStatus: 'published',
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makePayrollRulePublishedEvent(tenant, row, this.provenanceOf(envelope), this.now());
    return this.commitOutcome([event], { rule: this.toRuleView(row, true) }, '规则版本行已落账但事件追加失败');
  }

  // ---- payroll.run.month.v1（月度核算/重算） ----

  private async runMonth(tenant: TenantId, envelope: PayrollCommandEnvelope): Promise<PayrollCommandResult> {
    const payload = parsePayrollRunMonthPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `payroll.run.month 的 expectedRevision 须为 'initial'（核算是执行事实，无目标版本可锁），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    const focusedPerson = payload.personId === undefined ? null : UserIdBrand.create(payload.personId);
    // ---- 全量前置校验（G1：以下全部通过才 claim operationId） ----
    // 1) 端口事实读取与词汇表门禁（未知工种词整批拒绝，不静默归类）。
    const facts = await this.source.readVerifiedLabor({
      tenantId: tenant,
      periodKey: payload.periodKey,
      ...(focusedPerson === null ? {} : { personIds: [focusedPerson] }),
    });
    const factError = validateFacts(facts, payload.periodKey);
    if (factError !== null) return { status: 'rejected', reason: factError };
    // 2) 规则匹配（纯读；歧义/缺规则整批拒绝——被拒不占用 operationId）。
    const currentRules = currentRuleVersions(await this.stores.rules.listAll(tenant));
    const computed = computePersons(facts, currentRules);
    const matchError = computed.error;
    if (matchError !== null) return { status: 'rejected', reason: matchError };
    const persons = [...computed.persons]; // 已按 personId 排序
    // 单人聚焦但端口零事实：期望态 = 空行集（与当前批次比较——有历史批次则
    // 落新版本清零快照；无历史批次则无可核算，不落空行）。
    if (focusedPerson !== null && !persons.some((person) => person.personId === focusedPerson)) {
      persons.push({
        personId: focusedPerson,
        lines: [],
        ruleVersions: [],
        totalQuantity: 0,
        totalAmountMinor: 0,
      });
    }

    // ---- claim 后进入落账区 ----
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    const events: BusinessEvent[] = [];
    const results: PayRunGroupResult[] = [];
    let runsWritten = 0;
    let recordsWritten = 0;

    for (const person of persons) {
      const chain = await this.stores.runs.chain(tenant, payload.periodKey, person.personId);
      // 无历史批次且无事实（单人聚焦空补位）：不落空行批次，无回执。
      if (chain.length === 0 && person.lines.length === 0) continue;
      const latest = chain.length > 0 ? chain[chain.length - 1]! : null;
      const currentLines =
        latest === null
          ? []
          : await this.stores.records.list(tenant, {
              periodKey: payload.periodKey,
              personId: person.personId,
              payRunId: latest.id,
            });
      const desiredSignature = person.lines.map((line) => lineSignature(line));
      const currentSignature = currentRecordsSignature(currentLines);
      const ruleSetSame =
        latest !== null &&
        [...latest.ruleVersions]
          .map((ref) => `${ref.ruleId}@v${ref.ruleVersion}`)
          .sort()
          .join(',') ===
        [...person.ruleVersions].map((ref) => `${ref.ruleId}@v${ref.ruleVersion}`).sort().join(',');
      const unchanged =
        latest !== null &&
        ruleSetSame &&
        desiredSignature.length === currentSignature.length &&
        desiredSignature.every((signature, index) => signature === currentSignature[index]);
      if (unchanged) {
        // 幂等重算：值未变不追加新版本行、不重写记录，仅留动作事件（changed=false）。
        events.push(makePayRunComputedEvent(tenant, latest!, false, provenance, this.now()));
        results.push({
          personId: person.personId,
          payRunId: latest!.id,
          objectVersion: latest!.objectVersion,
          totalQuantity: latest!.totalQuantity,
          totalAmountMinor: latest!.totalAmountMinor,
          lineCount: latest!.lineCount,
          changed: false,
        });
        continue;
      }
      const run = await this.stores.runs.insert({
        tenant,
        personId: person.personId,
        periodKey: payload.periodKey,
        periodKind: 'month',
        ruleVersions: person.ruleVersions,
        totalQuantity: person.totalQuantity,
        totalAmountMinor: person.totalAmountMinor,
        lineCount: person.lines.length,
        computedBy: actor,
        computedAt: this.now(),
        objectVersion: latest === null ? 1 : latest.objectVersion + 1,
        supersedes: latest === null ? null : latest.id,
        auditStatus: 'computed',
        provenance,
        businessTime: `${payload.periodKey}-01`,
      });
      runsWritten += 1;
      for (const line of person.lines) {
        await this.stores.records.insert({
          tenant,
          personId: line.personId,
          periodKey: payload.periodKey,
          ruleId: line.ruleId,
          ruleVersion: line.ruleVersion,
          basis: 'hours',
          laborKind: line.laborKind,
          quantity: line.quantity,
          rateMinor: line.rateMinor,
          coefficient: line.coefficient,
          amountMinor: line.amountMinor,
          payRunId: run.id,
          sourceRefs: line.sourceRefs,
          sourceKey: `run:${run.id}|${line.personId}|${line.laborKind}`,
          occurredAt: this.now(),
          recordedBy: actor,
          auditStatus: 'computed',
          provenance,
          businessTime: `${payload.periodKey}-01`,
        });
        recordsWritten += 1;
      }
      events.push(makePayRunComputedEvent(tenant, run, true, provenance, this.now()));
      results.push({
        personId: person.personId,
        payRunId: run.id,
        objectVersion: run.objectVersion,
        totalQuantity: run.totalQuantity,
        totalAmountMinor: run.totalAmountMinor,
        lineCount: run.lineCount,
        changed: true,
      });
    }
    return this.commitOutcome(
      events,
      {
        periodKey: payload.periodKey,
        personId: payload.personId ?? null,
        personsComputed: results.length,
        runsWritten,
        recordsWritten,
        runs: results,
      },
      '核算批次/薪酬记录行已落账但事件追加失败',
    );
  }

  // ---- payroll.export.v1（导出端口化；读型命令不落事实） ----

  private async exportPayroll(tenant: TenantId, envelope: PayrollCommandEnvelope): Promise<PayrollCommandResult> {
    const payload = parsePayrollExportPayload(envelope.command.payload);
    // 前置校验：该月（或该人）须已有核算批次——空导出拒绝（显式优于空回声）。
    const focus = payload.personId === undefined ? undefined : UserIdBrand.create(payload.personId);
    const views = await this.currentRunViews(tenant, payload.periodKey, focus);
    if (focus !== undefined && views.length === 0) {
      return { status: 'rejected', reason: `人员 '${payload.personId}' 在 ${payload.periodKey} 无核算批次（先执行 payroll.run.month）` };
    }
    if (focus === undefined && views.length === 0) {
      return { status: 'rejected', reason: `周期 ${payload.periodKey} 无任何核算批次（先执行 payroll.run.month）` };
    }
    // G1：口径守门全过、导出效果前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const detailLines = await this.stores.records.list(tenant, {
      periodKey: payload.periodKey,
      ...(focus === undefined ? {} : { personId: focus }),
    });
    const currentRunIds = new Set(views.map((view) => view.payRunId));
    const currentLines = detailLines.filter((line) => currentRunIds.has(line.payRunId));
    const output = await this.exportPort.exportWorkbook([
      {
        name: '工资汇总',
        header: ['人员', '周期', '批次', '批次版本', '净工时(小时)', '金额(分)', '行数'],
        rows: views.map((view) => [
          view.personId,
          view.periodKey,
          view.payRunId,
          String(view.objectVersion),
          String(view.totalQuantity),
          String(view.totalAmountMinor),
          String(view.lineCount),
        ]),
      },
      {
        name: '工资明细',
        header: ['人员', '周期', '工种', '规则', '规则版本', '量(小时)', '时薪(分/小时)', '系数', '金额(分)', '来源工时账目'],
        rows: [...currentLines]
          .sort((a, b) => a.personId.localeCompare(b.personId) || a.laborKind.localeCompare(b.laborKind))
          .map((line) => [
            line.personId,
            line.periodKey,
            line.laborKind,
            line.ruleId,
            String(line.ruleVersion),
            String(line.quantity),
            String(line.rateMinor),
            String(line.coefficient),
            String(line.amountMinor),
            line.sourceRefs.join(','),
          ]),
      },
    ]);
    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      periodKey: payload.periodKey,
      personId: payload.personId ?? null,
      export: output,
    };
  }

  // ---- 查询（读路径） ----

  private toRuleView(row: PayrollRuleRow, isCurrent: boolean): PayrollRuleView {
    return {
      id: row.id,
      ruleId: row.ruleId,
      name: row.name,
      basis: row.basis,
      rateMinor: row.rateMinor,
      coefficient: row.coefficient,
      scope: row.scope as Readonly<Record<string, unknown>>,
      objectVersion: row.objectVersion,
      status: isCurrent ? 'current' : 'superseded',
      supersedes: row.supersedes,
      createdAt: row.createdAt,
    };
  }

  /** 规则版本列表（可选 ruleId 过滤；同规则当前版在前）。 */
  async ruleVersions(tenant: TenantId, ruleId?: PayrollRuleRow['ruleId']): Promise<readonly PayrollRuleView[]> {
    const rows =
      ruleId === undefined
        ? await this.stores.rules.listAll(tenant)
        : await this.stores.rules.versions(tenant, ruleId);
    const currentVersions = new Map<string, number>();
    for (const row of rows) {
      currentVersions.set(row.ruleId, Math.max(currentVersions.get(row.ruleId) ?? 0, row.objectVersion));
    }
    return rows
      .map((row) => this.toRuleView(row, row.objectVersion === currentVersions.get(row.ruleId)))
      .sort(
        (a, b) =>
          a.ruleId.localeCompare(b.ruleId) || b.objectVersion - a.objectVersion,
      );
  }

  /** 规则版本详情（当前版 + 全版本链——历史版本可复算回看）。 */
  async ruleDetail(
    tenant: TenantId,
    ruleId: PayrollRuleRow['ruleId'],
  ): Promise<{ current: PayrollRuleView; versions: readonly PayrollRuleView[] }> {
    const chain = await this.stores.rules.versions(tenant, ruleId);
    if (chain.length === 0) {
      throw new PayrollNotFoundError(`租户 '${tenant}' 内不存在计薪规则 '${ruleId}'`);
    }
    const views = await this.ruleVersions(tenant, ruleId);
    return { current: views[0]!, versions: views };
  }

  /** 规则版本对比（字段级差异：换价/改系数复盘锚点）。 */
  async compareRules(
    tenant: TenantId,
    ruleId: PayrollRuleRow['ruleId'],
    versionA: number,
    versionB: number,
  ): Promise<RuleComparison> {
    const chain = await this.stores.rules.versions(tenant, ruleId);
    if (chain.length === 0) {
      throw new PayrollNotFoundError(`租户 '${tenant}' 内不存在计薪规则 '${ruleId}'`);
    }
    const rowA = chain.find((row) => row.objectVersion === versionA);
    const rowB = chain.find((row) => row.objectVersion === versionB);
    if (rowA === undefined || rowB === undefined) {
      throw new PayrollNotFoundError(
        `计薪规则 '${ruleId}' 不存在版本 ${rowA === undefined ? versionA : versionB}（可用版本：${chain.map((row) => row.objectVersion).join('/')}）`,
      );
    }
    const changed: RuleVersionDiff[] = [];
    const fields: readonly (readonly [string, (row: PayrollRuleRow) => string])[] = [
      ['rateMinor', (row) => String(row.rateMinor)],
      ['coefficient', (row) => String(row.coefficient)],
      ['basis', (row) => row.basis],
      ['name', (row) => row.name ?? ''],
      ['scope', (row) => JSON.stringify(row.scope)],
    ];
    for (const [field, pick] of fields) {
      const a = pick(rowA);
      const b = pick(rowB);
      if (a !== b) changed.push({ field, versionA: a, versionB: b });
    }
    return { ruleId, versionA, versionB, changed };
  }

  /** 该周期全部（或单人）当前版核算结果（含明细行与 sourceRefs 下钻）。 */
  async runResults(
    tenant: TenantId,
    periodKey: string,
    personId?: UserId,
  ): Promise<readonly PersonRunView[]> {
    return this.currentRunViews(tenant, periodKey, personId);
  }

  /** 我的工资（本人已核算口径——数据权限"本人"，personId 只取调用方身份）。 */
  async myPayroll(
    tenant: TenantId,
    person: UserId,
    periodKey?: string,
  ): Promise<readonly PersonRunView[]> {
    const rows =
      periodKey === undefined
        ? await this.stores.runs.listByPerson(tenant, person)
        : await this.stores.runs.listByPeriod(tenant, periodKey, person);
    return this.personViewsOf(tenant, rows);
  }

  /** 核算批次版本链（人×周期：重算留痕回看）。 */
  async runChain(tenant: TenantId, periodKey: string, personId: UserId): Promise<readonly PayRunRow[]> {
    return this.stores.runs.chain(tenant, periodKey, personId);
  }

  /** 指定批次行详情 + 其薪酬记录（历史版本按当时规则版本复算回看）。 */
  async runDetail(
    tenant: TenantId,
    payRunId: PayRunId,
  ): Promise<{ run: PayRunRow; lines: readonly EarningsRecordRow[] }> {
    const run = await this.stores.runs.find(tenant, payRunId);
    if (run === null) {
      throw new PayrollNotFoundError(`租户 '${tenant}' 内不存在核算批次 '${payRunId}'`);
    }
    const lines = await this.stores.records.list(tenant, { payRunId });
    return { run, lines };
  }

  /** 薪酬记录下钻：按来源工时账目引用反查（对账锚点——hours LaborEntry → 金额）。 */
  async earningsBySourceRef(tenant: TenantId, sourceRef: string): Promise<readonly EarningsRecordRow[]> {
    const all = await this.stores.records.list(tenant);
    return all.filter((line) => line.sourceRefs.includes(sourceRef));
  }

  /** 事件读（审计/调试口径，occurredAt 升序）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }

  // ---- 内部：当前版视图组装 ----

  private async currentRunViews(
    tenant: TenantId,
    periodKey: string,
    personId?: UserId,
  ): Promise<readonly PersonRunView[]> {
    const rows = await this.stores.runs.listByPeriod(tenant, periodKey, personId);
    return this.personViewsOf(tenant, rows);
  }

  /** 行集 → 每人（×周期）当前版 PayRun 视图（含明细行）。 */
  private async personViewsOf(tenant: TenantId, rows: readonly PayRunRow[]): Promise<readonly PersonRunView[]> {
    const latestByPerson = new Map<string, PayRunRow>(); // key = `${personId}|${periodKey}`（listByPerson 跨周期分组）
    for (const row of rows) {
      const key = `${row.personId}|${row.periodKey}`;
      const current = latestByPerson.get(key);
      if (current === undefined || row.objectVersion > current.objectVersion) {
        latestByPerson.set(key, row);
      }
    }
    const views: PersonRunView[] = [];
    for (const [, run] of [...latestByPerson.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const lines = await this.stores.records.list(tenant, { payRunId: run.id });
      views.push({
        personId: run.personId,
        periodKey: run.periodKey,
        payRunId: run.id,
        objectVersion: run.objectVersion,
        ruleVersions: run.ruleVersions,
        totalQuantity: run.totalQuantity,
        totalAmountMinor: run.totalAmountMinor,
        lineCount: run.lineCount,
        status: 'current',
        lines: lines.map((line) => ({
          recordId: line.id,
          personId: line.personId,
          periodKey: line.periodKey,
          ruleId: line.ruleId,
          ruleVersion: line.ruleVersion,
          laborKind: line.laborKind,
          quantity: line.quantity,
          rateMinor: line.rateMinor,
          coefficient: line.coefficient,
          amountMinor: line.amountMinor,
          payRunId: line.payRunId,
          sourceRefs: line.sourceRefs,
        })),
      });
    }
    return views;
  }
}

// ---- 纯函数：事实校验与核算分组（对账口径的唯一实现） ----

/** 端口事实门禁：周期一致 + 工种五词 + 量纲合法；返回 null = 全过。 */
function validateFacts(facts: readonly VerifiedLaborFact[], periodKey: string): string | null {
  for (const fact of facts) {
    if (fact.periodKey !== periodKey) {
      return `端口事实周期不符：期望 '${periodKey}'，得到 '${fact.periodKey}'（人员 ${fact.personId}）——PayrollSource 适配器须按周期键过滤`;
    }
    if (!isLaborKind(fact.laborKind)) {
      return `未知工种 '${String(fact.laborKind)}'（人员 ${fact.personId}）：须为 part/assembly/electrical/aftermarket/oddjob 之一——整批拒绝核算，不静默归类`;
    }
    try {
      requirePeriodHours(fact.hours, `事实净工时（人员 ${fact.personId} × 工种 ${fact.laborKind}）`);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (!Array.isArray(fact.sourceEntryIds) || fact.sourceEntryIds.some((id) => typeof id !== 'string')) {
      return `来源账目引用非法（人员 ${fact.personId} × 工种 ${fact.laborKind}）：sourceEntryIds 须为字符串数组`;
    }
  }
  return null;
}

/** 事实 → 人×工种分组 → 规则匹配 → 金额换算（对账口径：人×工种金额 = Σ 净工时 × 时薪 × 系数）。 */
function computePersons(
  facts: readonly VerifiedLaborFact[],
  currentRules: readonly PayrollRuleRow[],
): { persons: readonly ComputedPerson[]; error: string | null } {
  // 分组：personId（品牌化身份原值作键）→ laborKind → 事实集。
  const byPerson = new Map<string, { personId: UserId; kinds: Map<LaborKind, VerifiedLaborFact[]> }>();
  for (const fact of facts) {
    const bucket = byPerson.get(fact.personId) ?? { personId: fact.personId, kinds: new Map<LaborKind, VerifiedLaborFact[]>() };
    const kindBucket = bucket.kinds.get(fact.laborKind) ?? [];
    kindBucket.push(fact);
    bucket.kinds.set(fact.laborKind, kindBucket);
    byPerson.set(fact.personId, bucket);
  }
  const persons: ComputedPerson[] = [];
  for (const bucket of [...byPerson.values()].sort((a, b) => a.personId.localeCompare(b.personId))) {
    const lines: ComputedLine[] = [];
    for (const [laborKind, groupFacts] of [...bucket.kinds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const match = matchPayrollRule(currentRules, bucket.personId, laborKind);
      if (!match.matched) {
        return { persons: [], error: `核算中止（人员 ${bucket.personId} × 工种 ${laborKind}）：${match.detail}` };
      }
      const rule = match.rule;
      const quantity = groupFacts.reduce((sum, fact) => sum + fact.hours, 0);
      const sourceRefs = [...new Set(groupFacts.flatMap((fact) => [...fact.sourceEntryIds]))].sort();
      lines.push({
        personId: bucket.personId,
        laborKind,
        ruleId: rule.ruleId,
        ruleVersion: rule.objectVersion,
        rateMinor: rule.rateMinor,
        coefficient: rule.coefficient,
        quantity,
        amountMinor: earningsAmountMinor(quantity, rule.rateMinor, rule.coefficient),
        sourceRefs,
      });
    }
    const ruleVersions = [
      ...new Map(lines.map((line) => [`${line.ruleId}@v${line.ruleVersion}`, { ruleId: line.ruleId, ruleVersion: line.ruleVersion }])).values(),
    ].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    persons.push({
      personId: bucket.personId,
      lines,
      ruleVersions,
      totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
      totalAmountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
    });
  }
  return { persons, error: null };
}
