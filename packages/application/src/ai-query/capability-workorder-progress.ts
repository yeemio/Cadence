/**
 * 能力 workorder-progress：工作令三类进度 + 未完成任务清单（只读）。
 *
 * 取数：主体工作令（服务层已解析）+ ProgressFactPort 进度事实；上卷复用
 * workorder/workorder-progress.ts 纯函数（机加工按图号×工序、装配按工序）——
 * 与业务页面同一口径。summary 仅由结构化事实模板拼接。
 */
import type { ProgressFactPort } from '../workorder/workorder-ports.js';
import {
  daysToDelivery,
  rollupAssemblyProgress,
  rollupMachiningProgress,
} from '../workorder/workorder-progress.js';
import { workOrderStateLabel } from '../workorder/workorder-config.js';
import type { WorkOrder } from '../workorder/workorder-stores.js';
import type { AiQueryFactCard, AiQueryFactCardRows, AiQueryCompleteness } from './ai-query-ports.js';
import {
  DELIVERY_COUNTDOWN_CALIBER_NOTE,
  DONE_QTY_CALIBER_NOTE,
  capRows,
  type AiQueryCapabilityContext,
  type AiQueryCapabilityResult,
} from './ai-query.capabilities.js';

/** 行状态中文名（pending/in_progress/done → 展示词；ADR-0010 通用词汇）。 */
const ROW_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '未开始',
  in_progress: '进行中',
  done: '已完成',
};

function rowsOf(columns: AiQueryFactCardRows['columns'], values: readonly (string | number | null)[][]): AiQueryFactCardRows {
  return { columns, values };
}

function completenessOf(shown: number, capped: { truncated: boolean; total: number }): AiQueryCompleteness {
  return capped.truncated
    ? { status: 'truncated', rowCount: shown, totalKnown: true, note: `共 ${capped.total} 行，展示前 ${shown} 行` }
    : { status: 'complete', rowCount: shown, totalKnown: true };
}

export class WorkOrderProgressCapability {
  constructor(private readonly progressFacts: ProgressFactPort) {}

