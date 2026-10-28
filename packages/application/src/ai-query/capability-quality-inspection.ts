/**
 * 能力 quality-inspection：时间窗内不合格检验 + 处置状态（只读）。
 *
 * 取数：InspectionOrderStore（state=failed 且 judgedAt 落窗 [from, to)）+
 * NonconformStore 处置状态（按 inspectionId 关联）。时间语义 freeze（见
 * ai-query-time.ts）：今日/本周按当地（Asia/Shanghai）零点与周一起点，最近N天
 * 滚动 N×24h；now 经可注入时钟。
 */
import { inspectionKindLabel, nonconformDisposalLabel, nonconformStateLabel } from '../inspection/inspection-config.js';
import type { InspectionOrderStore, Nonconform, NonconformStore } from '../inspection/inspection-stores.js';
import type { AiQueryFactCard, AiQueryFactCardRows, AiQueryCompleteness, AiQueryTimeRange } from './ai-query-ports.js';
import { resolveTimeWindow } from './ai-query-time.js';
import {
  INSPECTION_WINDOW_CALIBER_NOTE,
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

export class QualityInspectionCapability {
  constructor(
    private readonly inspectionOrders: InspectionOrderStore,
    private readonly nonconforms: NonconformStore,
  ) {}

  async execute(context: AiQueryCapabilityContext & { readonly timeRange: AiQueryTimeRange }): Promise<AiQueryCapabilityResult> {
    const queryMoment = context.queryMoment;
    const window = resolveTimeWindow(context.timeRange, queryMoment);

    const [failed, nonconforms] = await Promise.all([
      this.inspectionOrders.list(context.tenant, { state: 'failed' }),
      this.nonconforms.list(context.tenant),
    ]);
    // 落窗口径：判定时刻 judgedAt ∈ [from, to)（failed 单必有判定时刻；null 防御性排除）。
    const inWindow = failed.filter(
      (order) => order.judgedAt !== null && order.judgedAt >= window.from && order.judgedAt < window.to,
    );
    const nonconformsByInspection = new Map<string, Nonconform[]>();
    for (const nonconform of nonconforms) {
      const bucket = nonconformsByInspection.get(String(nonconform.inspectionId));
      if (bucket === undefined) {
        nonconformsByInspection.set(String(nonconform.inspectionId), [nonconform]);
      } else {
        bucket.push(nonconform);
      }
    }
    const windowNonconforms = inWindow.flatMap((order) => nonconformsByInspection.get(String(order.id)) ?? []);
    const openNonconforms = windowNonconforms.filter((nonconform) => nonconform.state !== 'closed');

    const failedQtyTotal = inWindow.reduce((sum, order) => sum + (order.failedQty ?? 0), 0);
    const subject = {
      kind: 'inspection' as const,
      id: `window:${window.from}..${window.to}`,
      label: `${window.label}·质量检验`,
    };
    const timeBasis = { kind: 'range' as const, label: window.label, from: window.from, to: window.to };

    // ---- 卡 1：不合格检验单 ----
    const rowsCapped = capRows(inWindow, context.rowLimit);
    const inspectionCard: AiQueryFactCard = {
      subject,
      title: '不合格检验单',
      metrics: [
        { key: 'failedCount', label: '不合格单数', value: inWindow.length },
        { key: 'failedQty', label: '不合格数量合计', value: failedQtyTotal },
        { key: 'openNonconformCount', label: '未闭环处置', value: openNonconforms.length },
      ],
      rows: rowsOf(
        [
          { key: 'inspectionId', label: '质检单' },
          { key: 'kind', label: '类别' },
          { key: 'itemId', label: '物料' },
          { key: 'failedQty', label: '不合格数量' },
          { key: 'judgedAt', label: '判定时刻' },
        ],
        rowsCapped.values.map((order) => [
          String(order.id),
          inspectionKindLabel(order.kind),
          order.itemId,
          order.failedQty ?? 0,
          order.judgedAt ?? null,
        ]),
      ),
      timeBasis,
      sourceRefs: [{ ref: `inspections:failed:${window.from}..${window.to}`, queryMoment }],
      completeness: completenessOf(rowsCapped.values.length, rowsCapped),
    };

    // ---- 卡 2：不合格处置（返工/让步/报废与闭环状态） ----
    const disposalCapped = capRows(windowNonconforms, context.rowLimit);
    const disposalCard: AiQueryFactCard = {
      subject,
      title: '不合格处置',
      metrics: [
        { key: 'total', label: '处置记录', value: windowNonconforms.length },
        { key: 'open', label: '未闭环', value: openNonconforms.length },
      ],
      rows: rowsOf(
        [
          { key: 'inspectionId', label: '质检单' },
          { key: 'quantity', label: '不合格数量' },
          { key: 'disposal', label: '处置方式' },
          { key: 'state', label: '闭环状态' },
        ],
        disposalCapped.values.map((nonconform) => [
          String(nonconform.inspectionId),
          nonconform.quantity,
          nonconform.disposal === null ? '待处置' : nonconformDisposalLabel(nonconform.disposal),
          nonconformStateLabel(nonconform.state),
        ]),
      ),
      timeBasis,
      sourceRefs: [{ ref: `nonconforms:window:${window.from}..${window.to}`, queryMoment }],
      completeness: completenessOf(disposalCapped.values.length, disposalCapped),
    };

    const summary =
      inWindow.length === 0
        ? `查询有效、无记录：${window.label}内无不合格检验单`
        : `${window.label}：不合格检验单 ${inWindow.length} 张、不合格数量合计 ${failedQtyTotal}，未闭环处置 ${openNonconforms.length} 项`;

    return {
      summary,
      caliberNotes: [INSPECTION_WINDOW_CALIBER_NOTE],
      factCards: [inspectionCard, disposalCard],
    };
  }
}
