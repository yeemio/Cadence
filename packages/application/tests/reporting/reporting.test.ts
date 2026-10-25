/**
 * reporting 模块测试（M2-W7）：三态状态机配置合法集（+撤销终态旁支）、五类
 * 申报（派工单校验 fail-closed / 工艺属性随单快照 / 幂等 / 乐观锁）、批量申报
 * （整批校验先于落账 + 上限配置化）、核查链全程（audit-edit 修正版 supersedes
 * 链不改原单 → verify → revoke → 撤销后重报净额）、末道报工触发质检
 * （InspectionIntakePort 通知式）、ReportVerified/ReportRevoked 事件形状
 * （hours 消费端口合同）、查询视图（列表筛选链尾口径 / 我的报工双键 / 待核查
 * 队列 / 图号×工序进度 / 产出趋势 12 日均峰值）、留痕账、账本↔投影对账、
 * 模块装配与权限码。全部零框架直连（内存实现 + engine-flow 内存账本 +
 * 可注入假端口——联动验证用夹具，真实端口由兄弟模块合流提供）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  DEFAULT_REPORT_BATCH_LIMIT,
  DEFAULT_REPORT_FLOW_CONFIG,
  DEFAULT_REPORTABLE_DISPATCH_STATES,
  REPORT_KINDS,
  REPORT_STATE_IDS,
  reportKindLabel,
  reportStateLabel,
} from '../../src/reporting/reporting-config.js';
import {
  REPORT_EVENT_TYPES,
  WORK_REPORT_AGGREGATE_TYPE,
} from '../../src/reporting/reporting-events.js';
import { ReportInputError } from '../../src/reporting/reporting-errors.js';
import {
  parseReportAuditEditPayload,
  parseReportSubmitBatchPayload,
  parseReportSubmitPayload,
  type ReportCommand,
} from '../../src/reporting/reporting-input.js';
import type {
  DispatchFactForReport,
  FinalOperationJudgePort,
  OperationValidityPort,
  ValidDispatchSource,
} from '../../src/reporting/reporting-ports.js';
import type { InspectionIntakeReceipt, InspectionSourceFact } from '../../src/inspection/inspection-ports.js';
import {
  InMemoryReportAuditStore,
  InMemoryReportDomainEventStore,
  InMemoryReportOperationStore,
  InMemoryWorkReportStore,
} from '../../src/reporting/in-memory-reporting-stores.js';
import { ReportingModule } from '../../src/reporting/reporting.module.js';
import {
  ReportsController,
  ReportingQueriesController,
} from '../../src/reporting/reporting.controllers.js';
import { ReportingService } from '../../src/reporting/reporting.service.js';
import type { ReportCommitted, ReportCommandResult } from '../../src/reporting/reporting.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const worker = UserId.create('u-worker-01');
const auditor = UserId.create('u-auditor-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（联动验证夹具；testkit 另有完整版供跨模块使用） ----

class FakeValidDispatchSource implements ValidDispatchSource {
  readonly facts = new Map<string, DispatchFactForReport>();
  readonly calls: string[] = [];

  seed(overrides: Partial<DispatchFactForReport> & { dispatchId: string }): DispatchFactForReport {
    const fact: DispatchFactForReport = {
      kind: 'part',
      state: 'executing',
      workOrderId: 'wo-1',
      drawingNo: 'DWG-A01',
      operationCode: 'OP-20',
      quantity: 100,
      assignee: 'u-worker-01',
      ...overrides,
    };
    this.facts.set(fact.dispatchId, fact);
    return fact;
  }

  async findDispatch(_tenant: TenantId, dispatchId: string): Promise<DispatchFactForReport | null> {
    this.calls.push(dispatchId);
    return this.facts.get(dispatchId) ?? null;
  }
}

class FakeOperationValidity implements OperationValidityPort {
  readonly known = new Set<string>();
  readonly calls: string[] = [];

  seed(processCode: string): void {
    this.known.add(processCode);
  }

  async isKnownOperation(_tenant: TenantId, operationCode: string): Promise<boolean> {
    this.calls.push(operationCode);
    return this.known.has(operationCode);
  }
}

class FakeFinalOperationJudge implements FinalOperationJudgePort {
  readonly finalPairs = new Set<string>(); // `${drawingNo}|${operationCode}`
  readonly calls: string[] = [];

  seedFinal(drawingNo: string, operationCode: string): void {
    this.finalPairs.add(`${drawingNo}|${operationCode}`);
  }

  async isFinalOperation(_tenant: TenantId, drawingNo: string, operationCode: string): Promise<boolean> {
    this.calls.push(`${drawingNo}|${operationCode}`);
    return this.finalPairs.has(`${drawingNo}|${operationCode}`);
  }
}

class FakeInspectionIntake {
  readonly facts: InspectionSourceFact[] = [];
  nextReceipt: InspectionIntakeReceipt = { inspectionId: 'ins-fixture-1', created: true };

  async receiveSourceFact(_tenant: TenantId, fact: InspectionSourceFact): Promise<InspectionIntakeReceipt> {
    this.facts.push(fact);
    return this.nextReceipt;
  }
}

function newHarness(options: { batchLimit?: number } = {}) {
  const reports = new InMemoryWorkReportStore();
  const audits = new InMemoryReportAuditStore();
  const operations = new InMemoryReportOperationStore();
  const domainEvents = new InMemoryReportDomainEventStore();
  const machineEvents = createInMemoryApprovalEventStore();
  const validDispatch = new FakeValidDispatchSource();
  const operationValidity = new FakeOperationValidity();
  const finalOperation = new FakeFinalOperationJudge();
  const inspectionIntake = new FakeInspectionIntake();
  const service = new ReportingService(
    reports,
    audits,
    operations,
    domainEvents,
    machineEvents,
    { validDispatch, operationValidity, finalOperation, inspectionIntake },
    {
      now: () => FIXED_NOW,
      ...(options.batchLimit === undefined ? {} : { batchLimit: options.batchLimit }),
    },
  );
  return {
    service,
    reports,
    audits,
    operations,
    domainEvents,
    machineEvents,
    validDispatch,
    operationValidity,
    finalOperation,
    inspectionIntake,
  };
}

let opSeq = 0;
function envelopeOf(
  kind: ReportCommand['kind'],
  payload: unknown,
  expectedRevision: 'initial' | number = 'initial',
  actor: UserId = worker,
): CommandEnvelope<ReportCommand> {
  opSeq += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: actor,
    operationId: OperationId.create(`op-reporting-${opSeq}`),
    expectedRevision,
    issuedAt: FIXED_NOW,
    command: { kind, payload },
  });
}

async function committed(result: ReportCommandResult): Promise<ReportCommitted> {
  expect(result.status).toBe('committed');
  return result as ReportCommitted;
}

/** 标准件：一张可报的零件派工单（executing / DWG-A01 × OP-20 / 工序库已知）。 */
function seedStandardDispatch(harness: ReturnType<typeof newHarness>): DispatchFactForReport {
  harness.validDispatch.seed({ dispatchId: 'dsp-1' });
  harness.operationValidity.seed('OP-20');
  return harness.validDispatch.facts.get('dsp-1')!;
}

