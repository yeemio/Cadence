/**
 * Tier1 CameraScanner 适配器单测（M1 收尾波-②）：
 * 注入 mock html5-qrcode 模块（不真开摄像头）覆盖——
 * 懒加载只发生一次 / start-stop 生命周期与幂等 / 错误映射（降级白名单语义）/
 * 解码噪声窗口节流 / 无 mediaDevices 时构造即 unavailable / 会话令牌守卫。
 */
import { describe, expect, it } from 'vitest';
import {
  createCameraScanner,
  hasCameraSupport,
  type CameraScanTarget,
  type Html5QrcodeModuleLike,
  type ScanError,
  type ScanResult,
  type ScannerPort,
} from '../src/index.js';

/** 冲一个宏任务，让加载/启动 Promise 链走完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeCamera {
  readonly elementId: string;
  startCalls: number;
  stopCalls: number;
  clearCalls: number;
  camera: CameraScanTarget | undefined;
  config: { readonly fps: number } | undefined;
  success: ((decodedText: string, result: unknown) => void) | undefined;
  noise: ((message: string, error: unknown) => void) | undefined;
}

/** mock html5-qrcode 模块：记录每轮实例的全部交互 */
function createFakeModule() {
  const cameras: FakeCamera[] = [];
  let nextStartBehavior: (camera: FakeCamera) => Promise<unknown> = () => Promise.resolve(null);
  const module: Html5QrcodeModuleLike = {
    Html5Qrcode: class {
      private readonly camera: FakeCamera;
      constructor(elementId: string) {
        this.camera = {
          elementId,
          startCalls: 0,
          stopCalls: 0,
          clearCalls: 0,
          camera: undefined,
          config: undefined,
          success: undefined,
          noise: undefined,
        };
        cameras.push(this.camera);
      }
      start(
        camera: CameraScanTarget,
        config: { readonly fps: number },
        success: (decodedText: string, result: unknown) => void,
        noise?: (message: string, error: unknown) => void,
      ): Promise<unknown> {
        const target = this.camera;
        target.camera = camera;
        target.config = config;
        target.success = success;
        target.noise = noise;
        target.startCalls += 1;
        return nextStartBehavior(target);
      }
      stop(): Promise<void> {
        this.camera.stopCalls += 1;
        return Promise.resolve();
      }
      clear(): void {
        this.camera.clearCalls += 1;
      }
    },
  };
  return {
    module,
    cameras,
    /** 设定下一轮实例 start() 的行为（默认立即成功） */
    onStart(behavior: (camera: FakeCamera) => Promise<unknown>): void {
      nextStartBehavior = behavior;
    },
  };
}

const MEDIA_ENV = { mediaDevices: { getUserMedia: () => Promise.resolve() } };
const FIXED_NOW = () => Date.UTC(2026, 9, 25, 10, 0, 0);

function createHarness(overrides: Partial<Parameters<typeof createCameraScanner>[0]> = {}) {
  const fake = createFakeModule();
  let loads = 0;
  const results: ScanResult[] = [];
  const errors: ScanError[] = [];
  const scanner = createCameraScanner({
    elementId: 'scan-video',
    loadModule: () => {
      loads += 1;
      return Promise.resolve(fake.module);
    },
    environment: MEDIA_ENV,
    now: FIXED_NOW,
    ...overrides,
  });
  scanner.onResult((result) => results.push(result));
  scanner.onError((error) => errors.push(error));
  return { fake, scanner, results, errors, loadCount: () => loads };
}

describe('hasCameraSupport（能力探测，结构化输入）', () => {
  it('mediaDevices.getUserMedia 为函数 → true；缺失 / 非函数 → false', () => {
    expect(hasCameraSupport({ mediaDevices: { getUserMedia: () => Promise.resolve() } })).toBe(true);
    expect(hasCameraSupport({})).toBe(false);
    expect(hasCameraSupport({ mediaDevices: {} })).toBe(false);
    expect(hasCameraSupport({ mediaDevices: { getUserMedia: 'not-a-function' } })).toBe(false);
  });
});

