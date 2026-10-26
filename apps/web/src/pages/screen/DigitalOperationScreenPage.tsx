/**
 * 数字运营大屏页（A8 首波，PRD 20 册 RREQ-RP-023~026 呈现块；6a-3 裁决 3：
 * web 大屏页补建）。
 *
 * == 路由与菜单取舍（写明） ==
 * 独立路由 /bigscreen/digital-operation（O-1 修复：旧 /screen/digital-operation
 * 与后端 API 同路径，直接打开/刷新被 nginx 反代打到后端回 401 JSON——前缀
 * 取舍见 screenRoutes.ts 文件头），**不进业务菜单**：墙挂展示页按 1920x1080
 * 全屏呈现（等比缩放），进 ShellLayout 侧栏壳会破坏全屏形态；且大屏是展示面
 * 不是业务操作面，混入业务菜单组（报工管理/标准报表）会误导日常操作动线。
 * main.tsx 路由表注册于 ShellLayout 外（同移动路由组 /m/* 先例——独立导航面）。
 *
 * == 数据通道取舍（写明） ==
 * SSE 订阅 ?token= 形态（screenApi.ts 头注）：服务端通道为 EventSource 设计
 * （无 header → token 查询参），5s 节拍推帧；首帧用登录会话 fetch 快照即取
 * （Bearer 自动注入），SSE 接管后续帧。token 轮换后 onerror 重连重读存储。
 *
 * == 占位呈现（PRD §4.5 可辨识纪律） ==
 * pendingFields：definition（口径待定）→ 值照常显示 + 「待定」角标；source
 * （数据源待接）→ 「—」+ 「待接」角标。页脚图例常驻说明两种标记。
 */
import { useEffect, useRef, useState } from 'react';
import {
  fetchScreenSnapshot,
  parseScreenEnvelope,
  readScreenToken,
  screenStreamUrl,
  type ScreenDispatchRowView,
  type ScreenEnvelopeView,
} from './screenApi';
import {
  computeScale,
  displayNumber,
  displayProgress,
  displayRate,
  displayRemainingDays,
  displayScore,
  displayStoredTotal,
  pendingBadgeText,
  pendingMarker,
  riskLabel,
  SCREEN_DESIGN_HEIGHT,
  SCREEN_DESIGN_WIDTH,
} from './screenFrame';

/** SSE 通道状态（页头指示灯）。 */
type StreamStatus = 'connecting' | 'live' | 'unauthorized' | 'error';

