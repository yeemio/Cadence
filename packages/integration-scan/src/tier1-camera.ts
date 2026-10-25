/**
 * Tier1：浏览器摄像头扫码适配器（html5-qrcode 懒加载，M1 收尾波-②）
 *
 * 依赖决策（本增量写明，替代 F 线"引入点顺延"占位）：html5-qrcode 2.3.8
 * （Apache-2.0，ADR-0007 复用白名单内）**真实引入**为本包运行时依赖，
 * 但仅经动态 import 懒加载——首次 start() 才加载模块并 memoize，此后
 * stop/start 复用不再触发加载；纯域使用方（降级决策 / 其他档位组合）零
 * 加载成本，组合根主 bundle 不含解码器（Vite/Rollup 对字面量 import()
 * 自动分块，故加载器中的说明符必须保持字面量）。
 *
 * 清洁室（ADR-0002）：本文件只认自持的结构子集形状（Html5QrcodeLike /
 * Html5QrcodeModuleLike / CameraScanTarget），SDK 类型不渗出本模块；
 * 真实包经默认加载器一次性结构兼容代入，测试注入 mock 模块（不真开摄像头）。
 *
 * 错误映射（对齐 capabilities.isDegradableScanError 的降级白名单语义）：
 * - 无 mediaDevices / 模块加载失败 / 相机缺失 / 被占用 / 约束不可满足
 *   → 'unavailable'（可降级）
 * - 授权被拒（NotAllowedError 等）→ 'permission-denied'（可降级）
 * - 解码噪声（有取景但连续解不出码）→ 'decode-failed'（不可降级），
 *   窗口节流：噪声持续 decodeFailureWindowMs 才首次上报，此后每
 *   decodeFailureIntervalMs 至多一次，成功解码即重置——避免逐帧错误
 *   淹没下游
 * - 其余启动失败 → 'unknown'（不可降级）
 *
 * 端口契约（scanner-port.ts）：start/stop 同步触发、幂等；异步产出一律经
 * 回调外抛；stop 之后零回调（会话令牌守卫丢弃旧异步产出）。
 */
import { createScanCode, makeScanResult, type ScanResult } from './scan-result.js';
import { makeScanError, type ScanError, type ScannerPort, type Unsubscribe } from './scanner-port.js';
import { createEmitter } from './internal/emitter.js';

/** 相机选择（getUserMedia facingMode 语义）：'environment' 后置（扫码惯例）/ 'user' 前置 */
export type CameraFacingMode = 'user' | 'environment';

/** start 目标：设备 id 或 facingMode 约束（MediaTrackConstraints 的结构子集） */
export type CameraScanTarget = string | { readonly facingMode?: CameraFacingMode };

/** html5-qrcode 实例的结构子集（本包自持形状；方法签名按 SDK 实参形状收窄） */
export interface Html5QrcodeLike {
  start(
    camera: CameraScanTarget,
    config: { readonly fps: number },
    onSuccess: (decodedText: string, result: unknown) => void,
    onError?: (message: string, error: unknown) => void,
  ): Promise<unknown>;
  stop(): Promise<void>;
  clear(): void;
}

/** html5-qrcode 模块的结构子集（懒加载产物）。第二参收窄为 SDK 可接受的结构子集，
 * 使真实模块类型可逆变兼容直接代入（不做 any/unknown 双跳转型）。 */
export interface Html5QrcodeModuleLike {
  readonly Html5Qrcode: new (
    elementId: string,
    configOrVerbose?: boolean | { readonly verbose: boolean | undefined },
  ) => Html5QrcodeLike;
}

/** 能力探测输入：带 mediaDevices.getUserMedia 的环境形状（navigator 的结构子集） */
export interface CameraSupportEnvironment {
  readonly mediaDevices?: {
    readonly getUserMedia?: unknown;
  };
}

/**
 * Tier1 能力探测（纯存在性检查）：navigator.mediaDevices.getUserMedia 是否
 * 为函数。非安全上下文（HTTP）与无相机 API 的环境（Node）均为 false。
 * 授权态不在探测范围（getUserMedia 只能在真正请求时得知），由错误映射兜住。
 */
export function hasCameraSupport(environment?: CameraSupportEnvironment): boolean {
  const scope: CameraSupportEnvironment | undefined =
    environment ?? (globalThis as { readonly navigator?: CameraSupportEnvironment }).navigator;
  return typeof scope?.mediaDevices?.getUserMedia === 'function';
}