// ---- 状态机配置 ----

describe('状态机配置（ADR-0010：状态集是配置）', () => {
  it('四态 + 4 条迁移合法集：pending→reported→verified 主干 + reported/verified→revoked 终态旁支', () => {
    expect(REPORT_STATE_IDS).toEqual(['pending', 'reported', 'verified', 'revoked']);
    expect(DEFAULT_REPORT_FLOW_CONFIG.initial).toBe('pending');
    expect(DEFAULT_REPORT_FLOW_CONFIG.transitions).toHaveLength(4);
    const rules = DEFAULT_REPORT_FLOW_CONFIG.transitions.map((t) => `${t.from}--${t.event}->${t.to}`);
    expect(rules).toContain('pending--SUBMIT->reported');
    expect(rules).toContain('reported--VERIFY->verified');
    expect(rules).toContain('reported--REVOKE->revoked');
    expect(rules).toContain('verified--REVOKE->revoked');
    expect(DEFAULT_REPORT_FLOW_CONFIG.states.filter((state) => state.final).map((state) => state.id)).toEqual([
      'revoked',
    ]);
  });

  it('五类 kind 与中文标签；可报派工状态默认 assigned/executing', () => {
    expect(REPORT_KINDS).toEqual(['part', 'assembly', 'electrical', 'aftermarket', 'oddjob']);
    expect(reportKindLabel('part')).toBe('零件报工');
    expect(reportStateLabel('verified')).toBe('已核查');
    expect(DEFAULT_REPORTABLE_DISPATCH_STATES).toEqual(['assigned', 'executing']);
    expect(DEFAULT_REPORT_BATCH_LIMIT).toBe(50);
  });
});

// ---- 申报（submit） ----

