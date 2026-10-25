/**
 * 标准报表页（S3-a：0920 #89/#91/#92/#96）：口径四选一 + 时间窗 → 求值结果表格。
 *
 * 列生成取舍（写明，依赖检查结论）：
 *  - web 不得 import 后端口径包（depcruise web-via-ui 铁律）；
 *  - POST /standard-reports/query 响应（engine-reporting MetricResult）**自带**
 *    口径溯源 metric{metricId,version} + dimensionFields + measureIds + rows
 *    [{key, values}]——列结构按响应实态动态生成，包版本演进加维度/度量不破页面；
 *  - 仅列头中文标签是页面内静态副本（与 STANDARD_REPORTS_PACK v1 对齐；
 *    未知 id 回退原样显示）。#96 的月/年汇总属呈现层聚合——本波按日报行
 *    原样呈现，聚合控件留后续波（口径包 description 如实标注）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  listStandardReportMetrics,
  queryStandardReport,
} from '../../data/standardReportsApi';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 维度字段 → 列头（STANDARD_REPORTS_PACK v1 静态副本；未知回退原 id）。 */
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  itemId: '物料',
  workOrderId: '工作令',
  drawingNo: '图号',
  operationCode: '工序',
  periodDay: '日期',
};

/** 度量 id → 列头（同上静态副本）。 */
const MEASURE_LABELS: Readonly<Record<string, string>> = {
  'received-qty': '收入量',
  'issued-qty': '发出量',
  'net-qty': '净额',
  'movement-count': '流水笔数',
  'machining-hours': '机加工时(h)',
  'assembly-hours': '装配工时(h)',
  'electrical-hours': '电气工时(h)',
  'aftercare-hours': '售后工时(h)',
  'total-hours': '合计工时(h)',
  'entry-count': '条目数',
  'dispatched-qty': '已派数量',
  'reported-qty': '已报数量',
  'order-count': '派工单数',
  'work-order-count': '工作令数',
};

function dimensionLabel(field: string): string {
  return DIMENSION_LABELS[field] ?? field;
}

function measureLabel(measureId: string): string {
  return MEASURE_LABELS[measureId] ?? measureId;
}

/** datetime-local 值 → ISO 时刻（空串 = 无界）。 */
function toIsoOrNull(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function StandardReportsPage() {
  const catalogQuery = useQuery({
    queryKey: ['standard-reports', 'metrics'],
    queryFn: listStandardReportMetrics,
  });
  const catalog = catalogQuery.data;

  const [metricId, setMetricId] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [applied, setApplied] = useState<{ readonly metricId: string; from?: string; to?: string } | null>(null);

  const selectedMetric = catalog?.metrics.find((entry) => entry.metricId === metricId) ?? catalog?.metrics[0];

  const resultQuery = useQuery({
    queryKey: ['standard-reports', 'query', applied],
    queryFn: () => queryStandardReport(applied as { metricId: string }),
    enabled: applied !== null,
  });
  const result = resultQuery.data;

  function handleQuery(): void {
    const effective = metricId === '' && selectedMetric !== undefined ? selectedMetric.metricId : metricId;
    if (effective.length === 0) return;
    const from = toIsoOrNull(draftFrom);
    const to = toIsoOrNull(draftTo);
    const next: { metricId: string; from?: string; to?: string } = { metricId: effective };
    if (from !== undefined) next.from = from;
    if (to !== undefined) next.to = to;
    setApplied(next);
  }

  const resultRowIdKey =
    result !== undefined && result.dimensionFields.length > 0 ? result.dimensionFields[0] : undefined;
  const columns = result
    ? [
        ...result.dimensionFields.map((field) => ({ key: field, label: dimensionLabel(field), mono: true })),
        ...result.measureIds.map((measureId) => ({ key: measureId, label: measureLabel(measureId) })),
      ]
    : [];
  const tableRows =
    result?.rows.map((row) => ({ ...row.key, ...row.values } as Record<string, unknown>)) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>标准报表</CardTitle>
          <CardDescription>
            版本化口径包求值（packId standard-reports）：口径引用 + 时间窗，四张 P3 标准报表四选一；
            列结构按求值响应自描述生成（口径溯源见结果脚注）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
            <div className="flex flex-col gap-2 lg:col-span-2">
              <Label htmlFor="sr-metric">报表口径</Label>
              <Select
                id="sr-metric"
                value={metricId === '' && selectedMetric !== undefined ? selectedMetric.metricId : metricId}
                onChange={(e) => setMetricId(e.target.value)}
              >
                {(catalog?.metrics ?? []).map((entry) => (
                  <option key={entry.metricId} value={entry.metricId}>
                    {entry.display}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sr-from">窗口起（含，可选）</Label>
              <Input id="sr-from" type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sr-to">窗口止（含，可选）</Label>
              <Input id="sr-to" type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
            </div>
          </div>
          <div className="flex items-end gap-3">
            <Button variant="outline" onClick={handleQuery} disabled={catalogQuery.isPending || selectedMetric === undefined}>
              求值报表
            </Button>
            {catalogQuery.isError && (
              <p role="alert" className="text-sm text-destructive">
                口径清单加载失败：{catalogQuery.error instanceof Error ? catalogQuery.error.message : String(catalogQuery.error)}
              </p>
            )}
          </div>
          {selectedMetric?.description != null && (
            <p className="max-w-4xl text-xs leading-relaxed text-muted-foreground">
              口径说明（含降级标注）：{selectedMetric.description}
            </p>
          )}
        </CardContent>
      </Card>

      {applied !== null && (
        <Card>
          <CardHeader>
            <CardTitle>求值结果</CardTitle>
            <CardDescription>
              {result !== undefined
                ? `${result.metricId}@v${result.metricVersion} · timeBasis=${result.timeBasis} · 窗口 ${
                    result.window.from ?? '无界'
                  } ~ ${result.window.to ?? '无界'} · ${result.rows.length} 组`
                : '求值中…'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QueryState
              isPending={resultQuery.isPending}
              error={resultQuery.isError ? resultQuery.error : null}
              isEmpty={result !== undefined && result.rows.length === 0}
              empty="窗口内无符合口径的事实行（空集亦口径结果——见口径说明）"
            >
              <ModuleTable
                columns={columns}
                rows={tableRows}
                {...(resultRowIdKey !== undefined ? { rowIdKey: resultRowIdKey } : {})}
              />
            </QueryState>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
