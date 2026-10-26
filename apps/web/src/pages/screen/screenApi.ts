/**
 * 数字运营大屏薄数据层（A8 首波，6a-3 裁决 3：web 大屏页补建）。
 *
 * 端点实态（apps/server screen-http.module.ts）：
 *  - GET /screen/digital-operation —— 快照查询（report:read 门禁；响应 =
 *    SSE 数据帧同构信封 {type:'digital_operation.snapshot', ts, payload}）；
 *  - GET /screen/digital-operation/stream?token=… —— SSE 推送通道（EventSource
 *    不能带 Authorization 头 → 会话 token 经查询参传入；服务端 5s 节拍推帧）。
 *
 * 通道取舍（写明，按 web 既有模式裁量）：页面走 **SSE 订阅 ?token= 形态**——
 * 服务端通道为此设计（EventSource 无 header），且墙挂大屏需要被动持续刷新；
 * 登录会话（localStorage 'cadence.session.v2'，与登录 bundle 同键）提供 token。
 * 首帧不等节拍：挂载即用登录会话 fetch 一次快照（Bearer 自动注入，apiClient
 * 既有通道），SSE 随后接管增量帧。token 轮换（会话保活）后旧 URL 失效 →
 * onerror 重连时重读存储里的新 token 重建 URL。
 *
 * 解析取舍：大屏是呈现面——解析对形状漂移**宽容降级**（缺块/坏形状 → 空块/
 * null 值 + pendingFields 原样保留），不抛错白屏；payload 契约的页面视图类型
 * 在本文件静态镜像（web-via-ui 铁律：不 import 后端包）。
 */
import { request } from '../../data/apiClient';
import {
  TOKEN_SESSION_STORAGE_KEY,
  createBrowserTokenSessionStore,
  isTokenSessionExpired,
} from '@smes/product-ui';

const sessionStore = createBrowserTokenSessionStore(window.localStorage, TOKEN_SESSION_STORAGE_KEY);

// ---- 帧载荷页面视图（@smes/application screen-payload.ts 的静态镜像） ----

/** 占位种类：definition=口径待定（值按约定生成）；source=数据源待接（值 null）。 */
export type ScreenPendingKind = 'definition' | 'source';

/** 占位字段登记（字段路径 → 种类；与 payload.pendingFields 同构）。 */
export type ScreenPendingFields = Readonly<Record<string, ScreenPendingKind>>;

export interface ScreenTopBarView {
  readonly companyNameLines: readonly string[];
  readonly safeProductionDays: number;
  readonly sixSScore: number;
  readonly comprehensiveScore: number;
}

export interface ScreenKpiView {
  readonly monthlyPlannedDeliverySets: number | null;
  readonly monthlyDeliveredSets: number | null;
  readonly inProgressWorkOrders: number | null;
  readonly milestoneOnTimeRate: number;
  readonly yearlyDrawingIntakeCount: number | null;
  readonly pendingMachiningDrawingCount: number | null;
  readonly firstPassYieldRate: number;
}

export interface ScreenStoredTotalView {
  readonly stored: number | null;
  readonly total: number | null;
}

export interface ScreenProjectProgressRowView {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly riskLevel: 'low' | 'mid' | 'high' | null;
  readonly remainingDays: number | null;
  readonly overallProgress: number;
  readonly parts: ScreenStoredTotalView;
  readonly purchasedParts: ScreenStoredTotalView;
  readonly electricalParts: ScreenStoredTotalView;
  readonly assemblyProgress: number | null;
  readonly wiringProgress: number | null;
  readonly debuggingProgress: number | null;
  readonly lineWiringProgress: number | null;
  readonly lineDebugProgress: number | null;
  readonly packShipProgress: number | null;
}

export interface ScreenDispatchRowView {
  readonly orderNo: string;
  readonly opName: string | null;
  readonly vendor: string | null;
  readonly progress: number;
  readonly dispatchStatus: 1 | 2 | 3 | 4;
  readonly status: string;
  readonly led: 'off' | 'info' | 'warn' | 'ok';
}

export interface ScreenMachiningSnapshotView {
  readonly selfDispatchedOrderCount: number | null;
  readonly todayQualifiedOutputQuantity: number | null;
  readonly outsourceDispatchedOrderCount: number | null;
  readonly machiningDispatchRows: readonly ScreenDispatchRowView[];
  readonly outsourceDispatchRows: readonly ScreenDispatchRowView[];
}

export interface ScreenAssemblyTypeCountView {
  readonly type: string;
  readonly count: number;
}

export interface ScreenAssemblySnapshotView {
  readonly typeCounts: readonly ScreenAssemblyTypeCountView[];
  readonly detailRows: readonly ScreenDispatchRowView[];
}