describe('report.submit：五类申报', () => {
  it('成功：建单先落 pending@v1 投影再 SUBMIT → reported@v2；工艺属性随单快照；ReportSubmitted 事件', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480 }),
      ),
    );
    expect(result.newRevision).toBe(2);
    const report = result.report!;
    expect(report.state).toBe('reported');
    expect(report.objectVersion).toBe(2);
    expect(report.kind).toBe('part');
    expect(report.dispatchId).toBe('dsp-1');
    expect(report.doneQty).toBe(10);
    expect(report.laborMinutes).toBe(480);
    expect(report.reporter).toBe(worker);
    // 工艺属性随单快照（不回查 dispatch——合同 §2）
    expect(report.workOrderId).toBe('wo-1');
    expect(report.drawingNo).toBe('DWG-A01');
    expect(report.operationCode).toBe('OP-20');
    expect(report.supersedes).toBeNull();
    expect(report.businessTime).toBe(FIXED_NOW); // 缺省 = 申报时刻
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe(REPORT_EVENT_TYPES.reportSubmitted);
    expect(result.events[0]!.aggregate).toMatchObject({ type: WORK_REPORT_AGGREGATE_TYPE, revision: 2 });
    // 机器账本有且仅有一条 SUBMIT 迁移（初始投影无机器事件）
    const page = await harness.machineEvents.readByAggregate({ id: report.id, type: WORK_REPORT_AGGREGATE_TYPE });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.payload.event).toBe('SUBMIT');
  });

  it('业务时间补录（事后报工计入业务当天）', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', {
          dispatchId: 'dsp-1',
          doneQty: 5,
          laborMinutes: 60,
          businessTime: '2026-10-20T08:00:00.000Z',
        }),
      ),
    );
    expect(result.report!.businessTime).toBe('2026-10-20T08:00:00.000Z');
  });

  it('派工单校验 fail-closed：单不存在 / 状态不可报 / 外协单 / 工序不合法 → rejected 且零落账', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    harness.validDispatch.seed({ dispatchId: 'dsp-draft', state: 'draft' });
    harness.validDispatch.seed({ dispatchId: 'dsp-done', state: 'done' });
    harness.validDispatch.seed({ dispatchId: 'dsp-cancelled', state: 'cancelled' });
    harness.validDispatch.seed({ dispatchId: 'dsp-out', kind: 'outsourcing' });

    const cases: readonly [string, string][] = [
      ['dsp-none', "不存在或派工读端口未接线"],
      ['dsp-draft', "状态 'draft' 不可报工"],
      ['dsp-done', "状态 'done' 不可报工"],
      ['dsp-cancelled', "状态 'cancelled' 不可报工"],
      ['dsp-out', "不在五类报工面"],
    ];
    for (const [dispatchId, fragment] of cases) {
      const result = await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId, doneQty: 1, laborMinutes: 30 }),
      );
      expect(result.status).toBe('rejected');
      expect((result as { reason: string }).reason).toContain(fragment);
    }
    expect(await harness.reports.list(t1)).toHaveLength(0);

    // 工序合法性复检拒绝：工序库接线且无此工序（dsp-1 的 OP-20 已 seed 为已知——用另一张未 seed 的）
    harness.validDispatch.seed({ dispatchId: 'dsp-unknown-op', operationCode: 'OP-XX' });
    const result = await harness.service.execute(
      envelopeOf('report.submit.v1', { dispatchId: 'dsp-unknown-op', doneQty: 1, laborMinutes: 30 }),
    );
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('不在 baseline 工序库中');
  });

  it('assigned 状态可报（初版口径：assigned/executing）', async () => {
    const harness = newHarness();
    harness.validDispatch.seed({ dispatchId: 'dsp-assigned', state: 'assigned' });
    harness.operationValidity.seed('OP-20');
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-assigned', doneQty: 2, laborMinutes: 45 }),
      ),
    );
    expect(result.report!.state).toBe('reported');
  });

  it('幂等：同 operationId 重放 rejected；expectedRevision 数字被拒（创建命令）', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    const env = envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 3, laborMinutes: 60 });
    const first = await committed(await harness.service.execute(env));
    expect(first.report!.state).toBe('reported');
    const replay = await harness.service.execute(env);
    expect(replay.status).toBe('rejected');
    expect((replay as { reason: string }).reason).toContain('幂等冲突');

    const numeric = await harness.service.execute(
      envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 3, laborMinutes: 60 }, 2),
    );
    expect(numeric.status).toBe('rejected');
    expect((numeric as { reason: string }).reason).toContain("须为 'initial'");
  });

  it('载荷校验：非法数量/工时分钟/派工单 id 抛 ReportInputError（400 域）', () => {
    expect(() => parseReportSubmitPayload({ dispatchId: 'dsp-1', doneQty: 0, laborMinutes: 60 })).toThrow(
      ReportInputError,
    );
    expect(() => parseReportSubmitPayload({ dispatchId: 'dsp-1', doneQty: 1, laborMinutes: 1.5 })).toThrow(
      ReportInputError,
    );
    expect(() => parseReportSubmitPayload({ dispatchId: ' ', doneQty: 1, laborMinutes: 60 })).toThrow(
      ReportInputError,
    );
    expect(parseReportSubmitPayload({ dispatchId: 'dsp-1', doneQty: 1, laborMinutes: 90 })).toMatchObject({
      dispatchId: 'dsp-1',
      doneQty: 1,
      laborMinutes: 90,
    });
  });
});

