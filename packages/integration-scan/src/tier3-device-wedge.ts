/**
 * Tier3：外设扫码枪（键盘串入）监听端口（M1 增量 3-F）
 *
 * 扫码枪工作在键盘模拟（wedge）模式：码值以高速按键串到达，可配前缀/后缀，
 * 以终结键（默认 Enter）收尾。解析由 wedge-parser 纯函数承担（含中断/超时
 * 拒绝）；本端口只做按键流接线。
 *
 * WedgeKeystrokeSource 抽象按键来源：DOM / WebView 监听器在 UI 接线增量实现
 * （KeyboardEvent.key + timeStamp 直接映射本接口），测试用假源注入。
 */
import { makeScanResult, type DeviceId, type ScanResult } from './scan-result.js';
import { makeScanError, type ScanError, type ScannerPort, type Unsubscribe } from './scanner-port.js';
import {
  nextWedgeParserState,
  type WedgeParserOptions,
  type WedgeParserState,
  type WedgeRejectReason,
} from './wedge-parser.js';
import { createEmitter } from './internal/emitter.js';

export interface WedgeKeystrokeSource {
  /**
   * 挂接按键流：key 为字符本身或键名（终结键默认 'Enter'）；atMs 为事件
   * 时间戳（ms）。返回退订函数。
   */
  onKeyStroke(handler: (key: string, atMs: number) => void): Unsubscribe;
}

export interface DeviceWedgeScannerPort extends ScannerPort {
  readonly tier: 'tier3-device-wedge';
}

export interface DeviceWedgeScannerOptions {
  /** 串入解析配置，默认 DEFAULT_WEDGE_PARSER_OPTIONS */
  readonly parser?: WedgeParserOptions;
  /** 本外设 / 终端标识（进 ScanResult.deviceId） */
  readonly deviceId?: DeviceId;
  /** 时钟注入（毫秒），默认 Date.now */
  readonly now?: () => number;
}

const TIMEOUT_WEDGE_REASONS: ReadonlySet<WedgeRejectReason> = new Set(['gap-timeout', 'burst-timeout']);

export function createDeviceWedgeScanner(
  source: WedgeKeystrokeSource,
  options: DeviceWedgeScannerOptions = {},
): DeviceWedgeScannerPort {
  const parserOptions = options.parser;
  const deviceId = options.deviceId;
  const now = options.now ?? Date.now;
  const results = createEmitter<ScanResult>();
  const errors = createEmitter<ScanError>();

  let state: WedgeParserState | null = null;
  let unsubscribe: Unsubscribe | undefined;

  return {
    tier: 'tier3-device-wedge',
    start(): void {
      if (unsubscribe !== undefined) return;
      state = null;
      unsubscribe = source.onKeyStroke((key, atMs) => {
        const step = nextWedgeParserState(state, { key, atMs }, parserOptions);
        state = step.state;
        if (step.event.type === 'accepted') {
          results.emit(
            makeScanResult({
              code: step.event.code,
              tier: 'tier3-device-wedge',
              scannedAt: new Date(now()).toISOString(),
              ...(deviceId === undefined ? {} : { deviceId }),
            }),
          );
        } else if (step.event.type === 'rejected') {
          const kind = TIMEOUT_WEDGE_REASONS.has(step.event.reason) ? 'timeout' : 'malformed-input';
          errors.emit(
            makeScanError('tier3-device-wedge', kind, `wedge burst rejected: ${step.event.reason}`),
          );
        }
      });
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
      state = null;
    },
    onResult(handler: (result: ScanResult) => void): Unsubscribe {
      return results.subscribe(handler);
    },
    onError(handler: (error: ScanError) => void): Unsubscribe {
      return errors.subscribe(handler);
    },
  };
}
