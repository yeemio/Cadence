/**
 * 扫码页（M1 收尾波-②）：三档降级链的真实 Web 组合根。
 *
 * M5 预研：扫码段装配（能力探测/降级链/扫码器生命周期/同码去抖/串入噪声
 * 提示）抽出为同目录 `useScanSession`——本页与扫码报工页共用，不复制实现。
 * 页面职责收敛为纯渲染：容器横幅、档位切换、视频区/扫码枪占位、结果列表。
 *
 * - Tier1 摄像头：html5-qrcode 懒加载适配器挂视频区元素
 * - Tier3 扫码枪：window keydown 串入（wedge 解析器在边缘包内消费）
 * - 降级 UX：一档失败自动降二档提示（降级历史条）；链耗尽提示人工兜底
 * - IM 容器探测横幅：顶部一行显示当前容器态
 */
import { useState } from 'react';
import { QrCode, ScanLine, VideoOff } from 'lucide-react';
import { detectImContainer } from '@smes/product-ui';
import type { ImContainerKind } from '@smes/product-ui';
import type { ScannerTier } from '@smes/integration-scan';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { SCAN_TIER_LABELS, SCAN_VIDEO_ELEMENT_ID, useScanSession } from './useScanSession';

const TIER_LABELS: Record<ScannerTier, string> = SCAN_TIER_LABELS;

const CONTAINER_BANNER: Record<ImContainerKind, string> = {
  browser: '当前容器：浏览器（未检测到 IM 容器）',
  wecom: '当前容器：企业微信（原生扫码桥未接入，接线后自动进降级链）',
  feishu: '当前容器：飞书（原生扫码桥未接入，接线后自动进降级链）',
};

export function ScanPage() {
  // 容器探测横幅（一次性，进入页面时探测）
  const [container] = useState(() =>
    detectImContainer({
      userAgent: navigator.userAgent,
      hasWecomJsApi: (window as { wx?: unknown }).wx !== undefined,
      hasFeishuJsApi: (window as { tt?: unknown }).tt !== undefined,
    }),
  );

  const { model, session, wedgeHint } = useScanSession();

  if (model === null || session === null) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>扫码</CardTitle>
          <CardDescription>无可用的扫码方式（摄像头 / 扫码枪均不可用），请联系管理员。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const latestDegradation = session.degradations[session.degradations.length - 1] ?? null;
  const active = session.status === 'active';
  const currentTier = session.currentTier;

  return (
    <div className="flex flex-col gap-4">
      {/* IM 容器探测横幅（一行，仅识别与展示） */}
      <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground">
        <ScanLine className="size-3.5 shrink-0" />
        {CONTAINER_BANNER[container]}
      </div>

      {/* 降级提示条：一档失败自动降二档；链耗尽转人工兜底 */}
      {latestDegradation !== null && session.status !== 'exhausted' && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          「{TIER_LABELS[latestDegradation.fromTier]}」不可用（{latestDegradation.error.message}），已自动切换到「
          {latestDegradation.toTier !== null ? TIER_LABELS[latestDegradation.toTier] : '无可用档位'}」
        </div>
      )}
      {session.status === 'exhausted' && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          全部扫码档位不可用（{session.lastError?.message ?? '链耗尽'}）。可点击下方「重新开始」从首选档重试，或改用人工输入。
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>扫码采集</CardTitle>
          <CardDescription>
            档位按能力探测自动选择（摄像头 → 扫码枪），失败自动降级；也可手动切换。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted-foreground" htmlFor="scan-tier">
              档位
            </label>
            <select
              id="scan-tier"
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
              value={currentTier ?? undefined}
              disabled={active}
              onChange={(event) => {
                const tier = event.target.value as ScannerTier;
                if (session.tiers.includes(tier)) model.switchTier(tier);
              }}
            >
              {session.tiers.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </option>
              ))}
            </select>
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
              <span className="text-xs text-muted-foreground">正在使用「{TIER_LABELS[currentTier]}」…</span>
            )}
          </div>

          {/* 摄像头模式：视频区占位 + html5-qrcode 挂载点 */}
          {currentTier === 'tier1-camera' && (
            <div className="relative overflow-hidden rounded-lg border bg-muted/60" style={{ aspectRatio: '4 / 3' }}>
              <div id={SCAN_VIDEO_ELEMENT_ID} className="h-full w-full [&>video]:h-full [&>video]:w-full [&>video]:object-cover" />
              {!active && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <VideoOff className="size-6" />
                  摄像头未启动——点击「开始扫码」授权并取景
                </div>
              )}
            </div>
          )}

          {/* 扫码枪模式：页面焦点监听键盘串入 */}
          {currentTier === 'tier3-device-wedge' && (
            <div
              className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-10 text-sm text-muted-foreground',
                active ? 'border-primary/50 bg-primary/5 text-primary' : 'bg-muted/60',
              )}
            >
              <QrCode className="size-6" />
              {active
                ? '扫码枪就绪：保持本页面焦点，对准条码/二维码扫描，码值自动出现在下方结果列表'
                : '扫码枪模式未启动——点击「开始扫码」开始监听'}
            </div>
          )}
          {wedgeHint !== null && currentTier === 'tier3-device-wedge' && (
            <p className="text-xs text-muted-foreground">{wedgeHint}</p>
          )}

          {/* 不可降级错误提示（解码噪声等，会话不中断） */}
          {active && session.lastError !== null && currentTier === 'tier1-camera' && (
            <p className="text-xs text-muted-foreground">提示：{session.lastError.message}（正在取景，尚未识别到可用的码）</p>
          )}
        </CardContent>
      </Card>

      {/* 最近结果：即 ScanResult 卡片列表 */}
      <Card>
        <CardHeader>
          <CardTitle>最近结果</CardTitle>
          <CardDescription>最近 {session.recentResults.length} 条解码产出（新在后，同码 1.5s 内去重）。</CardDescription>
        </CardHeader>
        <CardContent>
          {session.recentResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无结果。启动后扫到的码会实时出现在这里。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {[...session.recentResults].reverse().map((result, index) => (
                <li
                  key={`${result.scannedAt}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2"
                >
                  <span className="break-all font-mono text-sm">{result.code}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded border bg-muted px-1.5 py-0.5">{TIER_LABELS[result.tier]}</span>
                    {new Date(result.scannedAt).toLocaleTimeString()}
                    {result.deviceId !== undefined && <span>{result.deviceId}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