// ---- 批量申报（submit-batch） ----

describe('report.submit-batch：批量申报', () => {
  it('多单一次命令：每单独立聚合 reported@2 + 一条 BatchSubmitted（批次锚聚合）', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    harness.validDispatch.seed({ dispatchId: 'dsp-2', operationCode: 'OP-30', drawingNo: 'DWG-A01' });
    harness.operationValidity.seed('OP-30');
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit-batch.v1', {
          lines: [
            { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480 },
            { dispatchId: 'dsp-2', doneQty: 5, laborMinutes: 240 },
          ],
        }),
      ),
    );
    expect(result.reports).toHaveLength(2);
    for (const report of result.reports!) {
      expect(report.state).toBe('reported');
      expect(report.objectVersion).toBe(2);
    }
    const batchEvents = result.events!.filter((event) => event.eventType === REPORT_EVENT_TYPES.batchSubmitted);
    expect(batchEvents).toHaveLength(1);
    expect(batchEvents[0]!.aggregate!.type).toBe('report-batch');
    const payload = batchEvents[0]!.payload as { count: number };
    expect(payload.count).toBe(2);
    expect(result.events!.filter((event) => event.eventType === REPORT_EVENT_TYPES.reportSubmitted)).toHaveLength(
      2,
    );
  });

  it('整批校验先于落账：第二行非法 → 整批 rejected 零落账（不部分落账）', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness); // dsp-1 合法；dsp-2 不 seed（不存在）
    const result = await harness.service.execute(
      envelopeOf('report.submit-batch.v1', {
        lines: [
          { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480 },
          { dispatchId: 'dsp-2', doneQty: 5, laborMinutes: 240 },
        ],
      }),
    );
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('第 2 行');
    expect(await harness.reports.list(t1)).toHaveLength(0);
    expect(await harness.domainEvents.pendingOutbox()).toHaveLength(0);
  });

  it('批量上限配置化：超上限整批拒绝', async () => {
    const harness = newHarness({ batchLimit: 2 });
    seedStandardDispatch(harness);
    const result = await harness.service.execute(
      envelopeOf('report.submit-batch.v1', {
        lines: [
          { dispatchId: 'dsp-1', doneQty: 1, laborMinutes: 30 },
          { dispatchId: 'dsp-1', doneQty: 2, laborMinutes: 30 },
          { dispatchId: 'dsp-1', doneQty: 3, laborMinutes: 30 },
        ],
      }),
    );
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('超上限');
    expect(() => parseReportSubmitBatchPayload({ lines: [] })).toThrow(ReportInputError);
  });
});

// ---- 末道报工触发质检 ----

describe('末道报工 → 质检触发（InspectionIntakePort，通知式）', () => {
  it('kind=part 且工艺路线末道：投递来源事实（sourceType=report，sourceRefId=报工单），回执进事件载荷', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    harness.finalOperation.seedFinal('DWG-A01', 'OP-20');
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480 }),
      ),
    );
    expect(harness.inspectionIntake.facts).toHaveLength(1);
    const fact = harness.inspectionIntake.facts[0]!;
    expect(fact.sourceType).toBe('report');
    expect(fact.sourceRefId).toBe(result.report!.id);
    expect(fact.drawingNo).toBe('DWG-A01');
    expect(fact.quantity).toBe(10);
    expect(fact.workOrderId).toBe('wo-1');
    expect(fact.triggeredBy).toBe(worker);
    const payload = result.events[0]!.payload as { inspectionIntake: { created: boolean; inspectionId: string | null } };
    expect(payload.inspectionIntake).toEqual({ inspectionId: 'ins-fixture-1', created: true, reason: null });
  });

  it('非末道 / kind 不在末道触发集：不投递（载荷 created:false）', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness); // OP-20 未 seed 为末道
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 1, laborMinutes: 30 }),
      ),
    );
    expect(harness.inspectionIntake.facts).toHaveLength(0);
    const payload = result.events[0]!.payload as { inspectionIntake: { created: boolean } };
    expect(payload.inspectionIntake.created).toBe(false);

    // 装配单（kind 不在默认末道集 part）：即使末道判定真也不触发
    harness.validDispatch.seed({ dispatchId: 'dsp-asm', kind: 'assembly', drawingNo: 'DWG-A01', operationCode: 'OP-20' });
    await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-asm', doneQty: 1, laborMinutes: 30 }),
      ),
    );
    expect(harness.inspectionIntake.facts).toHaveLength(0);
  });
});

