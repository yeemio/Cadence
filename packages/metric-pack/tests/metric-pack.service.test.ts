/**
 * MetricPackService 行为测试（M3，m3-drafts/04-metric-pack.md v1.0 Done-when 与
 * §6 版本化售卖纪律）。
 *
 * 覆盖面：
 *  - 装载/升级/降级拒绝 + MetricPackActivated 事件（升级留痕 supersedes）；
 *  - G1 先解析校验后记账（被拒命令不占用 operationId；同 op 重发幂等拒绝）；
 *  - 六张口径求值（六源样例行集 → 期望分组数/度量值——行为重述对账锚）；
 *  - 维度切片下钻 + 明细口径（93 未按期图号 / 95 订单行）；
 *  - 未装载不可见（NotFound 同形）；标准 4 张不受影响（本包不涉）；
 *  - 口径演进：升级后旧 metricId@version 按历史装载快照可复算；
 *  - 导出端口化 json-tables（求值即重算；空结果拒绝）。
 */
import { describe, expect, it } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import { createInMemoryMetricSource, type MetricSourceRow } from '@smes/engine-reporting';
import {
  InMemoryMetricPackActivationStore,
  InMemoryMetricPackDomainEventStore,
  InMemoryMetricPackOperationStore,
  MACHINING_CALIB_PACK_V1,
  METRIC_PACK_EVENT_TYPES,
  MetricPackNotFoundError,
  MetricPackService,
  metricSourceSetOf,
  type MetricPackCommandEnvelope,
} from '../src/index.js';

// ---- 测试装配 ----

const TENANT = TenantId.create('t-metric-pack-test');
const ADMIN = UserId.create('u-admin-1');

/** 六源样例行集（与 §5 六张口径的行为重述对齐；occurredAt/businessTime 双锚）。 */
const T = '2026-11-01T08:00:00.000Z';

const ATTACHMENT_ROWS: MetricSourceRow[] = [
  { occurredAt: T, businessTime: '2026-05-02T02:00:00.000Z', workOrderId: 'wo-1', drawingNo: 'dwg-A', attachmentId: 'att-1' },
  { occurredAt: T, businessTime: '2026-05-02T02:05:00.000Z', workOrderId: 'wo-1', drawingNo: 'dwg-A', attachmentId: 'att-2' },
  { occurredAt: T, businessTime: '2026-05-03T02:00:00.000Z', workOrderId: 'wo-1', drawingNo: 'dwg-B', attachmentId: 'att-3' },
  { occurredAt: T, businessTime: '2026-05-04T02:00:00.000Z', workOrderId: 'wo-2', drawingNo: 'dwg-A', attachmentId: 'att-4' },
];

const WORKORDER_DELIVERY_ROWS: MetricSourceRow[] = [
  { occurredAt: T, businessTime: '2026-05-10T00:00:00.000Z', workOrderId: 'wo-1', periodMonth: '2026-05', deliveryVerdict: 'on-time', plannedDeliveryAt: '2026-05-10T00:00:00.000Z', actualDeliveryAt: '2026-05-09T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-05-15T00:00:00.000Z', workOrderId: 'wo-2', periodMonth: '2026-05', deliveryVerdict: 'on-time', plannedDeliveryAt: '2026-05-15T00:00:00.000Z', actualDeliveryAt: '2026-05-15T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-05-20T00:00:00.000Z', workOrderId: 'wo-3', periodMonth: '2026-05', deliveryVerdict: 'delayed', plannedDeliveryAt: '2026-05-18T00:00:00.000Z', actualDeliveryAt: '2026-05-22T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-06-01T00:00:00.000Z', workOrderId: 'wo-4', periodMonth: '2026-06', deliveryVerdict: 'undelivered', plannedDeliveryAt: '2026-06-30T00:00:00.000Z', actualDeliveryAt: null },
];

const OUTSOURCING_ROWS: MetricSourceRow[] = [
  { occurredAt: T, businessTime: '2026-05-06T00:00:00.000Z', supplierId: 'sup-a', periodMonth: '2026-05', drawingNo: 'dwg-A', onTimeFlag: 1, dispatchId: 'dsp-1', lineId: 'osl-1', promisedAt: '2026-05-05T00:00:00.000Z', returnedAt: '2026-05-06T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-05-12T00:00:00.000Z', supplierId: 'sup-a', periodMonth: '2026-05', drawingNo: 'dwg-B', onTimeFlag: 0, dispatchId: 'dsp-1', lineId: 'osl-2', promisedAt: '2026-05-10T00:00:00.000Z', returnedAt: '2026-05-12T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-05-08T00:00:00.000Z', supplierId: 'sup-b', periodMonth: '2026-05', drawingNo: 'dwg-C', onTimeFlag: 1, dispatchId: 'dsp-2', lineId: 'osl-3', promisedAt: '2026-05-07T00:00:00.000Z', returnedAt: '2026-05-08T00:00:00.000Z' },
];