describe('CameraScanner 懒加载与生命周期', () => {
  it('懒加载只发生一次：首次 start 才加载并 memoize；stop 后重启复用模块（新实例）', async () => {
    const h = createHarness();
    expect(h.loadCount()).toBe(0); // 构造不加载
    h.scanner.start();
    expect(h.loadCount()).toBe(1); // 首次 start 加载
    await flush();
    h.scanner.stop();
    await flush();
    h.scanner.start();
    await flush();
    expect(h.loadCount()).toBe(1); // memoize：不重复加载
    expect(h.fake.cameras).toHaveLength(2); // 每轮新实例（旧画面已 clear）
    expect(h.fake.cameras[0]?.stopCalls).toBe(1);
    expect(h.fake.cameras[0]?.clearCalls).toBe(1);
  });

  it('解码成功 → 统一 ScanResult（冻结、tier、注入时钟）；start 参数正确（facingMode/fps）', async () => {
    const h = createHarness({ facingMode: 'user', fps: 5 });
    h.scanner.start();
    await flush();
    const camera = h.fake.cameras[0];
    expect(camera?.elementId).toBe('scan-video');
    expect(camera?.camera).toEqual({ facingMode: 'user' });
    expect(camera?.config).toEqual({ fps: 5 });

    camera?.success?.('WO-2026-001', undefined);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({
      code: 'WO-2026-001',
      tier: 'tier1-camera',
      scannedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(Object.isFrozen(h.results[0])).toBe(true);
    expect('deviceId' in (h.results[0] ?? {})).toBe(false);
  });

  it('start/stop 幂等；stop 之后零回调', async () => {
    const h = createHarness();
    h.scanner.start();
    h.scanner.start(); // 幂等：仍只有一次加载与一次实例 start
    await flush();
    expect(h.loadCount()).toBe(1);
    expect(h.fake.cameras).toHaveLength(1);
    expect(h.fake.cameras[0]?.startCalls).toBe(1);

    h.scanner.stop();
    h.scanner.stop(); // 幂等：不重复 stop
    await flush();
    expect(h.fake.cameras[0]?.stopCalls).toBe(1);

    h.fake.cameras[0]?.success?.('AFTER-STOP', undefined);
    h.fake.cameras[0]?.noise?.('parse error', undefined);
    expect(h.results).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it('实现三档统一 ScannerPort（类型级证据：赋值即编译）', () => {
    const h = createHarness();
    const port: ScannerPort = h.scanner;
    expect(port.tier).toBe('tier1-camera');
  });
});

describe('CameraScanner 错误映射（降级白名单语义）', () => {
  it('无 mediaDevices：构造期探测缺失，start 不加载模块即报 unavailable', () => {
    const h = createHarness({ environment: {} });
    h.scanner.start();
    expect(h.loadCount()).toBe(0); // 能力缺失不加载模块
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ tier: 'tier1-camera', kind: 'unavailable' });
    expect(Object.isFrozen(h.errors[0])).toBe(true);
  });

  it('授权被拒（NotAllowedError / 权限文案）→ permission-denied（可降级）', async () => {
    const h = createHarness();
    const cause = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    h.fake.onStart(() => Promise.reject(cause));
    h.scanner.start();
    await flush();
    expect(h.errors[0]).toMatchObject({ kind: 'permission-denied' });
    expect((h.errors[0]?.cause as Error).message).toBe('Permission denied');
  });

  it('相机缺失（NotFoundError）/ 被占用（NotReadableError）→ unavailable（可降级）', async () => {
    for (const name of ['NotFoundError', 'NotReadableError']) {
      const h = createHarness();
      h.fake.onStart(() => Promise.reject(Object.assign(new Error('boom'), { name })));
      h.scanner.start();
      await flush();
      expect(h.errors[0]?.kind, name).toBe('unavailable');
      expect(h.errors[0]?.tier).toBe('tier1-camera');
    }
  });

  it('文案兜底：SDK 抛字符串错误也能按文案归类', async () => {
    const h = createHarness();
    h.fake.onStart(() => Promise.reject('Could not start video source'));
    h.scanner.start();
    await flush();
    expect(h.errors[0]?.kind).toBe('unavailable');
  });

  it('其余失败 → unknown（不可降级）；模块加载失败 → unavailable', async () => {
    const h = createHarness();
    h.fake.onStart(() => Promise.reject(new Error('something odd')));
    h.scanner.start();
    await flush();
    expect(h.errors[0]?.kind).toBe('unknown');

    const h2 = createHarness({
      loadModule: () => Promise.reject(new Error('network offline')),
    });
    h2.scanner.start();
    await flush();
    expect(h2.errors[0]).toMatchObject({ kind: 'unavailable' });
    expect((h2.errors[0]?.cause as Error).message).toBe('network offline');
  });
});

describe('CameraScanner 解码噪声节流（decode-failed，不可降级）', () => {
  it('窗口内不报；满窗首次报；间隔内不重复；成功解码重置窗口', async () => {
    let clock = 0;
    const h = createHarness({ now: () => clock, decodeFailureWindowMs: 2000, decodeFailureIntervalMs: 2000 });
    h.scanner.start();
    await flush();
    const noise = h.fake.cameras[0]?.noise;
    expect(noise).toBeTypeOf('function');

    clock = 0;
    noise?.('QR code parse error', undefined); // 首帧噪声：起窗，不上报
    expect(h.errors).toHaveLength(0);
    clock = 1999;
    noise?.('QR code parse error', undefined);
    expect(h.errors).toHaveLength(0);
    clock = 2000;
    noise?.('QR code parse error', undefined); // 满窗：首次上报
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ kind: 'decode-failed' });
    clock = 3000;
    noise?.('QR code parse error', undefined); // 间隔内：不重复
    expect(h.errors).toHaveLength(1);
    clock = 4000;
    noise?.('QR code parse error', undefined); // 满间隔：再报一次
    expect(h.errors).toHaveLength(2);

    h.fake.cameras[0]?.success?.('WO-2026-002', undefined); // 成功重置
    expect(h.results[0]?.code).toBe('WO-2026-002');
    clock = 4001;
    noise?.('QR code parse error', undefined); // 重新起窗
    expect(h.errors).toHaveLength(2);
    clock = 6001;
    noise?.('QR code parse error', undefined); // 新窗满：上报
    expect(h.errors).toHaveLength(3);
  });

  it('解出文本不满足 ScanCode 约束（控制字符 / 超长）→ decode-failed', async () => {
    const h = createHarness();
    h.scanner.start();
    await flush();
    h.fake.cameras[0]?.success?.('bad\u0001code', undefined);
    h.fake.cameras[0]?.success?.('x'.repeat(2049), undefined);
    expect(h.results).toHaveLength(0);
    expect(h.errors.map((error) => error.kind)).toEqual(['decode-failed', 'decode-failed']);
  });
});