// ---- 核查链：audit-edit → verify → revoke → 重报 ----

describe('核查链全程（audit-edit 修正版 / verify / revoke / 重报）', () => {
  async function seedReported(harness: ReturnType<typeof newHarness>): Promise<string> {
    seedStandardDispatch(harness);
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480, remark: '首报' }),
      ),
    );
    return result.report!.id;
  }

  it('audit-edit：生成修正版（supersedes 链不改原单）+ 字段镜像 + 留痕 + ReportCorrected', async () => {
    const harness = newHarness();
    const originalId = await seedReported(harness);
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.audit-edit.v1', { doneQty: 8, reason: '数量录错修正' }, 2, auditor),
        originalId,
      ),
    );
    const corrected = result.report!;
    expect(corrected.supersedes).toBe(originalId);
    expect(corrected.doneQty).toBe(8);
    expect(corrected.laborMinutes).toBe(480); // 未编辑字段继承
    expect(corrected.remark).toBe('首报');
    expect(corrected.state).toBe('reported'); // 修正版仍待核查
    expect(corrected.objectVersion).toBe(2);
    expect(result.correctedFrom).toBe(originalId);

    // 原单行不动（append-only）：state 仍 reported、数量仍 10
    const original = await harness.reports.find(t1, originalId);
    expect(original!.state).toBe('reported');
    expect(original!.doneQty).toBe(10);

    // 留痕：编辑动作一行（谁、何时、改了什么）
    expect(result.audits).toHaveLength(1);
    expect(result.audits![0]!.action).toBe('edit');
    expect(result.audits![0]!.actor).toBe(auditor);
    expect(result.audits![0]!.reason).toBe('数量录错修正');
    expect(result.audits![0]!.changes).toEqual([{ field: 'doneQty', from: 10, to: 8 }]);
    expect(result.audits![0]!.reportId).toBe(originalId);

    // 事件：ReportCorrected 挂修正版聚合，载荷含原单 id + 镜像
    expect(result.events[0]!.eventType).toBe(REPORT_EVENT_TYPES.reportCorrected);
    expect(result.events[0]!.aggregate!.id).toBe(corrected.id);
    const payload = result.events[0]!.payload as { originalReportId: string; changes: unknown[] };
    expect(payload.originalReportId).toBe(originalId);
    expect(payload.changes).toEqual([{ field: 'doneQty', from: 10, to: 8 }]);
  });

  it('链尾口径：列表不返回被修正行；对原单 verify 被拒（对链尾核查）', async () => {
    const harness = newHarness();
    const originalId = await seedReported(harness);
    await committed(
      await harness.service.execute(envelopeOf('report.audit-edit.v1', { laborMinutes: 300, reason: '工时修正' }, 2, auditor), originalId),
    );
    const active = await harness.reports.list(t1);
    expect(active).toHaveLength(1);
    expect(active[0]!.supersedes).toBe(originalId);

    const onOriginal = await harness.service.execute(
      envelopeOf('report.verify.v1', {}, 2, auditor),
      originalId,
    );
    expect(onOriginal.status).toBe('rejected');
    expect((onOriginal as { reason: string }).reason).toContain('已被修正版取代');
  });

  it('verify：reported→verified@3，回填核查人/时刻，ReportVerified 载荷=hours 消费合同', async () => {
    const harness = newHarness();
    const reportId = await seedReported(harness);
    const result = await committed(
      await harness.service.execute(envelopeOf('report.verify.v1', {}, 2, auditor), reportId),
    );
    const verified = result.report!;
    expect(verified.state).toBe('verified');
    expect(verified.objectVersion).toBe(3);
    expect(verified.verifiedBy).toBe(auditor);
    expect(verified.verifiedAt).toBe(FIXED_NOW);
    expect(result.audits![0]!.action).toBe('verify');

    // ReportVerified 事件形状（hours 归集端口合同——合同 §4 被依赖面）
    expect(result.events[0]!.eventType).toBe(REPORT_EVENT_TYPES.reportVerified);
    const payload = result.events[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      reportId,
      dispatchId: 'dsp-1',
      kind: 'part',
      workOrderId: 'wo-1',
      drawingNo: 'DWG-A01',
      operationCode: 'OP-20',
      reporter: worker,
      doneQty: 10,
      laborMinutes: 480,
      businessTime: FIXED_NOW,
      supersedes: null,
      verifiedBy: auditor,
      verifiedAt: FIXED_NOW,
      objectVersion: 3,
    });
    // 已核查单不可再核查 / 不可编辑
    const again = await harness.service.execute(envelopeOf('report.verify.v1', {}, 3, auditor), reportId);
    expect(again.status).toBe('rejected');
    const edit = await harness.service.execute(envelopeOf('report.audit-edit.v1', { doneQty: 9, reason: 'x' }, 3, auditor), reportId);
    expect(edit.status).toBe('rejected');
    expect((edit as { reason: string }).reason).toContain('撤销重报');
  });

  it('revoke：reported→revoked 与 verified→revoked（需重报）；ReportRevoked 冲销信号', async () => {
    const harness = newHarness();
    const reportId = await seedReported(harness);
    const result = await committed(
      await harness.service.execute(
        envelopeOf('report.revoke.v1', { reason: '报错作废' }, 2, auditor),
        reportId,
      ),
    );
    expect(result.report!.state).toBe('revoked');
    expect(result.report!.objectVersion).toBe(3);
    expect(result.report!.revokedBy).toBe(auditor);
    expect(result.report!.revokeReason).toBe('报错作废');
    expect(result.audits![0]!.action).toBe('revoke');
    const revokePayload = result.events[0]!.payload as Record<string, unknown>;
    expect(result.events[0]!.eventType).toBe(REPORT_EVENT_TYPES.reportRevoked);
    expect(revokePayload['fromState']).toBe('reported');
    expect(revokePayload['laborMinutes']).toBe(480);

    // revoked 终态：不可再核查/编辑/撤销
    for (const kind of ['report.verify.v1', 'report.audit-edit.v1', 'report.revoke.v1'] as const) {
      const outcome = await harness.service.execute(
        envelopeOf(kind, kind === 'report.audit-edit.v1' ? { reason: 'x' } : {}, 3, auditor),
        reportId,
      );
      expect(outcome.status).toBe('rejected');
    }

    // 已核查撤销（verified→revoked）+ 撤销后重报净额口径
    const reReport = await committed(
      await harness.service.execute(envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480 })),
    );
    const reId = reReport.report!.id;
    await committed(await harness.service.execute(envelopeOf('report.verify.v1', {}, 2, auditor), reId));
    const unverified = await committed(
      await harness.service.execute(envelopeOf('report.revoke.v1', { reason: '核查后作废重报' }, 3, auditor), reId),
    );
    expect(unverified.report!.state).toBe('revoked');
    const payload = unverified.events[0]!.payload as Record<string, unknown>;
    expect(payload['fromState']).toBe('verified'); // hours 须冲销的来源态
  });

  it('乐观锁：expectedRevision 不符 rejected；幂等冲突 rejected', async () => {
    const harness = newHarness();
    const reportId = await seedReported(harness);
    const stale = await harness.service.execute(envelopeOf('report.verify.v1', {}, 99, auditor), reportId);
    expect(stale.status).toBe('rejected');
    expect((stale as { reason: string }).reason).toContain('乐观锁冲突');

    const verifyEnv = envelopeOf('report.verify.v1', {}, 2, auditor);
    await committed(await harness.service.execute(verifyEnv, reportId));
    // 同信封重放：乐观锁检查先于幂等记账（与 dispatch 同序）——objectVersion 已推进故被拒
    const replay = await harness.service.execute(verifyEnv, reportId);
    expect(replay.status).toBe('rejected');
    expect((replay as { reason: string }).reason).toContain('乐观锁冲突');
  });

  it('修正版载荷解析：reason 必填，未给字段 null（继承原单）', () => {
    expect(parseReportAuditEditPayload({ reason: 'why' })).toEqual({
      doneQty: null,
      laborMinutes: null,
      businessTime: null,
      remark: null,
      reason: 'why',
    });
    expect(() => parseReportAuditEditPayload({ doneQty: 1 })).toThrow(ReportInputError);
    expect(() => parseReportAuditEditPayload({ reason: 'x', laborMinutes: 0 })).toThrow(ReportInputError);
  });
});