const PURCHASE_OVERDUE_ROWS: MetricSourceRow[] = [
  { occurredAt: T, businessTime: '2026-05-01T00:00:00.000Z', orderLineId: 'po-1#1', orderId: 'po-1', itemId: 'item-1', drawingNo: 'dwg-A', outstandingQty: 30, isOverdue: true, promisedAt: '2026-05-01T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-05-01T00:00:00.000Z', orderLineId: 'po-1#2', orderId: 'po-1', itemId: 'item-2', drawingNo: null, outstandingQty: 10, isOverdue: false, promisedAt: '2026-07-01T00:00:00.000Z' },
  { occurredAt: T, businessTime: '2026-05-01T00:00:00.000Z', orderLineId: 'po-2#1', orderId: 'po-2', itemId: 'item-3', drawingNo: null, outstandingQty: 0, isOverdue: true, promisedAt: '2026-04-01T00:00:00.000Z' },
];

const PURCHASE_AMOUNT_ROWS: MetricSourceRow[] = [
  { occurredAt: T, businessTime: '2026-05-20T00:00:00.000Z', workOrderId: 'wo-1', partType: 'drawing-part', orderId: 'po-1', orderLineId: 'po-1#1', lineAmountMinor: 15000, receivedQty: 30, unitPriceMinor: 500 },
  { occurredAt: T, businessTime: '2026-05-21T00:00:00.000Z', workOrderId: 'wo-1', partType: 'standard-part', orderId: 'po-2', orderLineId: 'po-2#1', lineAmountMinor: 8000, receivedQty: 40, unitPriceMinor: 200 },
  { occurredAt: T, businessTime: '2026-05-22T00:00:00.000Z', workOrderId: 'wo-2', partType: 'drawing-part', orderId: 'po-1', orderLineId: 'po-1#3', lineAmountMinor: 2000, receivedQty: 4, unitPriceMinor: 500 },
];

const COSTING_ROWS: MetricSourceRow[] = [
  { occurredAt: T, businessTime: '2026-05-31T00:00:00.000Z', workOrderId: 'wo-1', category: 'material', amountMinor: 100000, entryId: 'ce-1' },
  { occurredAt: T, businessTime: '2026-05-31T00:00:00.000Z', workOrderId: 'wo-1', category: 'labor', amountMinor: 50000, entryId: 'ce-2' },
  { occurredAt: T, businessTime: '2026-05-31T00:00:00.000Z', workOrderId: 'wo-1', category: 'outsourcing', amountMinor: 30000, entryId: 'ce-3' },
];

interface Harness {
  readonly service: MetricPackService;
  readonly activations: InMemoryMetricPackActivationStore;
}

function makeHarness(): Harness {
  const activations = new InMemoryMetricPackActivationStore();
  const service = new MetricPackService(
    {
      activations,
      events: new InMemoryMetricPackDomainEventStore(),
      operations: new InMemoryMetricPackOperationStore(),
    },
    metricSourceSetOf({
      'workorder-attachment-facts': createInMemoryMetricSource('workorder-attachment-facts', ATTACHMENT_ROWS),
      'workorder-delivery-facts': createInMemoryMetricSource('workorder-delivery-facts', WORKORDER_DELIVERY_ROWS),
      'outsourcing-delivery-facts': createInMemoryMetricSource('outsourcing-delivery-facts', OUTSOURCING_ROWS),
      'purchase-overdue-facts': createInMemoryMetricSource('purchase-overdue-facts', PURCHASE_OVERDUE_ROWS),
      'purchase-amount-facts': createInMemoryMetricSource('purchase-amount-facts', PURCHASE_AMOUNT_ROWS),
      'costing-entry-facts': createInMemoryMetricSource('costing-entry-facts', COSTING_ROWS),
    }),
    undefined,
    { now: () => '2026-11-01T08:00:00.000Z' },
  );
  return { service, activations };
}