export interface CameraScannerOptions {
  /** 视频渲染挂载点元素 id（html5-qrcode 要求传入元素 id） */
  readonly elementId: string;
  /** 相机选择，默认 'environment'（后置；桌面单摄像头按理想约束自动回落） */
  readonly facingMode?: CameraFacingMode;
  /** 扫描帧率，默认 10 */
  readonly fps?: number;
  /** 解码噪声首次上报前须持续的窗口（ms），默认 2_000 */
  readonly decodeFailureWindowMs?: number;
  /** 解码噪声两次上报的最小间隔（ms），默认 2_000 */
  readonly decodeFailureIntervalMs?: number;
  /** html5-qrcode 模块加载器注入（测试 mock 用）；默认动态 import 真实包 */
  readonly loadModule?: () => Promise<Html5QrcodeModuleLike>;
  /** 能力探测环境注入（测试用）；默认读 globalThis.navigator */
  readonly environment?: CameraSupportEnvironment;
  /** 时钟注入（毫秒），默认 Date.now */
  readonly now?: () => number;
}

/** Tier1 端口：摄像头连续扫码 */
export interface CameraScannerPort extends ScannerPort {
  readonly tier: 'tier1-camera';
}

const START_PERMISSION_NAME = /^(NotAllowedError|PermissionDeniedError|SecurityError)$/;
const START_PERMISSION_MESSAGE = /permission|not allowed|denied/i;
const START_UNAVAILABLE_NAME =
  /^(NotFoundError|DevicesNotFoundError|NotReadableError|TrackStartError|OverconstrainedError|SourceUnavailableError)$/;
const START_UNAVAILABLE_MESSAGE = /not ?found|no camera|in use|could not start|video source|track start|aborted/i;

function errorNameOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    const name = (cause as { readonly name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

function errorMessageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 启动失败 → 降级白名单语义的 ScanError（kind 决定可否降级） */
function classifyStartFailure(cause: unknown): ScanError {
  const name = errorNameOf(cause);
  const message = errorMessageOf(cause) || 'unknown camera start failure';
  if (START_PERMISSION_NAME.test(name) || START_PERMISSION_MESSAGE.test(message)) {
    return makeScanError('tier1-camera', 'permission-denied', `camera permission denied: ${message}`, cause);
  }
  if (START_UNAVAILABLE_NAME.test(name) || START_UNAVAILABLE_MESSAGE.test(message)) {
    return makeScanError('tier1-camera', 'unavailable', `camera unavailable: ${message}`, cause);
  }
  return makeScanError('tier1-camera', 'unknown', `camera failed to start: ${message}`, cause);
}

/** 默认加载器：动态 import 真实 html5-qrcode（字面量说明符 = 构建期分块依据） */
async function defaultLoadModule(): Promise<Html5QrcodeModuleLike> {
  const mod = await import('html5-qrcode');
  return { Html5Qrcode: mod.Html5Qrcode };
}

type Phase = 'idle' | 'loading' | 'starting' | 'running';

/**
 * Tier1 适配器：Html5Qrcode 封装为 ScannerPort。
 * 会话令牌（session）+ 相位门（phase）双守卫：stop 之后的旧异步产出一律丢弃，
 * 启动途中被 stop 抢先的相机流被静默关闭（不外抛任何回调）。
 */
export function createCameraScanner(options: CameraScannerOptions): CameraScannerPort {
  const {
    elementId,
    facingMode = 'environment',
    fps = 10,
    decodeFailureWindowMs = 2_000,
    decodeFailureIntervalMs = 2_000,
    now = Date.now,
  } = options;
  const loadModule = options.loadModule ?? defaultLoadModule;
  const supported = hasCameraSupport(options.environment);

  const results = createEmitter<ScanResult>();
  const errors = createEmitter<ScanError>();

  let phase: Phase = 'idle';
  let session = 0;
  let modulePromise: Promise<Html5QrcodeModuleLike> | undefined;
  let instance: Html5QrcodeLike | undefined;
  let noiseStartMs: number | null = null;
  let noiseLastEmitMs: number | null = null;

  function resetNoise(): void {
    noiseStartMs = null;
    noiseLastEmitMs = null;
  }

  function handleDecoded(text: string, guardSession: number): void {
    if (guardSession !== session || phase !== 'running') return;
    resetNoise();
    try {
      results.emit(
        makeScanResult({
          code: createScanCode(text),
          tier: 'tier1-camera',
          scannedAt: new Date(now()).toISOString(),
        }),
      );
    } catch (cause) {
      // 解出的文本不满足 ScanCode 约束（超长 / 控制字符）：归为解码失败噪声
      errors.emit(
        makeScanError('tier1-camera', 'decode-failed', `decoded text is not a usable scan code: ${String(cause)}`, cause),
      );
    }
  }

  function handleDecodeNoise(message: string, guardSession: number): void {
    if (guardSession !== session || phase !== 'running') return;
    const atMs = now();
    if (noiseStartMs === null) {
      noiseStartMs = atMs;
      return;
    }
    if (noiseLastEmitMs === null) {
      if (atMs - noiseStartMs < decodeFailureWindowMs) return;
      noiseLastEmitMs = atMs;
    } else if (atMs - noiseLastEmitMs < decodeFailureIntervalMs) {
      return;
    } else {
      noiseLastEmitMs = atMs;
    }
    errors.emit(makeScanError('tier1-camera', 'decode-failed', `continuous decode failure: ${message}`));
  }

  /** 静默拆除实例（已被 stop 抢先的会话）：成功与否都不外抛 */
  async function quietTeardown(target: Html5QrcodeLike): Promise<void> {
    try {
      await target.stop();
    } catch {
      // 相机未真正起起来就 stop 会拒绝（SDK 已知行为）：仍尝试清理画面
    }
    try {
      target.clear();
    } catch {
      // 挂载元素已卸载：无需清理
    }
  }

  async function beginStart(sessionId: number): Promise<void> {
    let mod: Html5QrcodeModuleLike;
    try {
      modulePromise ??= loadModule();
      mod = await modulePromise;
    } catch (cause) {
      if (sessionId === session) {
        phase = 'idle';
        errors.emit(
          makeScanError('tier1-camera', 'unavailable', 'failed to load the camera scanner module', cause),
        );
      }
      return;
    }
    if (sessionId !== session || phase !== 'loading') return; // stop 抢先：此刻尚无实例

    phase = 'starting';
    const started = new mod.Html5Qrcode(elementId);
    instance = started;
    try {
      await started.start(
        { facingMode },
        { fps },
        (decodedText) => handleDecoded(decodedText, sessionId),
        (message) => handleDecodeNoise(message, sessionId),
      );
    } catch (cause) {
      instance = undefined;
      if (sessionId !== session) return; // stop 抢先：启动失败即无相机流，无需清理
      phase = 'idle';
      errors.emit(classifyStartFailure(cause));
      return;
    }
    if (sessionId !== session) {
      // 启动成功但会话已被 stop 抢先：若 stop 尚未接管实例（防御路径），
      // 静默关闭相机流；已被 stop 拆除的不重复处理
      if (instance === started) {
        instance = undefined;
        void quietTeardown(started);
      }
      return;
    }
    phase = 'running';
  }

  return {
    tier: 'tier1-camera',
    start(): void {
      if (phase !== 'idle') return; // 幂等：挂起/运行中的重复 start 为无操作
      session += 1;
      resetNoise();

      if (!supported) {
        // 能力缺失（构造期探测）：不加载模块，直接可降级信号；相位停留
        // idle，链执行器应降级，重试留给出错后重建扫描器的接线层
        errors.emit(
          makeScanError(
            'tier1-camera',
            'unavailable',
            'camera api unavailable: navigator.mediaDevices.getUserMedia is missing',
          ),
        );
        return;
      }

      phase = 'loading';
      void beginStart(session);
    },
    stop(): void {
      if (phase === 'idle') return; // 幂等：从未 start / 已停止为无操作
      session += 1; // 旧会话令牌全部失配：挂起中的异步产出将被静默丢弃
      phase = 'idle';
      resetNoise();
      const target = instance;
      instance = undefined;
      if (target !== undefined) {
        void quietTeardown(target);
      }
    },
    onResult(handler: (result: ScanResult) => void): Unsubscribe {
      return results.subscribe(handler);
    },
    onError(handler: (error: ScanError) => void): Unsubscribe {
      return errors.subscribe(handler);
    },
  };
}