// ---- 查询视图 ----

describe('查询视图（列表/我的报工/待核查队列/图号进度/产出趋势/详情）', () => {
  async function seedMixed(harness: ReturnType<typeof newHarness>): Promise<void> {
    seedStandardDispatch(harness);
    harness.validDispatch.seed({ dispatchId: 'dsp-op30', operationCode: 'OP-30', drawingNo: 'DWG-A01' });
    harness.operationValidity.seed('OP-30');
    harness.validDispatch.seed({ dispatchId: 'dsp-odd', kind: 'oddjob', drawingNo: null, operationCode: null });

    // 三张零件单（两张 OP-20、一张 OP-30）+ 一张零工单，跨两天业务时间
    const r1 = await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 10, laborMinutes: 480, businessTime: '2026-10-24T08:00:00.000Z' }),
      ),
    );
    await committed(await harness.service.execute(envelopeOf('report.verify.v1', {}, 2, auditor), r1.report!.id));
    await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 5, laborMinutes: 240, businessTime: '2026-10-25T08:00:00.000Z' }),
      ),
    );
    await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-op30', doneQty: 3, laborMinutes: 120, businessTime: '2026-10-25T09:00:00.000Z' }),
      ),
    );
    await committed(
      await harness.service.execute(
        envelopeOf('report.submit.v1', { dispatchId: 'dsp-odd', doneQty: 1, laborMinutes: 60, businessTime: '2026-10-25T07:00:00.000Z' }),
      ),
    );
  }

  it('列表过滤（kind/state/reporter）与租户隔离', async () => {
    const harness = newHarness();
    await seedMixed(harness);
    expect(await harness.service.listReports(t1)).toHaveLength(4);
    expect(await harness.service.listReports(t1, { kind: 'oddjob' })).toHaveLength(1);
    expect(await harness.service.listReports(t1, { state: 'verified' })).toHaveLength(1);
    expect(await harness.service.listReports(t1, { reporter: 'u-worker-01' })).toHaveLength(4);
    expect(await harness.service.listReports(t1, { dispatchId: 'dsp-1' })).toHaveLength(2);
    expect(await harness.service.listReports(t2)).toHaveLength(0);
  });

  it('我的报工：本人双键（(tenant, reporter)——"仅本人完成"边界）', async () => {
    const harness = newHarness();
    await seedMixed(harness);
    const mine = await harness.service.myReports(t1, worker);
    expect(mine).toHaveLength(4);
    expect(mine.every((row) => row.reporter === worker)).toBe(true);
    expect(await harness.service.myReports(t1, UserId.create('u-other'))).toHaveLength(0);
    expect(await harness.service.myReports(t2, worker)).toHaveLength(0);
  });

  it('待核查队列：reported 链尾 createdAt 升序（先进先核），verified/revoked 不进', async () => {
    const harness = newHarness();
    await seedMixed(harness);
    const queue = await harness.service.pendingVerificationQueue(t1);
    expect(queue).toHaveLength(3);
    expect(queue.every((row) => row.state === 'reported')).toBe(true);
    expect(new Date(queue[0]!.createdAt).getTime()).toBeLessThanOrEqual(new Date(queue[1]!.createdAt).getTime());
  });

  it('图号×工序进度：净额聚合（verified 单列；revoked 不计；修正行不计）', async () => {
    const harness = newHarness();
    await seedMixed(harness);
    // 撤销一张（OP-30 那张）再修正一张（OP-20 未核查那张 doneQty 5→4）
    const rows = await harness.service.listReports(t1, { state: 'reported' });
    const op30 = rows.find((row) => row.operationCode === 'OP-30')!;
    const op20Pending = rows.find((row) => row.operationCode === 'OP-20')!;
    await committed(
      await harness.service.execute(envelopeOf('report.revoke.v1', { reason: '作废' }, 2, auditor), op30.id),
    );
    await committed(
      await harness.service.execute(envelopeOf('report.audit-edit.v1', { doneQty: 4, reason: '修正' }, 2, auditor), op20Pending.id),
    );

    const progress = await harness.service.drawingOperationProgress(t1, 'DWG-A01');
    expect(progress).toHaveLength(1); // OP-30 revoked 不计——只剩 OP-20 一行
    const op20 = progress[0]!;
    expect(op20.operationCode).toBe('OP-20');
    expect(op20.netDoneQty).toBe(14); // verified 10 + 修正版链尾 4（原单 5 不计）
    expect(op20.verifiedQty).toBe(10);
    expect(op20.netLaborMinutes).toBe(720);
    expect(op20.verifiedLaborMinutes).toBe(480);
    expect(op20.reportCount).toBe(2);
  });

  it('产出趋势：日产出（business_time 日期口径）/12 日均/峰值；revoked 不计', async () => {
    const harness = newHarness();
    await seedMixed(harness);
    // 撤销零工单（revoked 不计净额）
    const odd = (await harness.service.listReports(t1, { kind: 'oddjob' }))[0]!;
    await committed(await harness.service.execute(envelopeOf('report.revoke.v1', {}, 2, auditor), odd.id));

    const trend = await harness.service.outputTrend(t1, 12);
    expect(trend.days).toBe(12);
    expect(trend.daily).toHaveLength(12);
    // FIXED_NOW=2026-10-25 → 窗口 2026-10-14..10-25
    expect(trend.from).toBe('2026-10-14');
    expect(trend.to).toBe('2026-10-25');
    const byDate = new Map(trend.daily.map((point) => [point.date, point]));
    expect(byDate.get('2026-10-24')).toEqual({ date: '2026-10-24', doneQty: 10, laborMinutes: 480 });
    expect(byDate.get('2026-10-25')).toEqual({ date: '2026-10-25', doneQty: 8, laborMinutes: 360 }); // 5+3，零工 1 已撤销
    // 净产出合计 18 / 12 日
    expect(trend.avgDoneQtyPerDay).toBe(1.5);
    expect(trend.avgLaborMinutesPerDay).toBe(70);
    expect(trend.peak).toEqual({ date: '2026-10-24', doneQty: 10, laborMinutes: 480 });
    // 全空租户：peak null
    const empty = await harness.service.outputTrend(t2, 5);
    expect(empty.peak).toBeNull();
    expect(empty.daily.every((point) => point.doneQty === 0)).toBe(true);
  });

  it('详情：修正链全貌（链头→链尾）+ 全链留痕 + 里程碑', async () => {
    const harness = newHarness();
    await seedMixed(harness);
    // dsp-1 名下未核查那张（唯一 reported 的 OP-20 单）
    const target = (await harness.service.listReports(t1, { state: 'reported', dispatchId: 'dsp-1' }))[0]!;
    expect(target.operationCode).toBe('OP-20');
    const editResult = await committed(
      await harness.service.execute(envelopeOf('report.audit-edit.v1', { doneQty: 4, reason: '修正' }, 2, auditor), target.id),
    );
    const corrected = editResult.report!;

    const detail = await harness.service.reportDetail(t1, corrected.id);
    expect(detail.report.id).toBe(corrected.id);
    expect(detail.chain).toHaveLength(2);
    expect(detail.chain[0]!.id).toBe(target.id); // 链头 = 原单
    expect(detail.chain[1]!.id).toBe(corrected.id);
    expect(detail.chain[1]!.supersedes).toBe(target.id);
    expect(detail.audits).toHaveLength(1); // edit 留痕挂原单
    expect(detail.audits[0]!.reportId).toBe(target.id);
    expect(detail.milestones.map((milestone) => milestone.event)).toEqual(['SUBMIT']);

    await expect(harness.service.reportDetail(t1, 'wr-none')).rejects.toThrow('不存在');
  });
});