export interface ScreenDailyOutputPointView {
  readonly dayLabel: string;
  readonly date: string;
  readonly quantity: number | null;
}

export interface ScreenHourlyOutputWipPointView {
  readonly hourFrom: number;
  readonly hourLabel: string;
  readonly wipDrawingDistinctCount: number | null;
  readonly qualifiedQuantity: number | null;
}

export interface ScreenHourlyInboundPointView {
  readonly hourFrom: number;
  readonly hourLabel: string;
  readonly pendingStorageQuantity: number | null;
  readonly pendingInspectionQuantity: number | null;
  readonly cumulativeQualifiedInspectionQuantity: number | null;
}

export interface ScreenRankRowView {
  readonly userName: string;
  readonly reporter: string;
  readonly quantity: number;
}

export interface ScreenFrameView {
  readonly topBar: ScreenTopBarView;
  readonly kpi: ScreenKpiView;
  readonly projectProgressRows: readonly ScreenProjectProgressRowView[];
  readonly machiningOnlineSnapshot: ScreenMachiningSnapshotView;
  readonly assemblyOnlineSnapshot: ScreenAssemblySnapshotView;
  readonly dailyProductionOutputByWorkReport: readonly ScreenDailyOutputPointView[];
  readonly hourlyOutputWipPoints: readonly ScreenHourlyOutputWipPointView[];
  readonly hourlyInboundInspectionPoints: readonly ScreenHourlyInboundPointView[];
  readonly todayWorkReportRankRows: readonly ScreenRankRowView[];
  readonly pendingFields: ScreenPendingFields;
}

export interface ScreenEnvelopeView {
  readonly type: 'digital_operation.snapshot';
  readonly ts: number;
  readonly payload: ScreenFrameView;
}

// ---- 宽容解析（呈现面不抛错；坏形状 → 空块/null，pendingFields 原样保留） ----

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asPendingKind(value: unknown): ScreenPendingKind {
  return value === 'definition' ? 'definition' : 'source';
}

function parseStoredTotal(value: unknown): ScreenStoredTotalView {
  const record = asRecord(value);
  return { stored: asNumberOrNull(record['stored']), total: asNumberOrNull(record['total']) };
}

function parseDispatchRow(value: unknown): ScreenDispatchRowView {
  const record = asRecord(value);
  const status = asNumber(record['dispatchStatus'], 1);
  const code: 1 | 2 | 3 | 4 = status === 2 || status === 3 || status === 4 ? status : 1;
  const ledRaw = record['led'];
  const led: ScreenDispatchRowView['led'] =
    ledRaw === 'info' || ledRaw === 'warn' || ledRaw === 'ok' ? ledRaw : 'off';
  return {
    orderNo: asString(record['orderNo']),
    opName: asStringOrNull(record['opName']),
    vendor: asStringOrNull(record['vendor']),
    progress: asNumber(record['progress'], 0),
    dispatchStatus: code,
    status: asString(record['status']),
    led,
  };
}

