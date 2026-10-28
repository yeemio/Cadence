/**
 * 能力 material-gap：工作令最新齐套核对 + 采购关联（只读）。
 *
 * 取数：GapCheckStore.latestByWorkOrder（requiredQty/availableQty/gapQty/
 * neededBy/kind）+ listing 域采购关联（PurchaseRequestStore / PurchaseOrderStore，
 * 按 workOrderId 过滤）。
 *
 * 完整性纪律（CONTRACT v1）：目标工作令**无齐套核对记录 → unavailable**
 * （数据源未就绪），不得按零缺口回答；已有核对且缺口行为零是合法 answer。
 */
import type { GapCheckStore, PurchaseOrderStore, PurchaseRequestStore } from '../listing/listing-stores.js';
import { listingKindLabel, purchaseOrderStateLabel } from '../listing/listing-config.js';
import type { WorkOrder } from '../workorder/workorder-stores.js';
import type { AiQueryFactCard, AiQueryFactCardRows, AiQueryCompleteness } from './ai-query-ports.js';
import {
  GAP_AVAILABLE_QTY_CALIBER_NOTE,
  capRows,
  type AiQueryCapabilityContext,
  type AiQueryCapabilityResult,
} from './ai-query.capabilities.js';

function rowsOf(columns: AiQueryFactCardRows['columns'], values: readonly (string | number | null)[][]): AiQueryFactCardRows {
  return { columns, values };
}

function completenessOf(shown: number, capped: { truncated: boolean; total: number }): AiQueryCompleteness {
  return capped.truncated
    ? { status: 'truncated', rowCount: shown, totalKnown: true, note: `共 ${capped.total} 行，展示前 ${shown} 行` }
    : { status: 'complete', rowCount: shown, totalKnown: true };
}

export class MaterialGapCapability {
  constructor(
    private readonly gapChecks: GapCheckStore,
    private readonly purchaseRequests: PurchaseRequestStore,
    private readonly purchaseOrders: PurchaseOrderStore,
  ) {}

  async execute(context: AiQueryCapabilityContext & { readonly subjectOrder: WorkOrder }): Promise<AiQueryCapabilityResult> {
    const order = context.subjectOrder;
    const queryMoment = context.queryMoment;
    const gap = await this.gapChecks.latestByWorkOrder(context.tenant, String(order.id));
    if (gap === null) {
      return {
        unavailableDetail: `工作令「${order.projectName}」尚无齐套核对记录（数据源未就绪）——请先在清单域完成缺口核查后再查询，不能按零缺口回答。`,
      };
    }

    const [requests, orders] = await Promise.all([
      this.purchaseRequests.list(context.tenant, { workOrderId: String(order.id) }),
      this.purchaseOrders.list(context.tenant, { workOrderId: String(order.id) }),
    ]);

    const subject = { kind: 'workorder' as const, id: String(order.id), label: order.projectName || String(order.id) };

    // ---- 卡 1：齐套总览（类目汇总行表） ----
    const kindsCapped = capRows(gap.kinds, context.rowLimit);
    const overviewCard: AiQueryFactCard = {
      subject,
      title: '物料缺口（最新齐套核对）',
      metrics: [
        { key: 'complete', label: '齐套状态', value: gap.complete ? '齐套' : '存在缺口' },
        { key: 'gapLineCount', label: '缺口行数', value: gap.gapLines.length },
        { key: 'checkedAt', label: '核查时刻', value: gap.checkedAt },
      ],
      rows: rowsOf(
        [
          { key: 'kind', label: '类目' },
          { key: 'lineCount', label: '行数' },
          { key: 'checkedLineCount', label: '已核查行' },
          { key: 'gapLineCount', label: '缺口行' },
          { key: 'complete', label: '齐套' },
        ],
        kindsCapped.values.map((kind) => [
          listingKindLabel(kind.kind),
          kind.lineCount,
          kind.checkedLineCount,
          kind.gapLineCount,
          kind.complete ? '齐套' : '有缺口',
        ]),
      ),
      timeBasis: { kind: 'point', label: `核查时刻 ${gap.checkedAt}` },
      sourceRefs: [{ ref: `gap-check:${gap.id}`, queryMoment }],
      completeness: completenessOf(kindsCapped.values.length, kindsCapped),
    };

    // ---- 卡 2：缺口明细行 ----
    const linesCapped = capRows(gap.gapLines, context.rowLimit);
    const linesCard: AiQueryFactCard = {
      subject,
      title: '缺口明细',
      metrics: [
        { key: 'totalGapQty', label: '缺口数量合计', value: gap.gapLines.reduce((sum, line) => sum + line.gapQty, 0) },
      ],
      rows: rowsOf(
        [
          { key: 'kind', label: '类目' },
          { key: 'drawingNo', label: '图号' },
          { key: 'itemId', label: '物料' },
          { key: 'requiredQty', label: '需求数量' },
          { key: 'availableQty', label: '可用数量' },
          { key: 'gapQty', label: '缺口数量' },
          { key: 'neededBy', label: '需求日期' },
        ],
        linesCapped.values.map((line) => [
          listingKindLabel(line.kind),
          line.drawingNo,
          line.itemId,
          line.requiredQty,
          line.availableQty,
          line.gapQty,
          line.neededBy,
        ]),
      ),
      timeBasis: { kind: 'point', label: `核查时刻 ${gap.checkedAt}` },
      sourceRefs: [{ ref: `gap-check:${gap.id}`, queryMoment }],
      completeness: completenessOf(linesCapped.values.length, linesCapped),
    };

    // ---- 卡 3：采购关联（请购/采购单，缺口的在途供给） ----
    const ordersCapped = capRows(orders, context.rowLimit);
    const purchaseCard: AiQueryFactCard = {
      subject,
      title: '采购关联',
      metrics: [
        { key: 'requestCount', label: '请购单数', value: requests.length },
        { key: 'orderCount', label: '采购单数', value: orders.length },
      ],
      rows: rowsOf(
        [
          { key: 'orderId', label: '采购单' },
          { key: 'state', label: '状态' },
          { key: 'supplierName', label: '供应商' },
          { key: 'promisedAt', label: '交期' },
        ],
        ordersCapped.values.map((po) => [po.id, purchaseOrderStateLabel(po.state), po.supplierName, po.promisedAt]),
      ),
      timeBasis: { kind: 'point', label: '查询时刻' },
      sourceRefs: [
        { ref: `purchase-requests:wo:${String(order.id)}`, queryMoment },
        { ref: `purchase-orders:wo:${String(order.id)}`, queryMoment },
      ],
      completeness: completenessOf(ordersCapped.values.length, ordersCapped),
    };

    const summary =
      gap.gapLines.length === 0
        ? `查询有效、无记录：工作令「${order.projectName}」最新齐套核对（${gap.checkedAt}）各类目无缺口行`
        : `工作令「${order.projectName}」最新齐套核对（${gap.checkedAt}）：${gap.complete ? '各类目齐套' : '存在缺口'}，缺口 ${gap.gapLines.length} 行、缺口数量合计 ${gap.gapLines.reduce((sum, line) => sum + line.gapQty, 0)}；关联请购 ${requests.length} 单、采购单 ${orders.length} 单`;

    return { summary, caliberNotes: [GAP_AVAILABLE_QTY_CALIBER_NOTE], factCards: [overviewCard, linesCard, purchaseCard] };
  }
}