let opCounter = 0;
function envelope(
  kind: MetricPackCommandEnvelope['command']['kind'],
  payload: unknown,
  operationId?: string,
): MetricPackCommandEnvelope {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: TENANT,
    issuedBy: ADMIN,
    operationId: OperationId.create(operationId ?? `op-metric-pack-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: 'initial',
    issuedAt: '2026-11-01T08:00:00.000Z',
    command: { kind, payload },
  });
}

const CALIB_PACK_JSON = JSON.parse(JSON.stringify(MACHINING_CALIB_PACK_V1)) as Record<string, unknown>;

async function activateCalib(h: Harness, pack: Record<string, unknown> = CALIB_PACK_JSON, operationId?: string) {
  return h.service.execute(TENANT, envelope('metric-pack.activate.v1', { pack }, operationId));
}

async function activateBase(h: Harness): Promise<void> {
  const result = await activateCalib(h);
  expect(result.status).toBe('committed');
}

// ---- metric-pack.activate.v1 ----

describe('metric-pack.activate.v1（装载/升级）', () => {
  it('首装 committed + MetricPackActivated 事件 + 装载清单可见', async () => {
    const h = makeHarness();
    const result = await activateCalib(h);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.activation?.packId).toBe('smes-machining-calib');
    expect(result.activation?.packVersion).toBe(1);
    expect(result.activation?.status).toBe('current');
    expect(result.activation?.metrics).toHaveLength(8);
    expect(result.events.map((event) => event.eventType)).toEqual([METRIC_PACK_EVENT_TYPES.metricPackActivated]);
    const packs = await h.service.activePacks(TENANT);
    expect(packs.map((pack) => `${pack.packId}@v${pack.packVersion}:${pack.status}`)).toEqual([
      'smes-machining-calib@v1:current',
    ]);
  });

  it('非法包 rejected（defineMetricPack 逐条校验）且不占用 operationId（同 id 重发合法包成功）', async () => {
    const h = makeHarness();
    const evil = { ...CALIB_PACK_JSON, metrics: [{ metricId: 'dup', version: 1 }, { metricId: 'dup', version: 1 }] };
    const rejected = await activateCalib(h, evil, 'op-evil-001');
    expect(rejected.status).toBe('rejected');
    // G1：被拒命令不占用 operationId——同 id 修正重发（换合法包）可装载。
    const retried = await activateCalib(h, CALIB_PACK_JSON, 'op-evil-001');
    expect(retried.status).toBe('committed');
  });

  it('同 operationId 重发（已 committed）幂等拒绝', async () => {
    const h = makeHarness();
    await activateBase(h);
    const again = await activateCalib(h, CALIB_PACK_JSON, 'op-metric-pack-0001');
    expect(again.status).toBe('rejected');
  });

  it('升级 = 新装载记录 supersedes 前任；历史版本只读可复算（装载快照不变）', async () => {
    const h = makeHarness();
    await activateBase(h);
    // v2：包版本 2 + 97 口径演进 v2（加 entry-count 度量；同 metricId 不同版本不并存于一个包）。
    const v2Metrics = (CALIB_PACK_JSON['metrics'] as Record<string, unknown>[]).map((metric) =>
      metric['metricId'] === 'project-cost-summary'
        ? { ...metric, version: 2, measures: [...(metric['measures'] as unknown[]), { measureId: 'entry-count', aggregation: 'count' }] }
        : metric,
    );
    const packV2 = { ...CALIB_PACK_JSON, version: 2, metrics: v2Metrics };
    const upgraded = await activateCalib(h, packV2);
    expect(upgraded.status).toBe('committed');
    if (upgraded.status !== 'committed') return;
    expect(upgraded.activation?.packVersion).toBe(2);
    expect(upgraded.activation?.supersedes).not.toBeNull();
    // 版本链：当前 v2 在前，历史 v1 superseded。
    const chain = await h.service.packVersions(TENANT, 'smes-machining-calib');
    expect(chain.map((view) => `${view.packVersion}:${view.status}`)).toEqual(['2:current', '1:superseded']);
    // 历史口径按装载快照复算：project-cost-summary@v1（无 entry-count 度量）仍可求值。
    const legacy = await h.service.evaluate(TENANT, { metricId: 'project-cost-summary', version: 1 });
    expect(legacy.measureIds).toEqual(['amount-minor']);
    const current = await h.service.evaluate(TENANT, { metricId: 'project-cost-summary', version: 2 });
    expect(current.measureIds).toEqual(['amount-minor', 'entry-count']);
    expect(current.rows.find((row) => row.key['category'] === 'material')?.values).toEqual({
      'amount-minor': 100000,
      'entry-count': 1,
    });
  });

  it('降级/重复装载 rejected（升级须包版本严格递增）', async () => {
    const h = makeHarness();
    await activateBase(h);
    const same = await activateCalib(h, CALIB_PACK_JSON);
    expect(same.status).toBe('rejected');
    if (same.status !== 'rejected') return;
    expect(same.reason).toContain('严格递增');
  });

  it('expectedRevision 非 initial 拒绝（装载是配置事实，版本语义在 packId@version 上）', async () => {
    const h = makeHarness();
    const envelopeWithRevision = makeCommandEnvelope({
      tenantId: TENANT,
      issuedBy: ADMIN,
      operationId: OperationId.create('op-revision-001'),
      expectedRevision: 1,
      issuedAt: '2026-11-01T08:00:00.000Z',
      command: {
        kind: 'metric-pack.activate.v1' as const,
        payload: { pack: CALIB_PACK_JSON },
      },
    });
    const result = await h.service.execute(TENANT, envelopeWithRevision);
    expect(result.status).toBe('rejected');
  });
});

// ---- 六张口径求值（行为重述对账锚） ----

describe('六张口径求值（装载后可见）', () => {
  it('88 下图统计：工作令×图号 distinct-count 图号 + count 附件', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, { metricId: 'drawing-intake-progress', version: 1 });
    expect(result.metric).toEqual({ metricId: 'drawing-intake-progress', version: 1 });
    expect(result.timeBasis).toBe('business');
    const wo1A = result.rows.find((row) => row.key['workOrderId'] === 'wo-1' && row.key['drawingNo'] === 'dwg-A');
    expect(wo1A?.values).toEqual({ 'uploaded-drawing-count': 1, 'attachment-count': 2 });
    expect(result.rows).toHaveLength(3); // wo-1×A / wo-1×B / wo-2×A
  });

  it('90 工作令交付：期间(月)×判定 计数对照', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, { metricId: 'workorder-delivery-comparison', version: 1 });
    const by = (month: string, verdict: string) =>
      result.rows.find((row) => row.key['periodMonth'] === month && row.key['deliveryVerdict'] === verdict)?.values['workorder-count'];
    expect(by('2026-05', 'on-time')).toBe(2);
    expect(by('2026-05', 'delayed')).toBe(1);
    expect(by('2026-06', 'undelivered')).toBe(1);
  });

  it('93 外协交货：准时率 avg(onTimeFlag) + 图号 distinct-count', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, { metricId: 'outsourcing-delivery-performance', version: 1 });
    const supA = result.rows.find((row) => row.key['supplierId'] === 'sup-a');
    expect(supA?.values).toEqual({ 'dispatch-line-count': 2, 'on-time-rate': 0.5, 'drawing-count': 2 });
    const supB = result.rows.find((row) => row.key['supplierId'] === 'sup-b');
    expect(supB?.values?.['on-time-rate']).toBe(1);
  });

  it('94 采购件预期：根过滤后只剩"已逾期且未入库"订单行', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, { metricId: 'purchase-overdue-outstanding', version: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.key['orderLineId']).toBe('po-1#1');
    expect(result.rows[0]?.values).toEqual({ 'outstanding-qty': 30, 'line-count': 1 });
  });

  it('95 采购金额汇总：工作令×零件类型金额 sum(分) + 订单 distinct-count', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, { metricId: 'purchase-amount-summary', version: 1 });
    const wo1Drawing = result.rows.find((row) => row.key['workOrderId'] === 'wo-1' && row.key['partType'] === 'drawing-part');
    expect(wo1Drawing?.values).toEqual({ 'received-amount-minor': 15000, 'order-count': 1 });
    expect(result.rows).toHaveLength(3);
  });

  it('97 项目成本：工作令×成本类别三分类金额（= costing 同口径快照）', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, { metricId: 'project-cost-summary', version: 1 });
    const amountOf = (category: string) => result.rows.find((row) => row.key['category'] === category)?.values['amount-minor'];
    expect(amountOf('material')).toBe(100000);
    expect(amountOf('labor')).toBe(50000);
    expect(amountOf('outsourcing')).toBe(30000);
  });
});

// ---- 下钻（维度切片 + 明细口径） ----

describe('下钻（§3 查询：维度切片细化 + 查询过滤）', () => {
  it('主口径 dimensionSlice 切片（90 锁定 2026-05）', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, {
      metricId: 'workorder-delivery-comparison',
      version: 1,
      dimensionSlice: { periodMonth: ['2026-05'] },
    });
    expect(result.rows).toHaveLength(2); // on-time + delayed
  });

  it('93 下钻明细口径：未按期图号明细（onTimeFlag=0 根过滤 + 图号维度）', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, {
      metricId: 'outsourcing-delivery-detail',
      version: 1,
      dimensionSlice: { supplierId: ['sup-a'] },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.key).toMatchObject({ supplierId: 'sup-a', periodMonth: '2026-05', drawingNo: 'dwg-B' });
  });

  it('95 下钻明细口径：订单行粒度金额明细 + 查询期过滤', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, {
      metricId: 'purchase-amount-detail',
      version: 1,
      dimensionSlice: { workOrderId: ['wo-1'] },
    });
    expect(result.rows).toHaveLength(2);
    const byLine = new Map(result.rows.map((row) => [row.key['orderLineId'], row.values['line-amount-minor']]));
    expect(byLine.get('po-1#1')).toBe(15000);
    expect(byLine.get('po-2#1')).toBe(8000);
  });

  it('时间窗求值（business 口径含端点）+ 查询过滤', async () => {
    const h = makeHarness();
    await activateBase(h);
    const result = await h.service.evaluate(TENANT, {
      metricId: 'drawing-intake-progress',
      version: 1,
      from: '2026-05-03T00:00:00.000Z',
      to: '2026-05-04T23:59:59.000Z',
    });
    // businessTime 落窗：att-3（05-03）与 att-4（05-04）→ wo-1×B 与 wo-2×A 两组。
    expect(result.rows.map((row) => `${row.key['workOrderId']}/${row.key['drawingNo']}`).sort()).toEqual([
      'wo-1/dwg-B',
      'wo-2/dwg-A',
    ]);
  });
});

// ---- 可见性与导出 ----

describe('未装载不可见 + 导出端口化', () => {
  it('未装载：求值 NotFound（与不存在同形）、无装载清单', async () => {
    const h = makeHarness();
    await expect(h.service.evaluate(TENANT, { metricId: 'project-cost-summary', version: 1 })).rejects.toBeInstanceOf(
      MetricPackNotFoundError,
    );
    expect(await h.service.activePacks(TENANT)).toEqual([]);
    // 装载别的包：未包含的口径同样不可见。
    await h.service.execute(
      TENANT,
      envelope('metric-pack.activate.v1', {
        pack: {
          schemaVersion: 1,
          packId: 'another-pack',
          version: 1,
          title: '另一份口径包',
          metrics: [(CALIB_PACK_JSON['metrics'] as unknown[])[0]],
        },
      }),
    );
    await expect(h.service.evaluate(TENANT, { metricId: 'project-cost-summary', version: 1 })).rejects.toBeInstanceOf(
      MetricPackNotFoundError,
    );
  });

  it('metric-pack.export.v1：求值即重算 → json-tables 回声；空结果拒绝', async () => {
    const h = makeHarness();
    await activateBase(h);
    const empty = await h.service.execute(
      TENANT,
      envelope('metric-pack.export.v1', { metricId: 'drawing-intake-progress', version: 1, from: '2027-01-01T00:00:00.000Z' }),
    );
    expect(empty.status).toBe('rejected');
    const exported = await h.service.execute(
      TENANT,
      envelope('metric-pack.export.v1', { metricId: 'workorder-delivery-comparison', version: 1 }, 'op-export-same'),
    );
    expect(exported.status).toBe('committed');
    if (exported.status !== 'committed') return;
    expect(exported.events).toEqual([]); // 导出只读不发事件
    expect(exported.export?.kind).toBe('json-tables');
    if (exported.export?.kind !== 'json-tables') return;
    expect(exported.export.sheets).toHaveLength(1);
    expect(exported.export.sheets[0]?.header).toEqual(['periodMonth', 'deliveryVerdict', 'workorder-count']);
    expect(exported.export.sheets[0]?.rows).toHaveLength(3);
    // 同 operationId 重发幂等拒绝（G1 不变量 3）。
    const again = await h.service.execute(
      TENANT,
      envelope('metric-pack.export.v1', { metricId: 'workorder-delivery-comparison', version: 1 }, 'op-export-same'),
    );
    expect(again.status).toBe('rejected');
  });

  it('事实源未绑定：已装载口径求值显式报错（不静默空结果）', async () => {
    const service = new MetricPackService(
      {
        activations: new InMemoryMetricPackActivationStore(),
        events: new InMemoryMetricPackDomainEventStore(),
        operations: new InMemoryMetricPackOperationStore(),
      },
    );
    const activated = await service.execute(
      TENANT,
      envelope('metric-pack.activate.v1', { pack: CALIB_PACK_JSON }),
    );
    expect(activated.status).toBe('committed');
    await expect(service.evaluate(TENANT, { metricId: 'project-cost-summary', version: 1 })).rejects.toThrow(
      /事实源 'costing-entry-facts' 未绑定/,
    );
  });
});
