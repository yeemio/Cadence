/**
 * 大屏推送通道与 A10 日跑批调度（A8 首波，PRD 20 册 RREQ-RP-023/027）——
 * 零框架纯逻辑（无 Nest import，vitest 直测；Nest 装配归 screen-http.module）。
 *
 * == 通道形态取舍（RREQ-RP-023 待定项 OQ-8 的 Cadence 裁定，写明） ==
 * 源文档通道 = WebSocket（/ws/mes-screen/digital-operation，每 5 秒 Job 聚合
 * 全屏帧广播；客户端连上不主动发首帧）。Cadence 落地选 **SSE**（Server-Sent
 * Events）而非 WS，理由：
 *  1. 契约是纯下行广播（客户端不发任何消息——源契约明说首包只随调度周期对
 *     齐），SSE 的单向模型与契约完全同构；WS 的双向能力是死重。
 *  2. 零新依赖：@nestjs/platform-express 原生响应流即可写 SSE 帧；WS 需新增
 *     ws/@nestjs/websockets 平台包与升级握手路由，且与组合根中间件链
 *     （租户解析/错误处理）的交互面更大。
 *  3. 断连重连原生：EventSource 自带重连（retry 提示下行），满足验收口径
 *     「断连重连后至多一个周期内恢复」零客户端代码；WS 重连须手写。
 *  4. 反代友好：text/event-stream 过 HTTP/1.1 反代（X-Accel-Buffering: no
 *     已下行），与既有部署形态一致；wss 需额外的升级透传配置。
 * 差异登记：路径按 Cadence REST 面规约化（/screen/digital-operation/stream），
 * 不复刻源路径字面；消息体 = 源契约 JSON 信封（type=digital_operation.snapshot）
 * 原样下行，字段面零改。
 *
 * == 节拍取舍（RREQ-RP-023 源 Cron 0/5 * * * * ?） ==
 * 组合根内 setInterval 定时节拍（OQ-4 裁定：Cadence 无 XXL-Job，Nest 内置
 * 调度承接——进程内单定时器，无独立 job 进程）。帧聚合按**订阅租户集**收口：
 * 无订阅租户零聚合零 DB 读（大屏没人看时不空转）；新连接不触发即时聚合，
 * 至多等一个周期收首帧（源契约「首包至多与调度周期对齐」同语义）。
 *
 * == A10 日跑批节拍（RREQ-RP-027，OQ-6 缺省前一日） ==
 * setTimeout 链：每次对齐下一个 UTC 00:10（源文档"当日结束时点快照"取日后
 * 跨零点稳定时点；跑数日 = 跑批时刻的前一自然日，幂等 upsert 重跑无害）。
 * 停机漏跑不回补历史（日表可运维手工触发补——runOnce 导出即为此）。
 */
import { TenantId } from '@smes/business-core';
import type { MachiningDailyStatsService } from '@smes/application';
import type { DigitalOperationScreenService } from '@smes/application';

/** 源契约节拍：5 秒一帧（env/构造可覆盖——测试放大）。 */
export const SCREEN_FRAME_INTERVAL_MS_DEFAULT = 5_000;

/** A10 日跑批固定时点：UTC 00:10（跨零点后取昨日快照）。 */
export const MACHINING_DAILY_RUN_UTC = { hour: 0, minute: 10 } as const;

/** SSE 订阅者写面（Express Response 的最小结构子集——组合根不依赖 express 类型）。 */
export interface ScreenSseSink {
  /** 写一段已格式化的 SSE 输出（含结尾空行）。 */
  write(chunk: string): unknown;
}

/**
 * 帧广播器：租户 → SSE 订阅者集；定时节拍对每个有订阅者的租户聚合一帧
 * （DigitalOperationScreenService.buildFrame）并 JSON 下行。
 */
