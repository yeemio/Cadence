/**
 * metric-pack 模块联动夹具（M3）。
 *
 * 口径求值事实源（MetricSourceSet——六种 sourceKind 的 MetricSource 绑定表）
 * 的可注入假实现——供 metric-pack 求值联动验证与对账测试使用（真实端口由
 * 组合根绑定：business-store `./metric-pack` 的 connectMetricSourceBundle，
 * 合同 §4）。
 *
 * 类型取舍同 payroll-fixtures / costing-fixtures：本地结构化镜像类型
 * （testkit rootDir 不含 metric-pack / engine-reporting 源），结构化兼容——
 * 假实现可直接注入 MetricPackService 的 sourceSet 参数位（经 metricSourceSetOf
 * 组装）。行形状按六源契约（metric-pack-config sourceKind 词表注）；判定字段
 * （onTimeFlag / isOverdue / deliveryVerdict）按已物化数据字段对待。
 */

// ---- 本地结构化类型（镜像 engine-reporting MetricSource 端口合同） ----

/** 事实源行镜像（三时间列 + occurredAt + 领域字段）。 */
export interface FixtureMetricSourceRow {
  readonly occurredAt: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
  readonly [field: string]: unknown;
}

/** 读行请求镜像（sourceKind + 时间口径 + 可选时间窗）。 */
export interface FixtureMetricSourceRequest {
  readonly sourceKind: string;
  readonly timeBasis: 'business' | 'available' | 'occurred';
  readonly from?: string;
  readonly to?: string;
  readonly filter?: unknown;
}

/** 单一事实源镜像（引擎 MetricSource 同形；只读行集）。 */
export interface FixtureMetricSource {
  read(request: FixtureMetricSourceRequest): Promise<readonly FixtureMetricSourceRow[]>;
}

// ---- 命令提交体基线（录制/回放对账用） ----

/** metric-pack.activate 提交体（装载/升级口径包：pack = 可序列化包原始数据）。 */
export interface FixtureActivateSubmission {
  readonly pack: Record<string, unknown>;
}

/** 求值/导出提交体（metricId+version 钉死定义 + 时间窗/切片/过滤）。 */
export interface FixtureEvaluateSubmission {
  readonly metricId: string;
  readonly version: number;
  readonly from?: string;
  readonly to?: string;
  readonly dimensionSlice?: Readonly<Record<string, readonly (string | number | boolean | null)[]>>;
}

/** 最小合法口径包（两口径小样本——装载联动的对账基线；缺省提交体）。 */
export const FIXTURE_MIN_PACK: Record<string, unknown> = {
  schemaVersion: 1,
  packId: 'fixture-pack',
  version: 1,
  title: '夹具口径包',
  metrics: [
    {
      schemaVersion: 1,
      metricId: 'fixture-delivery-count',
      version: 1,
      display: '夹具·交付计数',
      timeBasis: 'business',
      sourceKind: 'workorder-delivery-facts',
      dimensions: [
        { field: 'periodMonth', label: '期间(月)' },
        { field: 'deliveryVerdict', label: '交付判定' },
      ],
      measures: [{ measureId: 'workorder-count', aggregation: 'count' }],
    },
    {
      schemaVersion: 1,
      metricId: 'fixture-cost-sum',
      version: 1,
      display: '夹具·成本汇总',
      timeBasis: 'business',
      sourceKind: 'costing-entry-facts',
      dimensions: [
        { field: 'workOrderId', label: '工作令' },
        { field: 'category', label: '成本类别' },
      ],
      measures: [{ measureId: 'amount-minor', aggregation: 'sum', field: 'amountMinor' }],
    },
  ],
};

// ---- 事实源行集缺省（六源小样本；覆盖差异字段即可） ----

