/**
 * AI 问数——answer 态事实卡渲染（CONTRACT v1 §Web）。
 *
 * 每张 FactCard：标题＋主体 → 指标组（label+value+unit）→ 行表（columns/values）
 * → 完整性徽标（complete/truncated 如实）→ 来源引用（ref+取数时刻）→ 详情
 * 跳转（前端路由表负责拼 URL，服务端只回 subject；链接按当前会话权限码条件
 * 渲染，先例 WorkOrdersPage M2-R1 入口门禁）。口径注记（caliberNotes）在
 * answer 级（合同 §Wire），随 summary 渲染——明显可辨，不静默吞掉。
 *
 * 零行纪律：rows 空不渲染成业务零值——明示「无记录行（查询有效、无记录）」；
 * 截断（totalKnown=false）不总结为全量，徽标与 note 原样呈现。
 */
import { useNavigate } from 'react-router';
import { ExternalLink } from 'lucide-react';
import type { AiQueryAnswer, AiQueryFactCard, AiQueryFactCardSubject } from '../../data/aiQueryApi';
import { formatLocalDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** 主体类别 → 详情跳转文案（路由拼装在页面层门禁后传入）。 */
const SUBJECT_DETAIL_LABELS: Readonly<Record<AiQueryFactCardSubject['kind'], string>> = {
  workorder: '查看工作令',
  material: '查看缺口核查',
  inspection: '查看质检队列',
};

/** 完整性徽标：complete=完整行数；truncated=如实标截断（note/总量不吞）。 */
function CompletenessBadge({ card }: { readonly card: AiQueryFactCard }) {
  const { completeness } = card;
  if (completeness.status === 'complete') {
    return (
      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
        完整 · {completeness.rowCount} 行
      </span>
    );
  }
  return (
    <span
      role="note"
      className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
    >
      已截断 · 展示 {completeness.rowCount} 行
      {completeness.totalKnown ? '' : '（总量未知）'}
      {completeness.note !== undefined && completeness.note.length > 0 ? ` · ${completeness.note}` : ''}
    </span>
  );
}

/** 指标组：label + value + unit（数字/文本值直出，不换算不总结）。 */
function MetricList({ card }: { readonly card: AiQueryFactCard }) {
  if (card.metrics.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
      {card.metrics.map((metric) => (
        <div key={metric.key} className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{metric.label}</dt>
          <dd className="font-mono text-sm break-all">
            {metric.value}
            {metric.unit !== undefined && metric.unit.length > 0 ? (
              <span className="ml-0.5 text-xs text-muted-foreground">{metric.unit}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 行表：columns 列头 + values 行（空 = 无记录行，不显示为业务零值）。 */
function RowsTable({ card }: { readonly card: AiQueryFactCard }) {
  const rows = card.rows;
  if (rows === undefined) return null;
  if (rows.values.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        无记录行（查询有效、无记录——不是业务零值）
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {rows.columns.map((column) => (
              <th key={column.key} className="py-2 pr-4 font-medium whitespace-nowrap">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.values.map((values, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-b-0">
              {values.map((value, columnIndex) => (
                <td key={columnIndex} className="py-2 pr-4 whitespace-nowrap">
                  {value === null ? '—' : value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 单张事实卡（列表页消费的零散结构组合，无卡片嵌套幻觉）。 */
function FactCardView({
  card,
  detailHref,
}: {
  readonly card: AiQueryFactCard;
  readonly detailHref: (subject: AiQueryFactCardSubject) => string | null;
}) {
  const navigate = useNavigate();
  const href = detailHref(card.subject);
  const timeWindow =
    card.timeBasis.from !== undefined || card.timeBasis.to !== undefined
      ? `${card.timeBasis.from ?? '…'} ~ ${card.timeBasis.to ?? '…'}`
      : null;
  return (
    <Card>
      <CardHeader className="gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{card.title}</CardTitle>
          <CompletenessBadge card={card} />
        </div>
        <p className="text-xs text-muted-foreground">
          主体：{card.subject.label}
          <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5" title={timeWindow ?? undefined}>
            时间口径：{card.timeBasis.label}
          </span>
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <MetricList card={card} />
        <RowsTable card={card} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xs break-all text-muted-foreground">
            {card.sourceRefs.map((ref, index) => (
              <span key={index} className="mr-3 inline-block">
                来源 {ref.ref} · 取数 {formatLocalDateTime(ref.queryMoment)}
              </span>
            ))}
          </p>
          {href !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(href)}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {SUBJECT_DETAIL_LABELS[card.subject.kind]}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * answer 态整块渲染：summary（服务端模板拼接的结构化事实概述，置于最前）
 * → 零行总判（全卡零行时明示查询有效）→ 事实卡组。
 */
export function AnswerView({
  answer,
  detailHref,
}: {
  readonly answer: AiQueryAnswer;
  readonly detailHref: (subject: AiQueryFactCardSubject) => string | null;
}) {
  const allEmpty =
    answer.factCards.length === 0 ||
    answer.factCards.every((card) => card.completeness.rowCount === 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed">{answer.summary}</p>
      {answer.caliberNotes.length > 0 && (
        <div className="rounded-md border-l-2 border-amber-500/60 bg-amber-500/5 px-3 py-2" role="note">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">口径注记</p>
          <ul className="mt-1 list-disc pl-4 text-xs leading-relaxed text-muted-foreground">
            {answer.caliberNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {allEmpty && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          查询有效、无记录——以上为口径说明，未产生业务数值。
        </p>
      )}
      {answer.factCards.map((card, index) => (
        <FactCardView key={`${card.subject.kind}-${card.subject.id}-${index}`} card={card} detailHref={detailHref} />
      ))}
    </div>
  );
}
