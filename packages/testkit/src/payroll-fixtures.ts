/**
 * payroll 模块联动夹具（M3）。
 *
 * 工时事实源端口（PayrollSource——hours 产出口径 VerifiedLaborFact）的可注入
 * 假实现——供 payroll 核算联动验证与对账测试使用（真实端口由组合根适配器
 * 提供：读 hours 月度归集/工时条目查询拼装该形状，R-M3-3）。
 *
 * 类型取舍同 hours-fixtures / costing-fixtures：本地结构化镜像类型（testkit
 * rootDir 不含 payroll 源），结构化兼容——假实现可直接注入 PayrollService 的
 * source 参数位。工种五词与量纲（rate=分/小时、amount=分）按 m3 冻结合同。
 */

// ---- 本地结构化类型（镜像 packages/payroll/src/ports.ts 合同） ----

/** 工种稳定码镜像（m2 v1.1 冻结五词，与 payroll LABOR_KINDS 同词表）。 */
export type FixtureLaborKind = 'part' | 'assembly' | 'electrical' | 'aftermarket' | 'oddjob';

/** 已审核工时事实镜像（人×周期键×工种×已审核净工时+来源账目 id）。 */
export interface FixtureVerifiedLaborFact {
  readonly personId: string;
  /** 周期锚 'YYYY-MM'。 */
  readonly periodKey: string;
  readonly laborKind: FixtureLaborKind;
  /** 已审核净工时（小时；撤销冲销后净额，不取整）。 */
  readonly hours: number;
  /** 来源工时账目 id（hours LaborEntry 引用）。 */
  readonly sourceEntryIds: readonly string[];
}

/** 工时事实读取请求镜像。 */
export interface FixturePayrollLaborRequest {
  readonly periodKey: string;
  /** 缺省 = 周期内全部人员。 */
  readonly personIds?: readonly string[];
}

// ---- 命令提交体基线（录制/回放对账用） ----

/** payroll.rule.publish 提交体（86 时薪维护面：按人/按工种兜底/周期兜底）。 */
export interface FixtureRulePublishSubmission {
  readonly ruleId: string;
  readonly rateMinor: number;
  readonly coefficient?: number;
  readonly scope?: {
    readonly personId?: string;
    readonly laborKind?: FixtureLaborKind;
    readonly projectId?: string;
  };
}

/** 月度核算/导出提交体（87：periodKey 'YYYY-MM'，可选单人聚焦）。 */
export interface FixturePeriodSubmission {
  readonly periodKey: string;
  readonly personId?: string;
}

// ---- 工时事实源假端口 ----

/** verified 工时事实的常用缺省（覆盖差异字段即可）。 */
export function fixtureVerifiedLaborFact(
  overrides: Partial<FixtureVerifiedLaborFact> = {},
): FixtureVerifiedLaborFact {
  return {
    personId: 'u-worker-fixture-01',
    periodKey: '2026-10',
    laborKind: 'part',
    hours: 160,
    sourceEntryIds: ['le-fixture-0001', 'le-fixture-0002'],
    ...overrides,
  };
}

/** 可编程事实源夹具：seed 即生效；按周期键 + 可选人员过滤读取（适配器行为镜像）。 */
export class FakePayrollLaborSource {
  readonly facts: FixtureVerifiedLaborFact[] = [];
  /** 读取调用记录（断言适配请求形状用）。 */
  readonly requests: FixturePayrollLaborRequest[] = [];

  seed(fact: FixtureVerifiedLaborFact): void {
    this.facts.push(fact);
  }

  async readVerifiedLabor(
    request: FixturePayrollLaborRequest,
  ): Promise<readonly FixtureVerifiedLaborFact[]> {
    this.requests.push(request);
    return this.facts.filter(
      (fact) =>
        fact.periodKey === request.periodKey &&
        (request.personIds === undefined ||
          request.personIds.some((personId) => personId === fact.personId)),
    );
  }
}

// ---- 命令信封提交体构造（对账基线；信封字段由目标适配器补） ----

let fixtureOperationCounter = 0;

/** 规则发布提交体（首发 initial；修订 expectedRevision 由场景叠加）。 */
export function rulePublishSubmission(
  overrides: Partial<FixtureRulePublishSubmission> = {},
): FixtureRulePublishSubmission {
  fixtureOperationCounter += 1;
  return {
    ruleId: `fixture-rule-${String(fixtureOperationCounter).padStart(3, '0')}`,
    rateMinor: 2000,
    ...overrides,
  };
}

/** 月度核算提交体缺省（2026-10 全员）。 */
export function runMonthSubmission(overrides: Partial<FixturePeriodSubmission> = {}): FixturePeriodSubmission {
  return { periodKey: '2026-10', ...overrides };
}
