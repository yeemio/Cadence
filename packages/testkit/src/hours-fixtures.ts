/**
 * hours 模块联动夹具（M2-W6）。
 *
 * 跨模块端口（reporting ReportVerified/ReportRevoked 订阅 / baseline
 * StandardTime 额定对标）的可注入假实现——供 hours 联动验证与对账测试使用
 * （真实端口由 reporting/baseline 合流时提供）。
 *
 * 类型取舍：本文件自带与 application/src/hours 各端口合同同形的**本地结构化
 * 类型**（testkit rootDir 不含 application 源；tsconfig 为并行线共享文件不可
 * 动）。结构化兼容——假实现可直接注入 HoursModule 的对应端口参数位。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 hours-ports.ts 合同） ----

/** 报工类别稳定码镜像（M2 Wave-4 验收中危 #2 前置窄修线：after-sales/misc → aftermarket/oddjob，与 reporting/hours-config REPORT_KINDS 同词表）。 */
export type FixtureReportKind = 'part' | 'assembly' | 'electrical' | 'aftermarket' | 'oddjob';

/** 报工事件载荷镜像（ReportVerified/ReportRevoked 共用快照形状）。 */
export interface FixtureReportEventPayload {
  readonly reportId: string;
  readonly kind: FixtureReportKind;
  readonly dispatchId: string | null;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly processCode: string | null;
  readonly worker: string;
  readonly doneQty: number;
  readonly hours: number;
  readonly workDate: string;
  readonly revokeReason: string | null;
  readonly actor: string;
}

export interface FixtureReportEventMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly signal: 'ReportVerified' | 'ReportRevoked';
  readonly payload: FixtureReportEventPayload;
}

/** verified 报工事件的常用缺省（覆盖差异字段即可）。 */
export function fixtureVerifiedPayload(
  overrides: Partial<FixtureReportEventPayload> = {},
): FixtureReportEventPayload {
  return {
    reportId: 'rpt-fixture-0001',
    kind: 'part',
    dispatchId: 'dsp-fixture-0001',
    workOrderId: 'wo-fixture-0001',
    drawingNo: 'DWG-F1',
    processCode: 'P01',
    worker: 'u-worker-fixture-01',
    doneQty: 10,
    hours: 8,
    workDate: '2026-10-05',
    revokeReason: null,
    actor: 'u-auditor-fixture',
    ...overrides,
  };
}

// ---- reporting 事件订阅假端口 ----

/** 可编程订阅夹具：seed 进消息即生效；acknowledge 记账去重。 */
export class FakeReportEventFeed {
  readonly messages: FixtureReportEventMessage[] = [];
  readonly acknowledged: string[] = [];
  private counter = 0;

  seedVerified(payload: FixtureReportEventPayload): string {
    return this.push('ReportVerified', payload);
  }

  /** 撤销事件（载荷携撤销时点快照——工时侧以账本实际值为准冲销）。 */
  seedRevoked(payload: FixtureReportEventPayload): string {
    return this.push('ReportRevoked', payload);
  }

  private push(signal: FixtureReportEventMessage['signal'], payload: FixtureReportEventPayload): string {
    this.counter += 1;
    const eventId = `evt-report-fixture-${this.counter}`;
    this.messages.push({
      eventId,
      tenantId: 't1',
      occurredAt: new Date().toISOString(),
      signal,
      payload,
    });
    return eventId;
  }

  async pending(tenant: TenantId): Promise<readonly FixtureReportEventMessage[]> {
    return this.messages
      .filter((message) => message.tenantId === tenant && !this.acknowledged.includes(message.eventId))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async acknowledge(eventId: string): Promise<void> {
    if (!this.acknowledged.includes(eventId)) this.acknowledged.push(eventId);
  }
}

// ---- baseline StandardTime 额定对标假端口 ----

/** 可编程额定工时夹具：set `${drawingNo}|${processCode}` → 小时；缺键 = null。 */
export class FakeStandardTimeLookup {
  readonly table = new Map<string, number>();

  seed(drawingNo: string | null, processCode: string | null, standardHours: number): void {
    this.table.set(`${drawingNo ?? ''}|${processCode ?? ''}`, standardHours);
  }

  async standardHours(
    _tenant: TenantId,
    ref: { readonly drawingNo: string | null; readonly processCode: string | null },
  ): Promise<number | null> {
    return this.table.get(`${ref.drawingNo ?? ''}|${ref.processCode ?? ''}`) ?? null;
  }
}