/** 帧到达回调经 ref 透传——SSE effect 不因每帧渲染重建连接。 */
function useScreenStream(onFrame: (envelope: ScreenEnvelopeView) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = (): void => {
      const token = readScreenToken();
      if (token === null) {
        setStatus('unauthorized');
        return;
      }
      setStatus('connecting');
      source = new EventSource(screenStreamUrl(token));
      source.onopen = () => {
        if (!disposed) setStatus('live');
      };
      source.onmessage = (event: MessageEvent) => {
        try {
          frameRef.current(parseScreenEnvelope(JSON.parse(event.data as string)));
        } catch {
          // 帧形状漂移 → 保持上一好帧（大屏是呈现面，冻结优于断流）
        }
      };
      source.onerror = () => {
        source?.close();
        if (disposed) return;
        setStatus('error');
        // 重连时重读 token（会话保活轮换后旧 URL token 失效；无 token 转 unauthorized）
        reconnectTimer = window.setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, []);

  return status;
}

/** 1080p 等比缩放：视口尺寸 → scale（resize 监听，rAF 批量避免抖动）。 */
function useViewportScale(): number {
  const [scale, setScale] = useState(() =>
    computeScale(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    const onResize = (): void => {
      setScale(computeScale(window.innerWidth, window.innerHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return scale;
}

/** 页头时钟（秒级）。 */
function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now.toLocaleString('zh-CN', { hour12: false });
}

// ---- 小件 ----

/** 占位角标（待定/待接）。 */
function Badge({ kind }: { kind: 'definition' | 'source' }) {
  return (
    <sup className="ml-1 rounded-sm border border-amber-500/60 px-1 text-[10px] leading-tight text-amber-300">
      {pendingBadgeText(kind)}
    </sup>
  );
}

/** 面板容器。 */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <h2 className="mb-2 shrink-0 text-base font-semibold tracking-wide text-cyan-300">{title}</h2>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}

/** 数值格：null → '—'；带占位角标。 */
function Metric({
  value,
  pending,
  path,
  format = displayNumber,
}: {
  value: number | null;
  pending: Readonly<Record<string, 'definition' | 'source'>>;
  path: string;
  format?: (value: number | null) => string;
}) {
  const marker = pendingMarker(pending, path);
  return (
    <span className="whitespace-nowrap">
      {format(value)}
      {marker !== null && <Badge kind={marker} />}
    </span>
  );
}

const LED_CLASS: Record<ScreenDispatchRowView['led'], string> = {
  off: 'bg-slate-500',
  info: 'bg-sky-400',
  warn: 'bg-amber-400',
  ok: 'bg-emerald-400',
};

/** 派工行（机加/外协/装配明细共用）。 */
function DispatchRowView({ row, withVendor }: { row: ScreenDispatchRowView; withVendor?: boolean }) {
  return (
    <tr className="border-b border-slate-800/60">
      <td className="truncate py-1 pr-2 text-slate-200">{row.orderNo}</td>
      <td className="max-w-24 truncate py-1 pr-2 text-slate-300">{withVendor ? row.vendor ?? '—' : row.opName ?? '—'}</td>
      <td className="py-1 pr-2 text-slate-200">{row.progress}%</td>
      <td className="py-1 pr-2 text-slate-300">{row.status}</td>
      <td className="py-1">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${LED_CLASS[row.led]}`} />
      </td>
    </tr>
  );
}

/** 近 12 天产出折线（SVG polyline；null 整列 → 待接覆盖层）。 */
function DailyOutputChart({
  points,
  pending,
}: {
  points: readonly { dayLabel: string; date: string; quantity: number | null }[];
  pending: Readonly<Record<string, 'definition' | 'source'>>;
}) {
  const width = 560;
  const height = 200;
  const marker = pendingMarker(pending, 'dailyProductionOutputByWorkReport');
  if (points.length === 0) {
    return <div className="flex h-full items-center justify-center text-slate-500">暂无数据</div>;
  }
  const values = points.map((point) => point.quantity);
  const known = values.filter((value): value is number => value !== null);
  const max = Math.max(1, ...known);
  const stepX = width / Math.max(1, points.length - 1);
  const yOf = (value: number): number => height - 16 - (value / max) * (height - 40);
  const polyline = points
    .map((point, index) =>
      point.quantity === null ? null : `${index * stepX},${yOf(point.quantity)}`,
    )
    .filter((token): token is string => token !== null)
    .join(' ');
  return (
    <div className="relative h-full">
      {marker !== null && (
        <span className="absolute right-1 top-1 z-10">
          <Badge kind={marker} />
        </span>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none">
        <polyline
          points={polyline}
          fill="none"
          stroke="rgb(34 211 238)"
          strokeWidth="2.5"
        />
        {points.map((point, index) =>
          point.quantity === null ? null : (
            <circle key={point.date} cx={index * stepX} cy={yOf(point.quantity)} r="3" fill="rgb(34 211 238)" />
          ),
        )}
      </svg>
      <div className="flex justify-between px-1 text-[10px] text-slate-500">
        {points.map((point, index) => (
          <span key={point.date} className={index % 2 === 0 ? '' : 'opacity-0'}>
            {point.dayLabel}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 当日 13 整点双柱（在制去重 / 小时合格）。 */
function HourlyOutputChart({
  points,
  pending,
}: {
  points: readonly {
    hourLabel: string;
    wipDrawingDistinctCount: number | null;
    qualifiedQuantity: number | null;
  }[];
  pending: Readonly<Record<string, 'definition' | 'source'>>;
}) {
  const width = 460;
  const height = 200;
  if (points.length === 0) {
    return <div className="flex h-full items-center justify-center text-slate-500">暂无数据</div>;
  }
  const known = points.flatMap((point) =>
    [point.wipDrawingDistinctCount, point.qualifiedQuantity].filter(
      (value): value is number => value !== null,
    ),
  );
  const max = Math.max(1, ...known);
  const slot = width / points.length;
  const barWidth = slot / 3;
  const yOf = (value: number): number => height - 16 - (value / max) * (height - 40);
  return (
    <div className="relative h-full">
      <span className="absolute right-1 top-1 z-10 flex gap-1">
        {pendingMarker(pending, 'hourlyOutputWipPoints.wipDrawingDistinctCount') !== null && (
          <Badge kind={pendingMarker(pending, 'hourlyOutputWipPoints.wipDrawingDistinctCount')!} />
        )}
        {pendingMarker(pending, 'hourlyOutputWipPoints.qualifiedQuantity') !== null && (
          <Badge kind={pendingMarker(pending, 'hourlyOutputWipPoints.qualifiedQuantity')!} />
        )}
      </span>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none">
        {points.map((point, index) => {
          const baseX = index * slot + slot / 2;
          const wip = point.wipDrawingDistinctCount;
          const qualified = point.qualifiedQuantity;
          return (
            <g key={point.hourLabel}>
              {wip !== null && (
                <rect
                  x={baseX - barWidth - 1}
                  y={yOf(wip)}
                  width={barWidth}
                  height={height - 16 - yOf(wip)}
                  fill="rgb(56 189 248)"
                  rx="1.5"
                />
              )}
              {qualified !== null && (
                <rect
                  x={baseX + 1}
                  y={yOf(qualified)}
                  width={barWidth}
                  height={height - 16 - yOf(qualified)}
                  fill="rgb(52 211 153)"
                  rx="1.5"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between px-1 text-[10px] text-slate-500">
        {points.map((point, index) => (
          <span key={point.hourLabel} className={index % 2 === 0 ? '' : 'opacity-0'}>
            {point.hourLabel.slice(0, 2)}
          </span>
        ))}
      </div>
      <div className="absolute bottom-5 left-2 flex gap-3 text-[10px]">
        <span className="flex items-center gap-1 text-sky-300">
          <span className="inline-block h-2 w-2 bg-sky-400" />
          在制图号
        </span>
        <span className="flex items-center gap-1 text-emerald-300">
          <span className="inline-block h-2 w-2 bg-emerald-400" />
          小时合格
        </span>
      </div>
    </div>
  );
}

/** 当日 13 整点：待检柱 + 累计合格折线（待入库恒占位）。 */
function HourlyInboundChart({
  points,
  pending,
}: {
  points: readonly {
    hourLabel: string;
    pendingStorageQuantity: number | null;
    pendingInspectionQuantity: number | null;
    cumulativeQualifiedInspectionQuantity: number | null;
  }[];
  pending: Readonly<Record<string, 'definition' | 'source'>>;
}) {
  const width = 460;
  const height = 200;
  if (points.length === 0) {
    return <div className="flex h-full items-center justify-center text-slate-500">暂无数据</div>;
  }
  const known = points.flatMap((point) =>
    [
      point.pendingStorageQuantity,
      point.pendingInspectionQuantity,
      point.cumulativeQualifiedInspectionQuantity,
    ].filter((value): value is number => value !== null),
  );
  const max = Math.max(1, ...known);
  const slot = width / points.length;
  const yOf = (value: number): number => height - 16 - (value / max) * (height - 40);
  const polyline = points
    .map((point, index) =>
      point.cumulativeQualifiedInspectionQuantity === null
        ? null
        : `${index * slot + slot / 2},${yOf(point.cumulativeQualifiedInspectionQuantity)}`,
    )
    .filter((token): token is string => token !== null)
    .join(' ');
  return (
    <div className="relative h-full">
      <span className="absolute right-1 top-1 z-10">
        <Badge kind={pendingMarker(pending, 'hourlyInboundInspectionPoints.pendingStorageQuantity') ?? 'source'} />
      </span>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none">
        {points.map((point, index) => {
          const baseX = index * slot + slot / 2;
          const storage = point.pendingStorageQuantity;
          const inspection = point.pendingInspectionQuantity;
          return (
            <g key={point.hourLabel}>
              {storage !== null && (
                <rect
                  x={baseX - 7}
                  y={yOf(storage)}
                  width="6"
                  height={height - 16 - yOf(storage)}
                  fill="rgb(148 163 184)"
                  rx="1.5"
                />
              )}
              {inspection !== null && (
                <rect
                  x={baseX + 1}
                  y={yOf(inspection)}
                  width="6"
                  height={height - 16 - yOf(inspection)}
                  fill="rgb(251 191 36)"
                  rx="1.5"
                />
              )}
            </g>
          );
        })}
        <polyline points={polyline} fill="none" stroke="rgb(96 165 250)" strokeWidth="2" />
      </svg>
      <div className="flex justify-between px-1 text-[10px] text-slate-500">
        {points.map((point, index) => (
          <span key={point.hourLabel} className={index % 2 === 0 ? '' : 'opacity-0'}>
            {point.hourLabel.slice(0, 2)}
          </span>
        ))}
      </div>
      <div className="absolute bottom-5 left-2 flex gap-3 text-[10px]">
        <span className="flex items-center gap-1 text-amber-300">
          <span className="inline-block h-2 w-2 bg-amber-400" />
          待检
        </span>
        <span className="flex items-center gap-1 text-slate-400">
          <span className="inline-block h-2 w-2 bg-slate-400" />
          待入库
        </span>
        <span className="flex items-center gap-1 text-blue-300">
          <span className="inline-block h-0.5 w-3 bg-blue-400" />
          累计合格
        </span>
      </div>
    </div>
  );
}

/** KPI 卡。 */
function KpiCard({
  label,
  value,
  pending,
  path,
  format = displayNumber,
}: {
  label: string;
  value: number | null;
  pending: Readonly<Record<string, 'definition' | 'source'>>;
  path: string;
  format?: (value: number | null) => string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 px-2 py-3">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="mt-1 text-3xl font-bold text-slate-50">
        <Metric value={value} pending={pending} path={path} format={format} />
      </div>
    </div>
  );
}

// ---- 页面 ----

export function DigitalOperationScreenPage() {
  const [frame, setFrame] = useState<ScreenEnvelopeView | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const scale = useViewportScale();
  const clock = useClock();
  const streamStatus = useScreenStream(setFrame);

  // 首帧即取（不等 SSE 节拍）；失败不炸页面（SSE 仍可能带帧到来）。
  useEffect(() => {
    let cancelled = false;
    fetchScreenSnapshot()
      .then((envelope) => {
        if (!cancelled) setFrame(envelope);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSnapshotError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const payload = frame?.payload;
  const pending = payload?.pendingFields ?? {};
  const statusText: Record<StreamStatus, string> = {
    connecting: '连接中',
    live: '实时推送',
    unauthorized: '未登录',
    error: '重连中',
  };
  const statusColor =
    streamStatus === 'live'
      ? 'bg-emerald-400'
      : streamStatus === 'connecting'
        ? 'bg-amber-400'
        : 'bg-rose-400';

  return (
    <div className="h-dvh w-screen overflow-hidden bg-black text-slate-100">
      <div
        style={{
          width: SCREEN_DESIGN_WIDTH,
          height: SCREEN_DESIGN_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: 'left top',
          position: 'absolute',
          left: `${(window.innerWidth - SCREEN_DESIGN_WIDTH * scale) / 2}px`,
          top: `${(window.innerHeight - SCREEN_DESIGN_HEIGHT * scale) / 2}px`,
        }}
        className="flex flex-col gap-3 bg-slate-950 p-5 font-sans"
      >
        {/* 顶栏 */}
        <header className="flex shrink-0 items-center justify-between rounded-xl border border-slate-800 bg-gradient-to-r from-slate-900 to-slate-900/40 px-6 py-3">
          <div>
            {(payload?.topBar.companyNameLines.length ?? 0) > 0 ? (
              payload!.topBar.companyNameLines.map((line, index) => (
                <div key={index} className={index === 0 ? 'text-2xl font-bold tracking-widest' : 'text-sm text-slate-400'}>
                  {line}
                </div>
              ))
            ) : (
              <div className="text-2xl font-bold tracking-widest text-slate-500">数字运营中心</div>
            )}
          </div>
          <div className="flex items-center gap-10">
            <div className="text-center">
              <div className="text-xs text-slate-400">安全生产</div>
              <div className="text-3xl font-bold text-emerald-400">
                {displayNumber(payload?.topBar.safeProductionDays ?? null)}
                <span className="ml-1 text-sm">天</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-slate-400">
                6S 得分<Badge kind="definition" />
              </div>
              <div className="text-3xl font-bold text-cyan-300">
                {displayScore(payload?.topBar.sixSScore ?? 0)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-slate-400">
                综合得分<Badge kind="definition" />
              </div>
              <div className="text-3xl font-bold text-cyan-300">
                {displayScore(payload?.topBar.comprehensiveScore ?? 0)}
              </div>
            </div>
            <div className="flex items-center gap-2 border-l border-slate-700 pl-6 text-sm text-slate-400">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor}`} />
              {statusText[streamStatus]}
              <span className="ml-2 tabular-nums text-slate-300">{clock}</span>
            </div>
          </div>
        </header>

        {frame === null ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="text-xl text-slate-400">
                {streamStatus === 'unauthorized'
                  ? '未登录或会话已过期——请先登录后打开本页（/login）'
                  : snapshotError !== null
                    ? `快照加载失败：${snapshotError}（等待实时推送…）`
                    : '正在加载首帧…'}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* KPI 条（RREQ-RP-024） */}
            <div className="grid shrink-0 grid-cols-7 gap-3">
              <KpiCard label="本月计划发货(台套)" value={payload!.kpi.monthlyPlannedDeliverySets} pending={pending} path="kpi.monthlyPlannedDeliverySets" />
              <KpiCard label="本月已发货(台套)" value={payload!.kpi.monthlyDeliveredSets} pending={pending} path="kpi.monthlyDeliveredSets" />
              <KpiCard label="在制工作令" value={payload!.kpi.inProgressWorkOrders} pending={pending} path="kpi.inProgressWorkOrders" />
              <KpiCard label="关键里程碑按期率" value={payload!.kpi.milestoneOnTimeRate} pending={pending} path="kpi.milestoneOnTimeRate" format={displayRate} />
              <KpiCard label="年度下图数量" value={payload!.kpi.yearlyDrawingIntakeCount} pending={pending} path="kpi.yearlyDrawingIntakeCount" />
              <KpiCard label="待机加图号数" value={payload!.kpi.pendingMachiningDrawingCount} pending={pending} path="kpi.pendingMachiningDrawingCount" />
              <KpiCard label="一次交检合格率" value={payload!.kpi.firstPassYieldRate} pending={pending} path="kpi.firstPassYieldRate" format={displayRate} />
            </div>

            {/* 中排：项目进度 + 在制快照（RREQ-RP-025/026①） */}
            <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
              <div className="col-span-7 min-h-0">
                <Panel title="项目进度一览">
                  <table className="w-full table-fixed text-xs">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="w-40 text-left font-normal">项目</th>
                        <th className="w-14 font-normal">风险</th>
                        <th className="w-20 font-normal">剩余交期</th>
                        <th className="w-16 font-normal">整体进度</th>
                        <th className="font-normal">零件(入库/总)</th>
                        <th className="font-normal">外购件</th>
                        <th className="font-normal">电气件</th>
                        <th className="w-14 font-normal">装配</th>
                        <th className="w-14 font-normal">打包发货</th>
                      </tr>
                    </thead>
                    <tbody className="overflow-hidden">
                      {payload!.projectProgressRows.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="py-6 text-center text-slate-500">
                            暂无在制工作令
                          </td>
                        </tr>
                      ) : (
                        payload!.projectProgressRows.map((row) => (
                          <tr key={row.workOrderId} className="border-b border-slate-800/60">
                            <td className="truncate py-1 pr-2 text-slate-200" title={row.projectName}>
                              {row.projectName}
                            </td>
                            <td className="py-1 text-center">
                              <span
                                className={
                                  row.riskLevel === 'high'
                                    ? 'text-rose-400'
                                    : row.riskLevel === 'mid'
                                      ? 'text-amber-300'
                                      : 'text-emerald-300'
                                }
                              >
                                {riskLabel(row.riskLevel)}
                              </span>
                            </td>
                            <td className="py-1 text-center text-slate-300">
                              <Metric value={row.remainingDays} pending={{}} path="" format={displayRemainingDays} />
                            </td>
                            <td className="py-1 text-center text-slate-200">
                              <span className="whitespace-nowrap">
                                {displayProgress(row.overallProgress)}
                                <Badge kind="definition" />
                              </span>
                            </td>
                            <td className="py-1 text-center text-slate-300">
                              <span className="whitespace-nowrap">
                                {displayStoredTotal(row.parts)}
                                {pendingMarker(pending, 'projectProgressRows.parts.stored') !== null && (
                                  <Badge kind={pendingMarker(pending, 'projectProgressRows.parts.stored')!} />
                                )}
                              </span>
                            </td>
                            <td className="py-1 text-center text-slate-400">
                              <span className="whitespace-nowrap">
                                {displayStoredTotal(row.purchasedParts)}
                                <Badge kind="source" />
                              </span>
                            </td>
                            <td className="py-1 text-center text-slate-300">
                              <span className="whitespace-nowrap">
                                {displayStoredTotal(row.electricalParts)}
                                {pendingMarker(pending, 'projectProgressRows.electricalParts.stored') !== null && (
                                  <Badge kind={pendingMarker(pending, 'projectProgressRows.electricalParts.stored')!} />
                                )}
                              </span>
                            </td>
                            <td className="py-1 text-center text-slate-400">
                              <span className="whitespace-nowrap">
                                {displayProgress(row.assemblyProgress)}
                                <Badge kind="source" />
                              </span>
                            </td>
                            <td className="py-1 text-center text-slate-400">
                              <span className="whitespace-nowrap">
                                {displayProgress(row.packShipProgress)}
                                <Badge kind="source" />
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </Panel>
              </div>
              <div className="col-span-5 flex min-h-0 flex-col gap-3">
                <Panel title="机加·外协 在制快照">
                  <div className="mb-1 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-[11px] text-slate-400">自制执行</div>
                      <div className="text-xl font-bold text-slate-100">
                        <Metric value={payload!.machiningOnlineSnapshot.selfDispatchedOrderCount} pending={pending} path="machiningOnlineSnapshot.selfDispatchedOrderCount" />
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">今日产出(合格件)</div>
                      <div className="text-xl font-bold text-slate-100">
                        <Metric value={payload!.machiningOnlineSnapshot.todayQualifiedOutputQuantity} pending={pending} path="machiningOnlineSnapshot.todayQualifiedOutputQuantity" />
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">外协在制</div>
                      <div className="text-xl font-bold text-slate-100">
                        <Metric value={payload!.machiningOnlineSnapshot.outsourceDispatchedOrderCount} pending={pending} path="machiningOnlineSnapshot.outsourceDispatchedOrderCount" />
                      </div>
                    </div>
                  </div>
                  <table className="w-full table-fixed text-xs">
                    <tbody>
                      {payload!.machiningOnlineSnapshot.machiningDispatchRows.map((row) => (
                        <DispatchRowView key={row.orderNo} row={row} />
                      ))}
                      {payload!.machiningOnlineSnapshot.outsourceDispatchRows.map((row) => (
                        <DispatchRowView key={row.orderNo} row={row} withVendor />
                      ))}
                      {payload!.machiningOnlineSnapshot.machiningDispatchRows.length === 0 &&
                        payload!.machiningOnlineSnapshot.outsourceDispatchRows.length === 0 && (
                          <tr>
                            <td className="py-3 text-center text-slate-500">暂无派工单</td>
                          </tr>
                        )}
                    </tbody>
                  </table>
                </Panel>
                <Panel title="装配在制（类型块 + 明细）">
                  <div className="mb-1 flex flex-wrap gap-2">
                    {payload!.assemblyOnlineSnapshot.typeCounts.length === 0 ? (
                      <span className="text-xs text-slate-500">暂无装配派工</span>
                    ) : (
                      payload!.assemblyOnlineSnapshot.typeCounts.map((item) => (
                        <span key={item.type} className="rounded-md border border-sky-700/60 bg-sky-950/60 px-2 py-0.5 text-xs text-sky-300">
                          {item.type} × {item.count}
                        </span>
                      ))
                    )}
                  </div>
                  <table className="w-full table-fixed text-xs">
                    <tbody>
                      {payload!.assemblyOnlineSnapshot.detailRows.map((row) => (
                        <DispatchRowView key={row.orderNo} row={row} />
                      ))}
                    </tbody>
                  </table>
                </Panel>
              </div>
            </div>

            {/* 底排：产出与入库 + 排名（RREQ-RP-026②③） */}
            <div className="grid shrink-0 grid-cols-12 gap-3" style={{ height: 300 }}>
              <div className="col-span-4">
                <Panel title="产出与入库（近 12 天报工）">
                  <DailyOutputChart points={payload!.dailyProductionOutputByWorkReport} pending={pending} />
                </Panel>
              </div>
              <div className="col-span-3">
                <Panel title="当日产出 / 在制（08:00~20:00）">
                  <HourlyOutputChart points={payload!.hourlyOutputWipPoints} pending={pending} />
                </Panel>
              </div>
              <div className="col-span-3">
                <Panel title="当日入库与质检">
                  <HourlyInboundChart points={payload!.hourlyInboundInspectionPoints} pending={pending} />
                </Panel>
              </div>
              <div className="col-span-2">
                <Panel title="今日报工排名">
                  <table className="w-full text-xs">
                    <tbody>
                      {payload!.todayWorkReportRankRows.length === 0 ? (
                        <tr>
                          <td className="py-3 text-center text-slate-500">今日暂无报工</td>
                        </tr>
                      ) : (
                        payload!.todayWorkReportRankRows.map((row, index) => (
                          <tr key={row.reporter} className="border-b border-slate-800/60">
                            <td className="w-6 py-1 text-slate-500">{index + 1}</td>
                            <td className="truncate py-1 text-slate-200" title={row.reporter}>
                              {row.userName}
                            </td>
                            <td className="py-1 text-right font-semibold text-amber-300">{row.quantity}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </Panel>
              </div>
            </div>

            {/* 页脚图例（占位可辨识纪律） */}
            <footer className="flex shrink-0 items-center justify-between px-1 text-[11px] text-slate-500">
              <span>
                <span className="rounded-sm border border-amber-500/60 px-1 text-amber-300">待定</span>
                ＝口径待定占位（业务口径确认后替换）
                <span className="ml-4 rounded-sm border border-amber-500/60 px-1 text-amber-300">待接</span>
                ＝数据源待接（读面缺失，如实呈现不虚构）
              </span>
              <span>
                数据帧 {new Date(frame!.ts).toLocaleTimeString('zh-CN', { hour12: false })} · 通道 {statusText[streamStatus]}
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
