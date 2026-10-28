/**
 * 移动报工页（M5 首波，report:submit；预研 scan-report 页升级迁入移动组）。
 * UX-VW-05：无 report:submit 权限的账号进页只呈现无权限终态，不渲染写入控件
 * 与提交引导文案（门禁见 canSubmit 早返回）。
 *
 * 页面码三问记录（ADR-0010）：
 * 1. m.report 只在单一行业有意义吗？否——report 是 ADR-0010 内核白名单词
 *    （任何离散制造行业的报工/上报动作）；m. 是装配层路由组命名空间。
 * 2. 需要重述为上位概念吗？否——report 本身就是上位概念。
 * 3. 已有通用上位概念挂靠？是——挂 Report（内核白名单）。
 * 路由 /m/report、权限码 report:submit 同理（与 M2 reporting 后端同码）。
 *
 * 升级点（相对预研 /scan/report）：
 * - 工时 laborMinutes 真实录入（预研缺省 1 分钟占位移除，见 reportDraft.ts）；
 * - 布局移动单列（车间单手操作；桌面打开时 max-w-2xl 居中）。
 *
 * 三段形状（预研既定，正式沿用）：
 * - 扫码段：复用 useScanSession（import 组合不复制）——最新扫码结果自动
 *   填入草稿"对象引用"（派工单 id 语义——非派工单 id 由后端 submit 前置
 *   校验 fail-closed 拒绝，经 rejected 反馈）；
 * - 草稿表单：对象引用/数量/工时/备注——纯前端状态（不入队列不落盘）；
 * - 提交分路：在线直发 submitReportDraft（reportingApi → POST /reports，
 *   CommandEnvelope 载荷）；离线（或在线提交抛错）自动入 OfflineQueue
 *   （product-ui offline.ts，localStorage 持久化）；恢复在线（restored 事件）
 *   出提示条，点"重放"驱动 queue.replay(submitReportDraft)（严格 FIFO，
 *   幂等键同源——重放不产生重复报工，语义见 reportingApi 文件头）。
 */
import { useEffect, useRef, useState } from 'react';
import { CloudOff, RotateCw, ScanLine, Wifi } from 'lucide-react';
import {
  connectBrowserNetworkState,
  createNetworkStateModel,
  createOfflineQueue,
  hydrateOfflineQueue,
  offlineQueueStorageKey,
  permissionCode,
} from '@smes/product-ui';
import type { NetworkStateModel, OfflineQueue } from '@smes/product-ui';
import { useMobileDataAccess, MobileNoAccessHint } from './pageAccess';
import { submitReportDraft } from '@/data/reportingApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { shortId } from '@/lib/format';
import { MAX_LABOR_MINUTES, buildReportDraftSubmission, isReportDraftSubmission } from '@/pages/scan/reportDraft';
import type { ReportDraftSubmission } from '@/pages/scan/reportDraft';
import { SCAN_TIER_LABELS, SCAN_VIDEO_ELEMENT_ID, useScanSession } from '@/pages/scan/useScanSession';

/** 离线队列名（localStorage 键 cadence.offline-queue.v1.report-draft——预研同名沿用）。 */
const QUEUE_NAME = 'report-draft';
const QUEUE_STORAGE_KEY = offlineQueueStorageKey(QUEUE_NAME);

/** 本页动作权限码（report:submit——与 mobile.ts 注册表 m.report 导航码同码；整页为写入面）。 */
const REPORT_SUBMIT_CODE = permissionCode('report:submit');

interface DraftFormState {
  readonly ref: string;
  readonly quantity: string;
  readonly laborMinutes: string;
  readonly note: string;
}

const EMPTY_DRAFT: DraftFormState = { ref: '', quantity: '1', laborMinutes: '60', note: '' };

type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'submitted'; readonly ref: string }
  | { readonly kind: 'queued' }
  | { readonly kind: 'invalid'; readonly message: string };