describe('CameraScanner 会话令牌守卫（stop 抢先挂起中的异步）', () => {
  it('模块加载途中 stop：加载完成后不建实例、零回调', async () => {
    const fake = createFakeModule();
    let release: (() => void) | undefined;
    const scanner = createCameraScanner({
      elementId: 'v',
      environment: MEDIA_ENV,
      loadModule: () =>
        new Promise((resolve) => {
          release = () => resolve(fake.module);
        }),
    });
    const seen: unknown[] = [];
    scanner.onResult((result) => seen.push(result));
    scanner.onError((error) => seen.push(error));

    scanner.start();
    scanner.stop(); // 加载挂起中抢先 stop
    release?.();
    await flush();
    expect(fake.cameras).toHaveLength(0); // 未创建实例
    expect(seen).toHaveLength(0);
  });

  it('相机启动途中 stop：启动完成后相机流被静默关闭、零回调', async () => {
    const fake = createFakeModule();
    let release: (() => void) | undefined;
    fake.onStart(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    const scanner = createCameraScanner({
      elementId: 'v',
      environment: MEDIA_ENV,
      loadModule: () => Promise.resolve(fake.module),
    });
    const seen: unknown[] = [];
    scanner.onResult((result) => seen.push(result));
    scanner.onError((error) => seen.push(error));

    scanner.start();
    await flush(); // 进入 starting（start Promise 挂起）
    scanner.stop(); // 启动挂起中抢先 stop
    release?.();
    await flush();
    await flush();
    const camera = fake.cameras[0];
    expect(camera?.stopCalls).toBe(1); // 已起的相机流被静默关闭
    expect(camera?.clearCalls).toBe(1);
    camera?.success?.('STALE', undefined);
    expect(seen).toHaveLength(0);
  });
});
