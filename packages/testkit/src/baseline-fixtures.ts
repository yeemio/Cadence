/**
 * baseline P1 + P2/P3 件对账夹具（M2-W2 / M2-W7；testkit 不受依赖铁律限制）。
 *
 * 用途：对账阶段黑盒比对（m2-drafts README 纪律 8——同输入同输出比对活系统）与
 * 跨包集成测试。构造器族：
 *  - 命令提交体（HTTP body 形状，POST /baseline/{resource}/commands 的载荷基线；
 *    P2/P3 件含 routing/standardtime/fault 五个动词——fault.resolve 走
 *    /baseline/fault-reports/:id/resolution 端点）；
 *  - 物品库种子（物料校验判定比对基准）；
 *  - 判定期望（matched/suspected/unmatched 三分的期望行形状）。
 *
 * 夹具是**输入侧**构造器：期望值口径在对账阶段以活系统行为反推校准
 * （阈值 DEFAULT_MATERIAL_VALIDATION_THRESHOLDS 是本仓初版口径）。
 */
import {
  DEFAULT_MATERIAL_VALIDATION_THRESHOLDS,
  type MaterialJudgment,
  type MaterialLineJudgment,
  type MaterialValidationThresholds,
} from '@smes/application';

// ---- 命令提交体（HTTP body 形状） ----

export interface BaselineCommandSubmission {
  readonly operationId: string;
  readonly expectedRevision: 'initial' | number;
  readonly issuedAt?: string;
  readonly command: {
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  };
}

let counter = 0;

/** 生成对账用唯一 operationId（同前缀可追溯、可复现）。 */
export function nextBaselineOperationId(label = 'recon'): string {
  counter += 1;
  return `op-baseline-${label}-${counter}`;
}

/** process.define 提交体基线。 */
export function processDefineSubmission(payload: { code: string; name: string; category?: string | null; description?: string | null; status?: 'draft' | 'active' }, operationId = nextBaselineOperationId('process-define')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.process.define.v1', payload },
  };
}

/** process.revise 提交体基线（expectedRevision = 目标当前 objectVersion）。 */
export function processReviseSubmission(expectedRevision: number, payload: { code: string; name?: string; category?: string | null; description?: string | null }, operationId = nextBaselineOperationId('process-revise')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision,
    command: { kind: 'baseline.process.revise.v1', payload },
  };
}

/** equipment.register / revise 提交体基线。 */
export function equipmentRegisterSubmission(payload: { code: string; name: string; type?: string | null; location?: string | null }, operationId = nextBaselineOperationId('equipment')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.equipment.register.v1', payload },
  };
}

/** outsourcing.rule.set 提交体基线（unitPrice 十进制串 + marginPermyriad 万分比）。 */
export function outsourcingRuleSetSubmission(payload: { code: string; processCode: string; unitPrice: string; marginPermyriad: number; name?: string | null }, operationId = nextBaselineOperationId('rule-set')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.outsourcing.rule.set.v1', payload },
  };
}

/** material.validate 提交体基线（清单行：code/name/spec 至少一项）。 */
export function materialValidateSubmission(lines: readonly { code?: string | null; name?: string | null; spec?: string | null }[], operationId = nextBaselineOperationId('material')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.material.validate.v1', payload: { lines } },
  };
}

// ---- P2/P3 件提交体（M2-W7：工艺路线 / 额定工时 / 故障上报） ----

/** routing.define 提交体基线（drawingNo = 业务键 = 图号；steps 数组位置即工序顺序）。 */
export function routingDefineSubmission(payload: {
  drawingNo: string;
  steps: readonly { processCode: string; remark?: string | null }[];
  name?: string | null;
}, operationId = nextBaselineOperationId('routing-define')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.routing.define.v1', payload: payload as Record<string, unknown> },
  };
}

/** routing.revise 提交体基线（expectedRevision = 该图号当前 objectVersion）。 */
export function routingReviseSubmission(expectedRevision: number, payload: {
  drawingNo: string;
  steps?: readonly { processCode: string; remark?: string | null }[];
  name?: string | null;
}, operationId = nextBaselineOperationId('routing-revise')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision,
    command: { kind: 'baseline.routing.revise.v1', payload: payload as Record<string, unknown> },
  };
}

/** standardtime.define 提交体基线（工时量纲 = 秒整数：standardSeconds 每件 / preparationSeconds 每批缺省 0）。 */
export function standardTimeDefineSubmission(payload: {
  code: string;
  scope: 'process' | 'product';
  targetCode: string;
  standardSeconds: number;
  preparationSeconds?: number;
}, operationId = nextBaselineOperationId('standardtime')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.standardtime.define.v1', payload: payload as Record<string, unknown> },
  };
}

/** fault.report 提交体基线（上报即派修：assignee 进入 assigned 即 IM + 待办）。 */
export function faultReportSubmission(payload: {
  equipmentCode: string;
  description: string;
  assignee: string;
}, operationId = nextBaselineOperationId('fault-report')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision: 'initial',
    command: { kind: 'baseline.fault.report.v1', payload: payload as Record<string, unknown> },
  };
}

/** fault.resolve 提交体基线（expectedRevision = 故障单当前 objectVersion；POST /baseline/fault-reports/:id/resolution）。 */
export function faultResolveSubmission(expectedRevision: number, payload: { remark?: string | null } = {}, operationId = nextBaselineOperationId('fault-resolve')): BaselineCommandSubmission {
  return {
    operationId,
    expectedRevision,
    command: { kind: 'baseline.fault.resolve.v1', payload: payload as Record<string, unknown> },
  };
}

// ---- 物品库种子（物料校验比对基准；InMemoryItemStore.create 入参形状） ----

export interface ItemSeed {
  readonly tenant: string;
  readonly code: string;
  readonly name: string;
  readonly spec?: string | null;
  readonly unit?: string | null;
  readonly category?: string | null;
}

/** 对账基线物品库（覆盖三类判定路径：精确命中/同名多规格/无规格）。 */
export function baselineItemLibrarySeeds(tenant: string): readonly ItemSeed[] {
  return [
    { tenant, code: 'P-1001', name: '轴承', spec: '6204-2RS', unit: '个', category: 'part' },
    { tenant, code: 'P-1002', name: '轴承', spec: '6204-ZZ', unit: '个', category: 'part' },
    { tenant, code: 'P-1003', name: '垫片', spec: null, unit: '个', category: 'part' },
  ];
}

// ---- 判定期望（对账断言形状） ----

/** 期望行：judgment + 证据面（候选码与相似度在对账时按活系统口径校准）。 */
export interface ExpectedJudgment {
  readonly judgment: MaterialJudgment;
  readonly candidateItemCode?: string | null;
}

/** 逐行期望 → 完整期望断言集（lineNo 按 1 起顺序回填）。 */
export function expectedJudgments(expected: readonly ExpectedJudgment[]): readonly MaterialLineJudgment[] {
  return expected.map((row, index) => ({
    lineNo: index + 1,
    code: null,
    name: null,
    spec: null,
    judgment: row.judgment,
    candidateItemId: null,
    candidateItemCode: row.candidateItemCode ?? null,
    similarity: 0,
    basis: 'none',
  }));
}

/** 本仓初版判定阈值（对账校准的对照基准）。 */
export const BASELINE_RECON_THRESHOLDS: MaterialValidationThresholds = DEFAULT_MATERIAL_VALIDATION_THRESHOLDS;
