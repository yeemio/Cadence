/**
 * 扫码器统一端口：三档共同形状（M1 增量 3-F，Done-when 2）
 *
 * 契约约定：
 * - start / stop 为同步触发、幂等；档位内部的异步过程（相机启动、IM SDK 唤起）
 *   由各适配器自理，产出一律经 onResult / onError 回调外抛，不用 Promise 拒绝
 *   外抛（单一信号通道，链执行器只需挂回调）。
 * - 回调收到的 ScanResult / ScanError 均为冻结快照（ADR-0003 #4 精神）。
 * - stop 之后不得再触发任何回调；重复 start / stop 为无操作。
 */
import type { ScanResult, ScannerTier } from './scan-result.js';

export type Unsubscribe = () => void;

export type ScanErrorKind =
  /** 档位能力缺失：设备 / 容器不可用、SDK 未就绪 */
  | 'unavailable'
  /** 权限被拒（摄像头授权等） */
  | 'permission-denied'
  /** 超时（SDK 唤起 / 串入段） */
  | 'timeout'
  /** 有采集过程但解不出码（相机连续解码失败） */
  | 'decode-failed'
  /** 输入形状坏（键盘串入坏段等） */
  | 'malformed-input'
  | 'unknown';

export interface ScanError {
  readonly tier: ScannerTier;
  readonly kind: ScanErrorKind;
  readonly message: string;
  readonly cause?: unknown;
}

export function makeScanError(
  tier: ScannerTier,
  kind: ScanErrorKind,
  message: string,
  cause?: unknown,
): ScanError {
  return Object.freeze<ScanError>({
    tier,
    kind,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function isScanError(value: unknown): value is ScanError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['tier'] === 'string' &&
    typeof candidate['kind'] === 'string' &&
    typeof candidate['message'] === 'string'
  );
}

/** 三档统一实现的扫码器端口 */
export interface ScannerPort {
  /** 本档位标识 */
  readonly tier: ScannerTier;
  /** 启动会话（幂等：已启动为无操作） */
  start(): void;
  /** 停止会话并释放资源（幂等） */
  stop(): void;
  /** 订阅解码结果，返回退订函数 */
  onResult(handler: (result: ScanResult) => void): Unsubscribe;
  /** 订阅失败信号，返回退订函数 */
  onError(handler: (error: ScanError) => void): Unsubscribe;
}