export function MobileReportPage() {
  // UX-VW-05：整页按动作权限投影门禁（report:submit）——无权限账号（如只读
  // 访客）进入本页只呈现无权限终态，不渲染扫码/草稿表单/离线队列等写入面。
  const canSubmit = useMobileDataAccess(REPORT_SUBMIT_CODE);
  // ---- 扫码段（复用装配，不复制） ----
  const { model, session, wedgeHint } = useScanSession();

  // ---- 草稿表单（纯前端状态） ----
  const [draft, setDraft] = useState<DraftFormState>(EMPTY_DRAFT);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });

  // 最新扫码结果自动填入"对象引用"（新码覆盖；人工仍可改）
  const lastScanRef = useRef<string | null>(null);
  const recentResults = session?.recentResults ?? [];
  useEffect(() => {
    const latest = recentResults[recentResults.length - 1];
    if (latest !== undefined && latest.code !== lastScanRef.current) {
      lastScanRef.current = latest.code;
      setDraft((prev) => ({ ...prev, ref: latest.code }));
    }
  }, [recentResults]);

  // ---- 离线队列（hydrate localStorage；每次变更后回写 + 快照进 state） ----
  const queueRef = useRef<OfflineQueue<ReportDraftSubmission> | null>(null);
  if (queueRef.current === null) {
    queueRef.current =
      hydrateOfflineQueue<ReportDraftSubmission>(localStorage.getItem(QUEUE_STORAGE_KEY), {
        name: QUEUE_NAME,
        isPayload: isReportDraftSubmission,
      }) ??
      createOfflineQueue<ReportDraftSubmission>({ name: QUEUE_NAME, isPayload: isReportDraftSubmission });
  }
  const queue = queueRef.current;
  const [pending, setPending] = useState<readonly ReportDraftSubmission[]>(() =>
    queue.pending().map((entry) => entry.payload),
  );
  const [replaying, setReplaying] = useState(false);

  // ---- 网络状态（product-ui 订阅式模型 + navigator 桥） ----
  const [netModel] = useState<NetworkStateModel>(() => createNetworkStateModel());
  const [online, setOnline] = useState<boolean | null>(() => netModel.getState().online);
  const [restorePrompt, setRestorePrompt] = useState(false);
  useEffect(() => {
    const unsubscribe = netModel.subscribe((event) => {
      setOnline(event.online);
      // 恢复在线：提示重放（不自动重放——现场用户确认队列内容后再放）
      if (event.kind === 'restored' && queueRef.current !== null && queueRef.current.size() > 0) {
        setRestorePrompt(true);
      }
    });
    const disconnect = connectBrowserNetworkState(netModel, {
      // 显式适配：navigator 的结构类型在 DOM/Node 声明合并下不稳定（方法解析
      // 受 @types/node 干扰），经 window 显式转发；onLine 只读值无此问题
      onLine: navigator.onLine,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    });
    return () => {
      unsubscribe();
      disconnect();
    };
  }, [netModel]);

  function syncQueue(): void {
    localStorage.setItem(QUEUE_STORAGE_KEY, queue.serialize());
    setPending(queue.pending().map((entry) => entry.payload));
  }

  function enqueueSubmission(submission: ReportDraftSubmission): void {
    const result = queue.enqueue(submission.key, submission);
    syncQueue();
    if (result.outcome === 'duplicate') {
      setSubmitState({ kind: 'queued' }); // 同键已在队：不重复，按已入队反馈
      return;
    }
    if (result.evicted !== null) {
      // drop-oldest 淘汰提示（取舍见 product-ui offline.ts 文件头）；
      // 本条已入队成功（outcome='enqueued'），invalid 态仅提示旧条被淘汰
      setSubmitState({ kind: 'invalid', message: `本条已入队；队列已满，最早的一条（${result.evicted.payload.ref}）被淘汰` });
      return;
    }
    setSubmitState({ kind: 'queued' });
  }

  async function handleSubmit(): Promise<void> {
    if (submitState.kind === 'submitting') return;
    const quantity = Number(draft.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setSubmitState({ kind: 'invalid', message: '数量须为正数' });
      return;
    }
    const laborMinutes = Number(draft.laborMinutes);
    if (!Number.isInteger(laborMinutes) || laborMinutes <= 0 || laborMinutes > MAX_LABOR_MINUTES) {
      setSubmitState({ kind: 'invalid', message: `工时须为 (0, ${MAX_LABOR_MINUTES}] 内的整数分钟` });
      return;
    }
    let submission: ReportDraftSubmission;
    try {
      submission = buildReportDraftSubmission({
        key: `rpt-${crypto.randomUUID()}`,
        ref: draft.ref,
        quantity,
        laborMinutes,
        note: draft.note,
        submittedAt: new Date().toISOString(),
      });
    } catch (error) {
      setSubmitState({
        kind: 'invalid',
        message: error instanceof Error ? error.message : '草稿不完整（对象引用/数量/工时必填）',
      });
      return;
    }

    if (online === false) {
      enqueueSubmission(submission); // 离线：直接入队
      return;
    }
    setSubmitState({ kind: 'submitting' });
    try {
      await submitReportDraft(submission); // 在线：真实提交通道（reportingApi → POST /reports）
      setSubmitState({ kind: 'submitted', ref: submission.ref });
    } catch {
      enqueueSubmission(submission); // 在线提交失败（网络/拒绝）：离线策略兜底入队
    }
  }

  async function handleReplay(): Promise<void> {
    if (replaying) return;
    setReplaying(true);
    try {
      await queue.replay((entry) => submitReportDraft(entry.payload));
    } finally {
      syncQueue();
      setReplaying(false);
      setRestorePrompt(false);
    }
  }

  const active = session?.status === 'active';
  const currentTier = session?.currentTier ?? null;

  // UX-VW-05 无权限终态：早于全部写入 UI 返回（所有 hook 已在上方无条件执行）。
  if (!canSubmit) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>移动报工</CardTitle>
        </CardHeader>
        <CardContent>
          <MobileNoAccessHint code={REPORT_SUBMIT_CODE} subject="报工提交" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 网络状态条（离线提示 + 队列计数 + 恢复提示重放） */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs',
          online === false ? 'border-amber-300 bg-amber-50 text-amber-900' : 'bg-background text-muted-foreground',
        )}
      >
        {online === false ? <CloudOff className="size-3.5 shrink-0" /> : <Wifi className="size-3.5 shrink-0" />}
        {online === false ? '当前离线：提交将进入本地队列，恢复网络后重放' : online === true ? '当前在线：提交直发（失败自动入队）' : '网络状态探测中…'}
        {pending.length > 0 && (
          <span className="rounded border bg-muted px-1.5 py-0.5">队列 {pending.length} 条待重放</span>
        )}
      </div>
      {restorePrompt && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <span>网络已恢复——队列中有 {pending.length} 条待重放（按入队顺序发送）。</span>
          <Button size="sm" variant="outline" disabled={replaying} onClick={() => void handleReplay()}>
            <RotateCw className="mr-1 size-3.5" />
            {replaying ? '重放中…' : '立即重放'}
          </Button>
        </div>
      )}

      {/* 扫码段（复用 useScanSession；摄像头模式须渲染挂载点容器） */}
      <Card>
        <CardHeader>
          <CardTitle>扫码定位派工单</CardTitle>
          <CardDescription>扫派工单条码自动填入下方"派工单号"；按设备能力自动选择扫码方式。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {model === null || session === null ? (
            <p className="text-sm text-muted-foreground">无可用的扫码方式，可直接在下方手填派工单号。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                {active ? (
                  <Button variant="outline" size="sm" onClick={() => model.stop()}>
                    停止扫码
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => model.start()}>
                    {session.status === 'exhausted' ? '重新开始' : '开始扫码'}
                  </Button>
                )}
                {active && currentTier !== null && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ScanLine className="size-3.5" />
                    正在使用「{SCAN_TIER_LABELS[currentTier]}」…
                  </span>
                )}
              </div>

              {currentTier === 'tier1-camera' && (
                <div className="relative overflow-hidden rounded-lg border bg-muted/60" style={{ aspectRatio: '4 / 3' }}>
                  <div id={SCAN_VIDEO_ELEMENT_ID} className="h-full w-full [&>video]:h-full [&>video]:w-full [&>video]:object-cover" />
                  {!active && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                      摄像头未启动
                    </div>
                  )}
                </div>
              )}
              {currentTier === 'tier3-device-wedge' && (
                <div
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-sm text-muted-foreground',
                    active ? 'border-primary/50 bg-primary/5 text-primary' : 'bg-muted/60',
                  )}
                >
                  {active ? '扫码枪就绪：保持本页面焦点，扫描后码值自动填入表单' : '扫码枪模式未启动'}
                </div>
              )}
              {wedgeHint !== null && <p className="text-xs text-muted-foreground">{wedgeHint}</p>}
              {recentResults.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  最近扫码：<span className="font-mono">{recentResults[recentResults.length - 1]?.code}</span>
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 草稿表单（纯前端状态） + 提交分路 */}
      <Card>
        <CardHeader>
          <CardTitle>报工草稿</CardTitle>
          <CardDescription>填写派工单号、完成数量、工时与备注后提交；断网时自动暂存本机，联网后一键补送。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            派工单号
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={draft.ref}
              placeholder="扫码或手填派工单编号"
              onChange={(event) => setDraft((prev) => ({ ...prev, ref: event.target.value }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              完成数量
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                type="number"
                min="0.01"
                step="any"
                inputMode="decimal"
                value={draft.quantity}
                onChange={(event) => setDraft((prev) => ({ ...prev, quantity: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              工时（分钟）
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                type="number"
                min="1"
                max={MAX_LABOR_MINUTES}
                step="1"
                inputMode="numeric"
                value={draft.laborMinutes}
                onChange={(event) => setDraft((prev) => ({ ...prev, laborMinutes: event.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            备注
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={draft.note}
              placeholder="可选"
              onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
            />
          </label>

          <Button
            className="h-12"
            disabled={submitState.kind === 'submitting'}
            onClick={() => void handleSubmit()}
          >
            {submitState.kind === 'submitting' ? '提交中…' : online === false ? '提交（入本地队列）' : '提交'}
          </Button>

          {submitState.kind === 'submitted' && (
            <p className="text-xs text-emerald-700">
              报工已提交，派工单号{' '}
              <span className="font-mono" title={submitState.ref}>
                {shortId(submitState.ref)}
              </span>
            </p>
          )}
          {submitState.kind === 'queued' && (
            <p className="text-xs text-amber-700">已入离线队列，恢复网络后可在上方提示条重放。</p>
          )}
          {submitState.kind === 'invalid' && (
            <p className="text-xs text-destructive">{submitState.message}</p>
          )}
        </CardContent>
      </Card>

      {/* 离线队列（FIFO 清单；重放失败项保留并累加重试计数） */}
      <Card>
        <CardHeader>
          <CardTitle>离线队列</CardTitle>
          <CardDescription>
            本地待重放清单（严格按入队顺序发送；失败项保留重试）。{replaying ? '重放中…' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">队列为空。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-xs"
                >
                  <span className="font-mono">{item.ref}</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span>× {item.quantity}</span>
                    <span>{item.laborMinutes} 分钟</span>
                    <span>{new Date(item.submittedAt).toLocaleTimeString()}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {pending.length > 0 && (
            <div className="mt-3">
              <Button size="sm" variant="outline" className="h-11" disabled={replaying || online === false} onClick={() => void handleReplay()}>
                <RotateCw className="mr-1 size-3.5" />
                {replaying ? '重放中…' : '全部重放（FIFO）'}
              </Button>
              {online === false && <p className="mt-1 text-xs text-muted-foreground">离线中——恢复网络后可重放。</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
