/**
 * 运营总览页（T 波 #1，覆盖矩阵 §3.4 #1）：四源聚合——工作台待办、交付态势、
 * 质检汇总、机加工时 → 总览卡片 + 下钻分组。数据走 data/overviewApi 单查询
 * （fetchOverviewView = 四 GET 并行 + product-ui 解析聚合）；聚合口径/坏形状
 * 拒绝都在视图模型层钉死（packages/product-ui overview-views.ts），本页只呈现。
 *
 * 菜单/路由接线归合流（合同 T2）：本文件不自带路由与权限守卫。
 */
import { useQuery } from '@tanstack/react-query';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { QueryState } from '../../components/ModuleTable';
import { fetchOverviewView } from '../../data/overviewApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const RISK_LABELS: Record<string, string> = {
  overdue: '逾期',
  at_risk: '临期',
  on_track: '正常',
};

const RISK_STYLES: Record<string, string> = {
  overdue: 'text-destructive',
  at_risk: 'text-amber-600 dark:text-amber-400',
  on_track: 'text-muted-foreground',
};

function formatDays(days: number | null): string {
  if (days === null) return '—';
  return days < 0 ? `逾期 ${-days} 天` : `${days} 天`;
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function formatStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** 计数小格（卡片内副指标：标签 + 数值）。 */
function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${className ?? ''}`}>{value}</span>
    </div>
  );
}

export function OverviewIndexPage() {
  const overviewQuery = useQuery({ queryKey: ['overview'], queryFn: fetchOverviewView });
  const view = overviewQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>运营总览</CardTitle>
          <CardDescription>
            四源实时聚合：工作台待办 / 交付态势 / 质检汇总 / 机加工时（净额）。
            {view !== undefined && (
              <>
                {' '}交付态势生成于 {formatStamp(view.freshness.delivery)}，质检汇总生成于{' '}
                {formatStamp(view.freshness.inspection)}。
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overviewQuery.isError && <ApiErrorHint error={overviewQuery.error} />}
          <QueryState
            isPending={overviewQuery.isPending}
            error={overviewQuery.isError ? overviewQuery.error : null}
            isEmpty={false}
          >
            {view !== undefined && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>我的待办</CardDescription>
                    <CardTitle className="text-2xl tabular-nums">{view.todo.openTotal}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {view.todo.bySource.length === 0 && '暂无待处理来源'}
                    {view.todo.bySource.map((row) => (
                      <span key={row.source} className="font-mono">
                        {row.source} {row.open}
                      </span>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>交付风险（非终态 {view.delivery.activeOrders} 单）</CardDescription>
                    <CardTitle className="text-2xl tabular-nums text-destructive">
                      {view.delivery.overdue}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex gap-x-5">
                    <Metric label="逾期" value={String(view.delivery.overdue)} className="text-destructive" />
                    <Metric label="临期" value={String(view.delivery.atRisk)} className="text-amber-600 dark:text-amber-400" />
                    <Metric label="正常" value={String(view.delivery.onTrack)} />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>质检态势（待检 {view.inspection.pendingCount}）</CardDescription>
                    <CardTitle className="text-2xl tabular-nums">
                      {formatRate(view.inspection.passRate)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex gap-x-5">
                    <Metric label="待检" value={String(view.inspection.pendingCount)} />
                    <Metric label="未闭环" value={String(view.inspection.nonconformOpenCount)} />
                    <Metric label="闭环超时" value={String(view.inspection.overdueCount)} className={view.inspection.overdueCount > 0 ? 'text-destructive' : undefined} />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>机加工时（净额）</CardDescription>
                    <CardTitle className="text-2xl tabular-nums">{view.machining.totalHours} h</CardTitle>
                  </CardHeader>
                  <CardContent className="flex gap-x-5">
                    <Metric label="净产出" value={String(view.machining.totalOutput)} />
                    <Metric label="工作令" value={String(view.machining.workOrderCount)} />
                    <Metric label="未关联" value={String(view.machining.unassignedCount)} />
                  </CardContent>
                </Card>
              </div>
            )}
          </QueryState>
        </CardContent>
      </Card>

      {view !== undefined && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>交付态势下钻</CardTitle>
              <CardDescription>非终态工作令按风险分组（组内按交付倒计时升序）；九态分布为全量口径（含终态，零填充）。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(view.stateDistribution).map(([state, count]) => (
                  <span
                    key={state}
                    className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                      count === 0 ? 'text-muted-foreground/60' : 'bg-muted text-foreground'
                    }`}
                  >
                    {state} {count}
                  </span>
                ))}
              </div>
              {view.riskGroups.length === 0 && (
                <p className="text-sm text-muted-foreground">无非终态工作令。</p>
              )}
              {view.riskGroups.map((group) => (
                <div key={group.riskLevel} className="flex flex-col gap-2">
                  <p className={`text-sm font-medium ${RISK_STYLES[group.riskLevel] ?? ''}`}>
                    {RISK_LABELS[group.riskLevel] ?? group.riskLevel}（{group.orders.length}）
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-4 font-medium">工作令</th>
                          <th className="py-2 pr-4 font-medium">项目</th>
                          <th className="py-2 pr-4 font-medium">状态</th>
                          <th className="py-2 pr-4 font-medium">计划交付</th>
                          <th className="py-2 pr-4 font-medium">倒计时</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.orders.map((order) => (
                          <tr key={order.workOrderId} className="border-b last:border-b-0">
                            <td className="py-2 pr-4 font-mono text-xs">{order.workOrderId}</td>
                            <td className="py-2 pr-4">{order.projectName}</td>
                            <td className="py-2 pr-4 font-mono text-xs">{order.state}</td>
                            <td className="py-2 pr-4 text-xs">
                              {order.plannedDeliveryAt === null ? '—' : order.plannedDeliveryAt.slice(0, 10)}
                            </td>
                            <td
                              className={`py-2 pr-4 tabular-nums ${
                                order.riskLevel === 'overdue' ? 'text-destructive' : ''
                              }`}
                            >
                              {formatDays(order.daysToDelivery)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>质检四类下钻</CardTitle>
                <CardDescription>每类待检 / 已判 / 合格率 / 未闭环（合格率 = 合格 ÷ 已判，无判定显示 —）。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">类别</th>
                        <th className="py-2 pr-4 font-medium">待检</th>
                        <th className="py-2 pr-4 font-medium">合格</th>
                        <th className="py-2 pr-4 font-medium">不合格</th>
                        <th className="py-2 pr-4 font-medium">已闭环</th>
                        <th className="py-2 pr-4 font-medium">合格率</th>
                        <th className="py-2 font-medium">未闭环</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.inspectionByKind.map((row) => (
                        <tr key={row.kind} className="border-b last:border-b-0">
                          <td className="py-2 pr-4 font-mono text-xs">{row.kind}</td>
                          <td className="py-2 pr-4 tabular-nums">{row.pending}</td>
                          <td className="py-2 pr-4 tabular-nums">{row.passed}</td>
                          <td className="py-2 pr-4 tabular-nums">{row.failed}</td>
                          <td className="py-2 pr-4 tabular-nums">{row.closed}</td>
                          <td className="py-2 pr-4 tabular-nums">{formatRate(row.passRate)}</td>
                          <td className="py-2 tabular-nums">{row.nonconformOpen}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>机加工时下钻</CardTitle>
                <CardDescription>机加工种净额按工作令分组（净工时降序，未关联工作令行置底；— = 未关联）。</CardDescription>
              </CardHeader>
              <CardContent>
                {view.machiningGroups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无机加工时事实。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-4 font-medium">工作令</th>
                          <th className="py-2 pr-4 font-medium">图号</th>
                          <th className="py-2 pr-4 font-medium">净工时 (h)</th>
                          <th className="py-2 font-medium">净产出</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.machiningGroups.map((row, index) => (
                          <tr
                            key={row.workOrderId ?? `unassigned-${index}`}
                            className="border-b last:border-b-0"
                          >
                            <td className="py-2 pr-4 font-mono text-xs">
                              {row.workOrderId ?? '—'}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">{row.drawingNo ?? '—'}</td>
                            <td className="py-2 pr-4 tabular-nums">{row.totalHours}</td>
                            <td className="py-2 tabular-nums">{row.totalOutput}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
