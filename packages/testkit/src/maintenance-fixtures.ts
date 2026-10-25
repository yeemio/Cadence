/**
 * maintenance 模块联动夹具（M3）。
 *
 * 故障联动经 baseline Outbox 事件（FaultReported/FaultResolved，组合根粘合——
 * 差异表 #4 裁定）的**消费面测试替身**：FakeFaultReportedFeed 以结构同形镜像
 * 携带 baseline 事件载荷（字段名逐一同形，不 import @smes/application），
 * drain() 产出 maintenance.task.create.v1 提交体（kind=repair + faultRef）——
 * 供组合根粘合层与对账测试使用。
 *
 * 类型取舍同 payroll-fixtures / drawing-fixtures：本地结构化镜像类型（testkit
 * rootDir 不含 maintenance 源），结构化兼容。周期枚举（daily / interval-days）
 * 与任务来源三词（plan-due / fault / manual）按 m3 冻结合同 v1.0。
 */

// ---- 本地结构化类型（镜像 packages/maintenance/src/ports.ts 合同） ----

/** baseline FaultReported 事件载荷镜像（结构同形；eventType=smes.baseline.v1.fault-reported）。 */
export interface FixtureFaultReportedFact {
  readonly faultReportId: string;
  readonly equipmentCode: string;
  readonly description: string;
  readonly reportedBy: string;
  readonly assignee: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly todoId: string | null;
}

/** baseline FaultResolved 事件载荷镜像（结构同形）。 */
export interface FixtureFaultResolvedFact {
  readonly faultReportId: string;
  readonly equipmentCode: string;
  readonly assignee: string | null;
  readonly remark: string | null;
  readonly state: string;
  readonly objectVersion: number;
}

/** 维保周期镜像（daily / interval-days——判据与动作清单是数据）。 */
export type FixtureMaintenanceCycle =
  | { readonly kind: 'daily' }
  | { readonly kind: 'interval'; readonly days: number };

// ---- 命令提交体基线（录制/回放对账用） ----

/** maintenance.plan.publish 提交体（版本化计划：设备×周期×判据+动作清单）。 */
export interface FixturePlanPublishSubmission {
  readonly planId: string;
  readonly resourceRef: string;
  readonly cycle: FixtureMaintenanceCycle;
  readonly checkpoints: readonly { readonly checkpointId: string; readonly label: string; readonly expectation?: string }[];
  readonly upkeepActions: readonly string[];
}

/** maintenance.task.create 提交体（手工/故障联动建任务；faultRef 携带即 fault 联动）。 */
export interface FixtureTaskCreateSubmission {
  readonly resourceRef: string;
  readonly kind: 'repair' | 'upkeep' | 'checkpoint';
  readonly faultRef?: string;
  readonly planId?: string;
  readonly assignee?: string;
}

/** maintenance.record.append 提交体（三态记录追加，kind 判别）。 */
export type FixtureRecordAppendSubmission =
  | { readonly kind: 'checkpoint'; readonly resourceRef: string; readonly planId?: string; readonly checkpointId: string; readonly result: 'pass' | 'fail' }
  | { readonly kind: 'upkeep'; readonly resourceRef: string; readonly planId?: string; readonly actionsDone?: readonly string[] }
  | { readonly kind: 'repair'; readonly resourceRef: string; readonly faultRef?: string; readonly restored: boolean };

// ---- 故障联动假订阅面（组合根粘合的测试替身） ----

/**
 * FaultReported 订阅假实现：seed 即入队；drain() 取出全部待处理故障并转换为
 * maintenance.task.create 提交体（equipmentCode → resourceRef 解析发生在组合根
 * 粘合层——夹具以 identity 映射模拟）。resolved() 登记 FaultResolved 事实供
 * 悬挂态对账口径（合同 §10 开放问题）使用。
 */
export class FakeFaultReportedFeed {
  readonly pending: FixtureFaultReportedFact[] = [];
  readonly resolvedFacts: FixtureFaultResolvedFact[] = [];

  seed(fact: FixtureFaultReportedFact): void {
    this.pending.push(fact);
  }

  resolve(fact: FixtureFaultResolvedFact): void {
    this.resolvedFacts.push(fact);
  }

  /** 待处理故障 → 维修任务提交体（组合根粘合行为的夹具化身）。 */
  drain(): readonly FixtureTaskCreateSubmission[] {
    const submissions = this.pending.map((fact) => ({
      resourceRef: fact.equipmentCode,
      kind: 'repair' as const,
      faultRef: fact.faultReportId,
      ...(fact.assignee === '' ? {} : { assignee: fact.assignee }),
    }));
    this.pending.length = 0;
    return submissions;
  }
}

// ---- 命令信封提交体构造（对账基线；信封字段由目标适配器补） ----

let fixtureCounter = 0;

/** 故障上报事实缺省（覆盖差异字段即可）。 */
export function fixtureFaultReportedFact(
  overrides: Partial<FixtureFaultReportedFact> = {},
): FixtureFaultReportedFact {
  fixtureCounter += 1;
  return {
    faultReportId: `fault-fixture-${String(fixtureCounter).padStart(3, '0')}`,
    equipmentCode: 'res-lathe-01',
    description: '主轴异响，待维修',
    reportedBy: 'u-operator-fixture-01',
    assignee: 'u-repair-fixture-01',
    state: 'assigned',
    objectVersion: 2,
    todoId: null,
    ...overrides,
  };
}

/** 计划发布提交体缺省（首发 initial；修订 expectedRevision 由场景叠加）。 */
export function planPublishSubmission(
  overrides: Partial<FixturePlanPublishSubmission> = {},
): FixturePlanPublishSubmission {
  fixtureCounter += 1;
  return {
    planId: `fixture-plan-${String(fixtureCounter).padStart(3, '0')}`,
    resourceRef: 'res-lathe-01',
    cycle: { kind: 'daily' },
    checkpoints: [{ checkpointId: 'oil-level', label: '油位', expectation: '视窗 1/2~2/3' }],
    upkeepActions: ['导轨润滑'],
    ...overrides,
  };
}

/** 手工维修任务提交体缺省。 */
export function taskCreateSubmission(
  overrides: Partial<FixtureTaskCreateSubmission> = {},
): FixtureTaskCreateSubmission {
  return {
    resourceRef: 'res-lathe-01',
    kind: 'repair',
    ...overrides,
  };
}

/** 点检 pass 记录提交体缺省（fail 场景覆盖 result）。 */
export function recordAppendSubmission(
  overrides: Partial<Extract<FixtureRecordAppendSubmission, { kind: 'checkpoint' }>> = {},
): FixtureRecordAppendSubmission {
  return {
    kind: 'checkpoint',
    resourceRef: 'res-lathe-01',
    checkpointId: 'oil-level',
    result: 'pass',
    ...overrides,
  };
}