  async execute(context: AiQueryCapabilityContext & { readonly subjectOrder: WorkOrder }): Promise<AiQueryCapabilityResult> {
    const order = context.subjectOrder;
    const queryMoment = context.queryMoment;
    const facts = await this.progressFacts.progressFacts(context.tenant, order.id);
    const machining = rollupMachiningProgress(facts);
    const assembly = rollupAssemblyProgress(facts);

    // ---- 卡 1：项目进度（计划 vs 当前态；纯指标卡 rowCount=0） ----
    const countdown = daysToDelivery(order.plannedDeliveryAt, queryMoment);
    const projectCard: AiQueryFactCard = {
      subject: { kind: 'workorder', id: order.id, label: order.projectName || String(order.id) },
      title: '项目进度',
      metrics: [
        { key: 'state', label: '当前状态', value: workOrderStateLabel(order.state) },
        {
          key: 'plannedDeliveryAt',
          label: '计划交付',
          value: order.plannedDeliveryAt ?? '未设定',
        },
        { key: 'daysToDelivery', label: '交付倒计时', value: countdown === null ? '未设定' : countdown, unit: '天' },
      ],
      timeBasis: { kind: 'point', label: '查询时刻' },
      sourceRefs: [
        { ref: `workorder:${String(order.id)}`, queryMoment },
        { ref: `progress-facts:${String(order.id)}`, queryMoment },
      ],
      completeness: { status: 'complete', rowCount: 0, totalKnown: true },
    };

    // ---- 卡 2/3：机加工（图号×工序）/ 装配调试（工序）上卷行表 ----
    const machiningCapped = capRows(machining, context.rowLimit);
    const machiningCard: AiQueryFactCard = {
      subject: projectCard.subject,
      title: '机加工进度',
      metrics: [
        {
          key: 'doneRows',
          label: '已完成行',
          value: machining.filter((row) => row.status === 'done').length,
        },
        { key: 'totalRows', label: '总行数', value: machining.length },
      ],
      rows: rowsOf(
        [
          { key: 'drawingNo', label: '图号' },
          { key: 'operationId', label: '工序' },
          { key: 'doneQty', label: '完成数量' },
          { key: 'totalQty', label: '总数量' },
          { key: 'status', label: '状态' },
        ],
        machiningCapped.values.map((row) => [
          row.drawingNo,
          row.operationId,
          row.doneQty,
          row.totalQty,
          ROW_STATUS_LABELS[row.status] ?? row.status,
        ]),
      ),
      timeBasis: { kind: 'point', label: '查询时刻' },
      sourceRefs: [{ ref: `progress-facts:${String(order.id)}`, queryMoment }],
      completeness: completenessOf(machiningCapped.values.length, machiningCapped),
    };

    const assemblyCapped = capRows(assembly, context.rowLimit);
    const assemblyCard: AiQueryFactCard = {
      subject: projectCard.subject,
      title: '装配调试进度',
      metrics: [
        { key: 'doneRows', label: '已完成行', value: assembly.filter((row) => row.status === 'done').length },
        { key: 'totalRows', label: '总行数', value: assembly.length },
      ],
      rows: rowsOf(
        [
          { key: 'operationId', label: '工序' },
          { key: 'doneQty', label: '完成数量' },
          { key: 'totalQty', label: '总数量' },
          { key: 'status', label: '状态' },
        ],
        assemblyCapped.values.map((row) => [
          row.operationId,
          row.doneQty,
          row.totalQty,
          ROW_STATUS_LABELS[row.status] ?? row.status,
        ]),
      ),
      timeBasis: { kind: 'point', label: '查询时刻' },
      sourceRefs: [{ ref: `progress-facts:${String(order.id)}`, queryMoment }],
      completeness: completenessOf(assemblyCapped.values.length, assemblyCapped),
    };

    // ---- 卡 4：未完成任务清单（两阶段上卷行 status != done；剩余 = 总数-完成） ----
    const unfinished = [
      ...machining
        .filter((row) => row.status !== 'done')
        .map((row) => ['机加工', row.drawingNo, row.operationId, row.totalQty - row.doneQty] as (string | number | null)[]),
      ...assembly
        .filter((row) => row.status !== 'done')
        .map((row) => ['装配调试', null, row.operationId, row.totalQty - row.doneQty] as (string | number | null)[]),
    ];
    const unfinishedCapped = capRows(unfinished, context.rowLimit);
    const unfinishedCard: AiQueryFactCard = {
      subject: projectCard.subject,
      title: '未完成任务',
      metrics: [{ key: 'unfinishedCount', label: '未完成任务数', value: unfinished.length }],
      rows: rowsOf(
        [
          { key: 'stage', label: '阶段' },
          { key: 'drawingNo', label: '图号' },
          { key: 'operationId', label: '工序' },
          { key: 'remainingQty', label: '剩余数量' },
        ],
        unfinishedCapped.values,
      ),
      timeBasis: { kind: 'point', label: '查询时刻' },
      sourceRefs: [{ ref: `progress-facts:${String(order.id)}`, queryMoment }],
      completeness: completenessOf(unfinishedCapped.values.length, unfinishedCapped),
    };

    const machiningDone = machining.filter((row) => row.status === 'done').length;
    const assemblyDone = assembly.filter((row) => row.status === 'done').length;
    const summary =
      machining.length === 0 && assembly.length === 0
        ? '查询有效、无记录：该工作令暂无进度事实（无派工/报工上卷数据）'
        : `工作令「${order.projectName}」当前${workOrderStateLabel(order.state)}：机加工 ${machiningDone}/${machining.length} 行完成，装配调试 ${assemblyDone}/${assembly.length} 行完成，未完成任务 ${unfinished.length} 项`;
    const caliberNotes = [
      DONE_QTY_CALIBER_NOTE,
      ...(countdown === null ? [] : [DELIVERY_COUNTDOWN_CALIBER_NOTE]),
    ];

    return { summary, caliberNotes, factCards: [projectCard, machiningCard, assemblyCard, unfinishedCard] };
  }
}