// ---- 账本↔投影对账 ----

describe('账本↔投影对账', () => {
  it('重放一致：submit+verify 后机器账本重放得 verified@v3（服务隐式校验——verify 后再 revoke 成功即证）', async () => {
    const harness = newHarness();
    seedStandardDispatch(harness);
    const created = await committed(
      await harness.service.execute(envelopeOf('report.submit.v1', { dispatchId: 'dsp-1', doneQty: 1, laborMinutes: 30 })),
    );
    const reportId = created.report!.id;
    await committed(await harness.service.execute(envelopeOf('report.verify.v1', {}, 2, auditor), reportId));
    // verified→revoked 内部走 replayReport：账本与投影不一致会抛 StateError——成功即证一致
    const revoked = await committed(
      await harness.service.execute(envelopeOf('report.revoke.v1', {}, 3, auditor), reportId),
    );
    expect(revoked.report!.objectVersion).toBe(4);
    const page = await harness.machineEvents.readByAggregate({ id: reportId, type: WORK_REPORT_AGGREGATE_TYPE });
    expect(page.events.map((event) => event.payload.event)).toEqual(['SUBMIT', 'VERIFY', 'REVOKE']);
  });
});

// ---- 模块装配与权限码 ----

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + providers 可解析）', () => {
    const module = ReportingModule.register();
    expect(module.controllers).toEqual([ReportsController, ReportingQueriesController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReportingModule)).toBeUndefined();
  });

  it('权限码：11 路由逐点声明（05-reporting.md §5 最小集 report:read|submit|audit|verify|revoke）', () => {
    const expected: readonly [object, string, string][] = [
      [ReportsController.prototype, 'submit', 'report:submit'],
      [ReportsController.prototype, 'submitBatch', 'report:submit'],
      [ReportsController.prototype, 'list', 'report:read'],
      [ReportsController.prototype, 'mine', 'report:read'],
      [ReportsController.prototype, 'pendingVerification', 'report:read'],
      [ReportsController.prototype, 'get', 'report:read'],
      [ReportsController.prototype, 'auditEdit', 'report:audit'],
      [ReportsController.prototype, 'verify', 'report:verify'],
      [ReportsController.prototype, 'revoke', 'report:revoke'],
      [ReportingQueriesController.prototype, 'drawingProgress', 'report:read'],
      [ReportingQueriesController.prototype, 'outputTrend', 'report:read'],
    ];
    for (const [target, method, code] of expected) {
      const actual = Reflect.getMetadata(
        PERMISSION_METADATA_KEY,
        (target as unknown as Record<string, object>)[method] as object,
      );
      expect(actual, `${String(method)} 权限码`).toBe(code);
    }
  });
});