/** 信封 → 页面视图（宽容：未知形状一律降级空块，不 throw）。 */
export function parseScreenEnvelope(input: unknown): ScreenEnvelopeView {
  const envelope = asRecord(input);
  const payload = asRecord(envelope['payload']);
  const topBar = asRecord(payload['topBar']);
  const kpi = asRecord(payload['kpi']);
  const machining = asRecord(payload['machiningOnlineSnapshot']);
  const assembly = asRecord(payload['assemblyOnlineSnapshot']);
  const pendingFields: Record<string, ScreenPendingKind> = {};
  for (const [path, kind] of Object.entries(asRecord(payload['pendingFields']))) {
    pendingFields[path] = asPendingKind(kind);
  }
  return {
    type: 'digital_operation.snapshot',
    ts: asNumber(envelope['ts'], 0),
    payload: {
      topBar: {
        companyNameLines: asArray(topBar['companyNameLines']).map(asString).filter((line) => line.length > 0),
        safeProductionDays: asNumber(topBar['safeProductionDays'], 0),
        sixSScore: asNumber(topBar['sixSScore'], 0),
        comprehensiveScore: asNumber(topBar['comprehensiveScore'], 0),
      },
      kpi: {
        monthlyPlannedDeliverySets: asNumberOrNull(kpi['monthlyPlannedDeliverySets']),
        monthlyDeliveredSets: asNumberOrNull(kpi['monthlyDeliveredSets']),
        inProgressWorkOrders: asNumberOrNull(kpi['inProgressWorkOrders']),
        milestoneOnTimeRate: asNumber(kpi['milestoneOnTimeRate'], 0),
        yearlyDrawingIntakeCount: asNumberOrNull(kpi['yearlyDrawingIntakeCount']),
        pendingMachiningDrawingCount: asNumberOrNull(kpi['pendingMachiningDrawingCount']),
        firstPassYieldRate: asNumber(kpi['firstPassYieldRate'], 0),
      },
      projectProgressRows: asArray(payload['projectProgressRows']).map((row) => {
        const record = asRecord(row);
        const risk = record['riskLevel'];
        return {
          workOrderId: asString(record['workOrderId']),
          projectName: asString(record['projectName']),
          riskLevel: risk === 'low' || risk === 'mid' || risk === 'high' ? risk : null,
          remainingDays: asNumberOrNull(record['remainingDays']),
          overallProgress: asNumber(record['overallProgress'], 0),
          parts: parseStoredTotal(record['parts']),
          purchasedParts: parseStoredTotal(record['purchasedParts']),
          electricalParts: parseStoredTotal(record['electricalParts']),
          assemblyProgress: asNumberOrNull(record['assemblyProgress']),
          wiringProgress: asNumberOrNull(record['wiringProgress']),
          debuggingProgress: asNumberOrNull(record['debuggingProgress']),
          lineWiringProgress: asNumberOrNull(record['lineWiringProgress']),
          lineDebugProgress: asNumberOrNull(record['lineDebugProgress']),
          packShipProgress: asNumberOrNull(record['packShipProgress']),
        };
      }),
      machiningOnlineSnapshot: {
        selfDispatchedOrderCount: asNumberOrNull(machining['selfDispatchedOrderCount']),
        todayQualifiedOutputQuantity: asNumberOrNull(machining['todayQualifiedOutputQuantity']),
        outsourceDispatchedOrderCount: asNumberOrNull(machining['outsourceDispatchedOrderCount']),
        machiningDispatchRows: asArray(machining['machiningDispatchRows']).map(parseDispatchRow),
        outsourceDispatchRows: asArray(machining['outsourceDispatchRows']).map(parseDispatchRow),
      },
      assemblyOnlineSnapshot: {
        typeCounts: asArray(assembly['typeCounts']).map((item) => {
          const record = asRecord(item);
          return { type: asString(record['type']), count: asNumber(record['count'], 0) };
        }),
        detailRows: asArray(assembly['detailRows']).map(parseDispatchRow),
      },
      dailyProductionOutputByWorkReport: asArray(payload['dailyProductionOutputByWorkReport']).map(
        (item) => {
          const record = asRecord(item);
          return {
            dayLabel: asString(record['dayLabel']),
            date: asString(record['date']),
            quantity: asNumberOrNull(record['quantity']),
          };
        },
      ),
      hourlyOutputWipPoints: asArray(payload['hourlyOutputWipPoints']).map((item) => {
        const record = asRecord(item);
        return {
          hourFrom: asNumber(record['hourFrom'], 0),
          hourLabel: asString(record['hourLabel']),
          wipDrawingDistinctCount: asNumberOrNull(record['wipDrawingDistinctCount']),
          qualifiedQuantity: asNumberOrNull(record['qualifiedQuantity']),
        };
      }),
      hourlyInboundInspectionPoints: asArray(payload['hourlyInboundInspectionPoints']).map((item) => {
        const record = asRecord(item);
        return {
          hourFrom: asNumber(record['hourFrom'], 0),
          hourLabel: asString(record['hourLabel']),
          pendingStorageQuantity: asNumberOrNull(record['pendingStorageQuantity']),
          pendingInspectionQuantity: asNumberOrNull(record['pendingInspectionQuantity']),
          cumulativeQualifiedInspectionQuantity: asNumberOrNull(
            record['cumulativeQualifiedInspectionQuantity'],
          ),
        };
      }),
      todayWorkReportRankRows: asArray(payload['todayWorkReportRankRows']).map((item) => {
        const record = asRecord(item);
        return {
          userName: asString(record['userName']),
          reporter: asString(record['reporter']),
          quantity: asNumber(record['quantity'], 0),
        };
      }),
      pendingFields,
    },
  };
}

// ---- 通道 ----

/** 登录会话 token（与登录 bundle 同键共享；过期/缺失 → null，页面提示登录）。 */
export function readScreenToken(nowMs: number = Date.now()): string | null {
  const session = sessionStore.read();
  if (session === null || isTokenSessionExpired(session, nowMs)) return null;
  return session.token;
}

/** SSE 通道 URL（token 经查询参——EventSource 无 header，服务端设计内形态）。 */
export function screenStreamUrl(token: string, apiBase = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? ''): string {
  return `${apiBase}/screen/digital-operation/stream?token=${encodeURIComponent(token)}`;
}

/** 快照查询（首帧即取，不等 SSE 节拍；Bearer 由 apiClient 会话注入）。 */
export async function fetchScreenSnapshot(): Promise<ScreenEnvelopeView> {
  return parseScreenEnvelope(await request('/screen/digital-operation'));
}
