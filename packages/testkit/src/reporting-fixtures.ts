/**
 * reporting 模块联动夹具（M2-W7）。
 *
 * 跨模块端口（dispatch 有效派工单读 / baseline 工序合法性与末道判定 /
 * inspection 末道报工触发）的可注入假实现——供 reporting 联动验证与对账测试
 * 使用（真实端口由兄弟模块/组合根合流时提供）。
 *
 * 类型取舍：本文件自带与 application/src/reporting 各端口合同同形的**本地结构化
 * 类型**（testkit rootDir 不含 application 源；tsconfig 为并行线共享文件不可动）。
 * 结构化兼容——假实现可直接注入 ReportingModule 的对应端口参数位。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 reporting-ports.ts 合同） ----

/** 派工单消费面事实（DispatchFactForReport 镜像）。 */
export interface FixtureDispatchFactForReport {
  readonly dispatchId: string;
  /** 六类派工 kind：part/outsourcing/assembly/electrical/aftermarket/oddjob。 */
  readonly kind: string;
  /** draft/assigned/executing/done/cancelled。 */
  readonly state: string;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly quantity: number;
  readonly assignee: string | null;
}

/** inspection 来源事实镜像（末道报工：sourceType 恒 'report'）。 */
export interface FixtureReportSourceFact {
  readonly sourceType: 'report';
  readonly sourceRefId: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly workOrderId: string | null;
  readonly occurredAt: string;
  readonly triggeredBy: string;
}

/** inspection 来源入口回执镜像。 */
export interface FixtureReportIntakeReceipt {
  readonly inspectionId: string | null;
  readonly created: boolean;
  readonly reason?: string;
}

// ---- dispatch 有效派工单读假端口 ----

/**
 * 可编程派工单读夹具：seed 即生效（缺省 kind=part / state=executing / 工艺属性
 * 齐）；未 seed 的派工单返回 null（= 无单 → submit fail-closed 拒绝）。
 */
export class FakeValidDispatchSource {
  readonly facts = new Map<string, FixtureDispatchFactForReport>();
  readonly calls: string[] = [];

  seed(
    overrides: Partial<Omit<FixtureDispatchFactForReport, 'dispatchId'>> & { dispatchId: string },
  ): FixtureDispatchFactForReport {
    const fact: FixtureDispatchFactForReport = {
      kind: 'part',
      state: 'executing',
      workOrderId: null,
      drawingNo: null,
      operationCode: null,
      quantity: 100,
      assignee: null,
      ...overrides,
    };
    this.facts.set(fact.dispatchId, fact);
    return fact;
  }

  async findDispatch(
    _tenant: TenantId,
    dispatchId: string,
  ): Promise<FixtureDispatchFactForReport | null> {
    this.calls.push(dispatchId);
    return this.facts.get(dispatchId) ?? null;
  }
}

// ---- baseline 工序合法性假端口 ----

/** 可编程工序库夹具：seed(processCode) 即已知；未 seed 的工序返回 false（submit 拒）。 */
export class FakeOperationValidity {
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

// ---- baseline 工艺路线末道判定假端口 ----

/**
 * 可编程末道判定夹具：seedFinal(drawingNo, operationCode) 标记末道；未标记组合
 * 返回 false（不触发自制质检——缺省空实现同语义）。
 */
export class FakeFinalOperationJudge {
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

// ---- inspection 末道报工触发假端口 ----

/**
 * 可编程末道触发夹具：facts 记录全部来源事实；nextReceipt 可编程回执
 * （缺省 created:true——未接线语义用 { created: false, reason } 编程）。
 */
export class FakeReportInspectionIntake {
  readonly facts: FixtureReportSourceFact[] = [];
  nextReceipt: FixtureReportIntakeReceipt = {
    inspectionId: 'ins-fixture',
    created: true,
  };

  async receiveSourceFact(_tenant: TenantId, fact: FixtureReportSourceFact) {
    this.facts.push(fact);
    return this.nextReceipt;
  }
}
