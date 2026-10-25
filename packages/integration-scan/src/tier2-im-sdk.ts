/**
 * Tier2：IM JS-SDK 扫码桥端口（M1 增量 3-F）
 *
 * 具体厂商 SDK（企微 wx.scanCode / 飞书 tt.scanCode 等）属 integration-im
 * （ADR-0003 #6：integration-* 边缘包独占外部 SDK）。本包只定义抽象桥
 * ImScanBridge 并基于桥给出可运行的端口实现。
 *
 * 桥实现方向：integration-im（或组合根适配器）提供 ImScanBridge 实现，
 * 依赖箭头 integration-im → integration-scan（dep-cruiser 允许 integration
 * 互依）；本包零反向依赖、不触碰 integration-im。
 *
 * 语义：IM 原生扫码为模态单次交互。start() 唤起一次 scanOnce，产出一次
 * 结果或失败后会话即止（once 语义），再次 start() 重新唤起；不自动连环
 * 重扫（模态弹窗连开是坏 UX）。
 */
import { createScanCode, makeScanResult, type ScanResult } from './scan-result.js';
import { makeScanError, type ScanError, type ScannerPort } from './scanner-port.js';
import { createEmitter } from './internal/emitter.js';

/**
 * IM JS-SDK 扫码桥：本包定义，integration-im 侧实现。
 * scanOnce 成功 resolve 码文本；失败 reject（原因由实现方携带）。
 */
export interface ImScanBridge {
  /** 容器是否具备 JS-SDK 扫码能力（环境探测由桥实现方负责） */
  isAvailable(): boolean;
  /** 唤起一次 IM 原生扫码 */
  scanOnce(): Promise<string>;
}

export interface ImSdkScannerPort extends ScannerPort {
  readonly tier: 'tier2-im-sdk';
}

export interface ImSdkScannerOptions {
  /** 单次唤起超时（ms），默认 60_000 */
  readonly timeoutMs?: number;
  /** 时钟注入（毫秒），默认 Date.now；测试可替换 */
  readonly now?: () => number;
}

export const DEFAULT_IM_SCAN_TIMEOUT_MS = 60_000;

class ImScanTimeoutMarker extends Error {}

export function createImSdkScanner(
  bridge: ImScanBridge,
  options: ImSdkScannerOptions = {},
): ImSdkScannerPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IM_SCAN_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const results = createEmitter<ScanResult>();
  const errors = createEmitter<ScanError>();

  let session = 0;
  let running = false;

  /** 会话令牌守卫：stop / 重启后，旧异步产出一律丢弃 */
  function settle(sessionId: number, outcome: () => void): void {
    if (sessionId !== session || !running) return;
    running = false;
    outcome();
  }

  return {
    tier: 'tier2-im-sdk',
    start(): void {
      if (running) return;
      running = true;
      const sessionId = ++session;

      if (!bridge.isAvailable()) {
        settle(sessionId, () => {
          errors.emit(
            makeScanError('tier2-im-sdk', 'unavailable', 'im scan bridge reports container unavailable'),
          );
        });
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ImScanTimeoutMarker()), timeoutMs);
      });

      Promise.race([bridge.scanOnce(), guard])
        .then((text: string) => {
          if (timer !== undefined) clearTimeout(timer);
          settle(sessionId, () => {
            try {
              const code = createScanCode(text);
              results.emit(
                makeScanResult({
                  code,
                  tier: 'tier2-im-sdk',
                  scannedAt: new Date(now()).toISOString(),
                }),
              );
            } catch (cause) {
              errors.emit(
                makeScanError(
                  'tier2-im-sdk',
                  'decode-failed',
                  `im sdk returned an unusable code: ${String(cause)}`,
                  cause,
                ),
              );
            }
          });
        })
        .catch((cause: unknown) => {
          if (timer !== undefined) clearTimeout(timer);
          const timedOut = cause instanceof ImScanTimeoutMarker;
          settle(sessionId, () => {
            errors.emit(
              makeScanError(
                'tier2-im-sdk',
                timedOut ? 'timeout' : 'unknown',
                timedOut ? `im sdk scan timed out after ${timeoutMs}ms` : String(cause),
                cause,
              ),
            );
          });
        });
    },
    stop(): void {
      running = false;
      session++;
    },
    onResult(handler: (result: ScanResult) => void): () => void {
      return results.subscribe(handler);
    },
    onError(handler: (error: ScanError) => void): () => void {
      return errors.subscribe(handler);
    },
  };
}