/** 六种 sourceKind 的缺省样例行集（与 m3-drafts/04-metric-pack §5 行为重述对齐）。 */
export function fixtureMetricSourceRows(): Readonly<Record<string, readonly FixtureMetricSourceRow[]>> {
  const T = '2026-11-01T08:00:00.000Z';
  return {
    'workorder-attachment-facts': [
      { occurredAt: T, businessTime: '2026-05-02T02:00:00.000Z', workOrderId: 'wo-fixture-1', drawingNo: 'DWG-A', attachmentId: 'att-fixture-1' },
      { occurredAt: T, businessTime: '2026-05-03T02:00:00.000Z', workOrderId: 'wo-fixture-1', drawingNo: 'DWG-A', attachmentId: 'att-fixture-2' },
    ],
    'workorder-delivery-facts': [
      { occurredAt: T, businessTime: '2026-05-10T00:00:00.000Z', workOrderId: 'wo-fixture-1', periodMonth: '2026-05', deliveryVerdict: 'on-time' },
      { occurredAt: T, businessTime: '2026-05-20T00:00:00.000Z', workOrderId: 'wo-fixture-2', periodMonth: '2026-05', deliveryVerdict: 'delayed' },
    ],
    'outsourcing-delivery-facts': [
      { occurredAt: T, businessTime: '2026-05-06T00:00:00.000Z', supplierId: 'sup-fixture-1', periodMonth: '2026-05', drawingNo: 'DWG-A', onTimeFlag: 1 },
      { occurredAt: T, businessTime: '2026-05-12T00:00:00.000Z', supplierId: 'sup-fixture-1', periodMonth: '2026-05', drawingNo: 'DWG-B', onTimeFlag: 0 },
    ],
    'purchase-overdue-facts': [
      { occurredAt: T, businessTime: '2026-05-01T00:00:00.000Z', orderLineId: 'po-fixture-1#1', orderId: 'po-fixture-1', outstandingQty: 30, isOverdue: true },
    ],
    'purchase-amount-facts': [
      { occurredAt: T, businessTime: '2026-05-20T00:00:00.000Z', workOrderId: 'wo-fixture-1', partType: 'drawing-part', orderId: 'po-fixture-1', orderLineId: 'po-fixture-1#1', lineAmountMinor: 15000 },
    ],
    'costing-entry-facts': [
      { occurredAt: T, businessTime: '2026-05-31T00:00:00.000Z', workOrderId: 'wo-fixture-1', category: 'material', amountMinor: 100000 },
      { occurredAt: T, businessTime: '2026-05-31T00:00:00.000Z', workOrderId: 'wo-fixture-1', category: 'labor', amountMinor: 50000 },
    ],
  };
}

// ---- 可编程源集假端口 ----

/**
 * 六源假实现：seed 即生效；read 按 sourceKind 取行并施加与引擎同语义的
 * 时间窗过滤（business 口径回落 occurredAt——适配器行为镜像；谓词过滤交
 * 引擎重复施加，假源不下推）。
 */
export class FakeMetricSourceSet {
  readonly rows: Record<string, FixtureMetricSourceRow[]> = {};
  /** 读取调用记录（断言适配请求形状用）。 */
  readonly requests: FixtureMetricSourceRequest[] = [];

  seed(sourceKind: string, row: FixtureMetricSourceRow): void {
    this.rows[sourceKind] = [...(this.rows[sourceKind] ?? []), row];
  }

  /** 装载整份缺省样例行集（fixtureMetricSourceRows）。 */
  seedDefaults(): void {
    for (const [sourceKind, rows] of Object.entries(fixtureMetricSourceRows())) {
      this.rows[sourceKind] = [...rows];
    }
  }

  /** 引擎 MetricSource 同形读取面（结构兼容注入 metricSourceSetOf）。 */
  readonly sources: Readonly<Record<string, FixtureMetricSource>> = new Proxy(
    {},
    {
      get: (_target, sourceKind: string) => ({
        read: async (request: FixtureMetricSourceRequest): Promise<readonly FixtureMetricSourceRow[]> => {
          this.requests.push(request);
          const rows = this.rows[request.sourceKind] ?? [];
          const basis = request.timeBasis ?? 'business';
          const fromMs = request.from === undefined ? undefined : new Date(request.from).getTime();
          const toMs = request.to === undefined ? undefined : new Date(request.to).getTime();
          if (fromMs === undefined && toMs === undefined) return rows;
          return rows.filter((row) => {
            const anchor =
              (basis === 'business' ? row.businessTime : basis === 'available' ? row.availableTime : undefined) ??
              row.occurredAt;
            const ms = new Date(anchor).getTime();
            if (fromMs !== undefined && ms < fromMs) return false;
            if (toMs !== undefined && ms > toMs) return false;
            return true;
          });
        },
      }),
    },
  );
}

// ---- 命令信封提交体构造（对账基线；信封字段由目标适配器补） ----

/** 激活提交体缺省（最小合法夹具包；装载/升级场景叠加 version 覆盖）。 */
export function activateSubmission(overrides: Partial<FixtureActivateSubmission> = {}): FixtureActivateSubmission {
  return {
    pack: JSON.parse(JSON.stringify(FIXTURE_MIN_PACK)) as Record<string, unknown>,
    ...overrides,
  };
}

/** 求值提交体缺省（夹具交付计数 2026-05 全窗）。 */
export function evaluateSubmission(overrides: Partial<FixtureEvaluateSubmission> = {}): FixtureEvaluateSubmission {
  return {
    metricId: 'fixture-delivery-count',
    version: 1,
    ...overrides,
  };
}