export class ScreenFrameBroadcaster {
  private readonly subscribers = new Map<string, Set<ScreenSseSink>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly screen: DigitalOperationScreenService,
    private readonly intervalMs: number = SCREEN_FRAME_INTERVAL_MS_DEFAULT,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 启动定时节拍（幂等——已启动则空操作）。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref(); // 不阻进程退出
    }
  }

  /** 停止节拍并清订阅（Nest onApplicationShutdown 调）。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.subscribers.clear();
  }

  /** 当前订阅租户数（健康观测/测试锚定）。 */
  get subscribedTenantCount(): number {
    return this.subscribers.size;
  }

  /**
   * 登记一个 SSE 订阅（租户在连接握手时由 TenantContext 解析）；返回撤销函数
   * （连接 close 时调）。不触发即时聚合——首帧随下一节拍。
   */
  subscribe(tenant: TenantId, sink: ScreenSseSink): () => void {
    const key = String(tenant);
    const set = this.subscribers.get(key) ?? new Set<ScreenSseSink>();
    set.add(sink);
    this.subscribers.set(key, set);
    return () => {
      const current = this.subscribers.get(key);
      if (current === undefined) return;
      current.delete(sink);
      if (current.size === 0) this.subscribers.delete(key);
    };
  }

  /**
   * 单次节拍：逐订阅租户聚合帧并下行。单租户失败不炸节拍（记结构化日志后
   * 继续下一租户；订阅端保持上一好帧——大屏是呈现面，短暂冻结优于断流）。
   */
  async tick(): Promise<void> {
    for (const [tenantKey, sinks] of this.subscribers) {
      try {
        const envelope = await this.screen.buildFrame(TenantId.create(tenantKey), this.now().toISOString());
        const frame = sseMessageOf(envelope);
        for (const sink of sinks) {
          try {
            sink.write(frame);
          } catch {
            // 写面已断（连接半开）：摘除该订阅者，等 close 事件兜底清理。
            sinks.delete(sink);
          }
        }
      } catch (error) {
        console.error(
          `[smes] screen frame aggregation failed (tenant=${tenantKey}):`,
          error instanceof Error ? error.message : error,
        );
      }
      if (sinks.size === 0) this.subscribers.delete(tenantKey);
    }
  }
}

/** 信封 → SSE 报文（默认 message 事件——EventSource onmessage 直收）。 */
export function sseMessageOf(envelope: unknown): string {
  return `data: ${JSON.stringify(envelope)}\n\n`;
}

/** SSE 流开头提示块（retry=3s 重连提示 + 注释行即刻刷出代理缓冲）。 */
export function ssePreamble(): string {
  return `retry: 3000\n: stream open\n\n`;
}

/**
 * A10 日跑批调度器：对齐下一 UTC 00:10 setTimeout 链；每轮对全部租户跑
 * runDaily（幂等 upsert）。missed-day 不回补（头注取舍）。
 */
export class MachiningDailyScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly daily: MachiningDailyStatsService,
    private readonly tenants: readonly TenantId[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 启动调度链（幂等）。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.scheduleNext();
  }

  /** 停止调度链（Nest onApplicationShutdown 调）。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    const delay = nextDailyRunAt(this.now()).getTime() - this.now().getTime();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((error: unknown) => {
          console.error(
            '[smes] machining daily stats run failed:',
            error instanceof Error ? error.message : error,
          );
        })
        .finally(() => this.scheduleNext());
    }, Math.max(0, delay));
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  /** 跑一轮（调度链与运维手工补数共用入口）：逐租户，单租户失败记日志继续。 */
  async runOnce(nowIso?: string): Promise<void> {
    for (const tenant of this.tenants) {
      try {
        await this.daily.runDaily(tenant, { now: nowIso ?? this.now().toISOString() });
      } catch (error) {
        console.error(
          `[smes] machining daily stats run failed (tenant=${String(tenant)}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}

/** 下一跑批时点（纯函数，测试锚定）：now 之后首个 UTC 00:10。 */
export function nextDailyRunAt(now: Date): Date {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      MACHINING_DAILY_RUN_UTC.hour,
      MACHINING_DAILY_RUN_UTC.minute,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
