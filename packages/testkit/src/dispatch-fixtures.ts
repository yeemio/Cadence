/**
 * dispatch 模块联动夹具（M2-W6）。
 *
 * 跨模块端口（workorder KitCheck 齐套读 / baseline 外协实时取价 / inspection
 * 外协回厂触发 / 外协加工单打印）的可注入假实现——供 dispatch 联动验证与对账
 * 测试使用（真实端口由兄弟模块/边缘包合流时提供）。
 *
 * 类型取舍：本文件自带与 application/src/dispatch 各端口合同同形的**本地结构化
 * 类型**（testkit rootDir 不含 application 源；tsconfig 为并行线共享文件不可动）。
 * 结构化兼容——假实现可直接注入 DispatchModule 的对应端口参数位。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 dispatch-ports.ts 合同） ----

/** 齐套快照消费面（KitCheckFact 镜像）。 */
export interface FixtureKitCheckFact {
  readonly id: string;
  readonly workOrderId: string;
  readonly complete: boolean;
  readonly gapLineCount: number;
  readonly refreshedAt: string;
}

/** baseline 取价报价镜像（金额全整数精确；字段口径以 baseline outsourcing-price 为准）。 */
export interface FixtureOutsourcingPriceQuote {
  readonly ruleCode: string;
  readonly processCode: string;
  readonly unitPriceMinor: number;
  readonly marginPermyriad: number;
  readonly priceMinor: number;
}

/** inspection 来源事实镜像（外协回厂：sourceType 恒 'dispatch'）。 */
export interface FixtureDispatchSourceFact {
  readonly sourceType: 'dispatch';
  readonly sourceRefId: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly workOrderId: string | null;
  readonly occurredAt: string;
  readonly triggeredBy: string;
}

/** 打印文档镜像（外协加工单结构化数据——TSPL/pdf 渲染归 integration-print）。 */
export interface FixtureDispatchPrintDocument {
  readonly dispatchId: string;
  readonly kind: string;
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly lines: readonly {
    readonly lineNo: number;
    readonly processCode: string;
    readonly drawingNo: string | null;
    readonly quantity: number;
    readonly unitPriceLabel: string;
    readonly promisedAt: string | null;
  }[];
}

// ---- workorder KitCheck 齐套读假端口 ----

/**
 * 可编程齐套读夹具：seed 即生效（complete=false 时携带缺口行数）；
 * 未 seed 的工作令返回 null（= 无核查记录 → 装配/电气创建 fail-closed 拒绝）。
 */
export class FakeKitCheckReadPort {
  readonly facts = new Map<string, FixtureKitCheckFact>();
  readonly calls: string[] = [];

  seed(workOrderId: string, complete: boolean, gapLineCount = 0, refreshedAt = '2026-10-25T08:00:00.000Z'): void {
    this.facts.set(workOrderId, {
      id: `kc-fixture-${workOrderId}`,
      workOrderId,
      complete,
      gapLineCount,
      refreshedAt,
    });
  }

  async latestKitCheck(_tenant: TenantId, workOrderId: string): Promise<FixtureKitCheckFact | null> {
    this.calls.push(workOrderId);
    return this.facts.get(workOrderId) ?? null;
  }
}

// ---- baseline 外协实时取价假端口 ----

/**
 * 可编程取价夹具：seed(processCode, 单价分, 利润率万分比) 即生效；
 * 取价 = round-half-up(单价 × (10000 + 利润率) / 10000)——与 baseline 纯函数同口径。
 * 未 seed 的工序返回 null（= 无规则 → 外协行未定价待补录）。
 */
export class FakeOutsourcingPriceSource {
  readonly quotes = new Map<string, FixtureOutsourcingPriceQuote>();
  readonly calls: string[] = [];

  seed(processCode: string, unitPriceMinor: number, marginPermyriad: number): void {
    const priceMinor = Math.floor((unitPriceMinor * (10_000 + marginPermyriad) + 5_000) / 10_000);
    this.quotes.set(processCode, {
      ruleCode: `rule-fixture-${processCode}`,
      processCode,
      unitPriceMinor,
      marginPermyriad,
      priceMinor,
    });
  }

  async resolve(_tenant: TenantId, processCode: string): Promise<FixtureOutsourcingPriceQuote | null> {
    this.calls.push(processCode);
    return this.quotes.get(processCode) ?? null;
  }
}

// ---- inspection 外协回厂触发假端口 ----

/**
 * 可编程回厂触发夹具：facts 记录全部来源事实；nextReceipt 可编程回执
 * （缺省 created:true——未接线语义用 { created: false, reason } 编程）。
 */
export class FakeDispatchInspectionIntake {
  readonly facts: FixtureDispatchSourceFact[] = [];
  nextReceipt: { readonly inspectionId: string | null; readonly created: boolean; readonly reason?: string } = {
    inspectionId: 'ins-fixture',
    created: true,
  };

  async receiveSourceFact(_tenant: TenantId, fact: FixtureDispatchSourceFact) {
    this.facts.push(fact);
    return this.nextReceipt;
  }
}

// ---- 打印假端口 ----

/** 可编程打印夹具：documents 记录全部打印提交；nextReceipt 可编程回执。 */
export class FakeDispatchPrintPort {
  readonly documents: FixtureDispatchPrintDocument[] = [];
  nextReceipt: { readonly printed: boolean; readonly jobId: string | null; readonly refusedReason?: string } = {
    printed: true,
    jobId: 'job-fixture',
  };

  async print(_tenant: TenantId, document: FixtureDispatchPrintDocument) {
    this.documents.push(document);
    return this.nextReceipt;
  }
}
