import { describe, expect, it, vi } from 'vitest';
import {
  createImSdkScanner,
  type ImScanBridge,
  type ScanError,
  type ScanResult,
  type ScannerPort,
} from '../src/index.js';

/** 冲一个宏任务，让 Promise 链（race/then/catch）走完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Tier2 ImSdkScanner（桥端口，mock 桥实现）', () => {
  it('桥成功：产出 tier2 统一结果（无 deviceId），once 语义后可再次唤起', async () => {
    let calls = 0;
    const bridge: ImScanBridge = {
      isAvailable: () => true,
      scanOnce: () => {
        calls += 1;
        return Promise.resolve(`WO-${calls}`);
      },
    };
    const scanner = createImSdkScanner(bridge, { now: () => Date.UTC(2026, 9, 25, 10, 0, 0) });
    const port: ScannerPort = scanner; // 三档统一实现 ScannerPort（类型级证据）
    expect(port.tier).toBe('tier2-im-sdk');

    const results: ScanResult[] = [];
    scanner.onResult((result) => results.push(result));
    scanner.start();
    await flush();

    expect(results).toHaveLength(1);
    expect(results[0]?.code).toBe('WO-1');
    expect(results[0]?.tier).toBe('tier2-im-sdk');
    expect(results[0]?.scannedAt).toBe('2026-10-25T10:00:00.000Z');
    expect('deviceId' in (results[0] ?? {})).toBe(false);

    scanner.start(); // 会话已止（once），再次 start 重新唤起
    await flush();
    expect(results).toHaveLength(2);
    expect(results[1]?.code).toBe('WO-2');
  });

  it('桥不可用：同步报 unavailable（可降级信号）', async () => {
    const bridge: ImScanBridge = {
      isAvailable: () => false,
      scanOnce: () => Promise.reject(new Error('should not be called')),
    };
    const scanner = createImSdkScanner(bridge);
    const errors: ScanError[] = [];
    scanner.onError((error) => errors.push(error));
    scanner.start();
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tier: 'tier2-im-sdk', kind: 'unavailable' });
    expect(Object.isFrozen(errors[0])).toBe(true);
  });

  it('桥拒绝（用户取消等）：报 unknown 并携带 cause', async () => {
    const cause = new Error('user cancelled');
    const bridge: ImScanBridge = {
      isAvailable: () => true,
      scanOnce: () => Promise.reject(cause),
    };
    const scanner = createImSdkScanner(bridge);
    const errors: ScanError[] = [];
    scanner.onError((error) => errors.push(error));
    scanner.start();
    await flush();
    expect(errors[0]).toMatchObject({ tier: 'tier2-im-sdk', kind: 'unknown' });
    expect((errors[0]?.cause as Error).message).toBe('user cancelled');
  });

  it('SDK 返回不可用码文本（超长）：报 decode-failed', async () => {
    const bridge: ImScanBridge = {
      isAvailable: () => true,
      scanOnce: () => Promise.resolve('x'.repeat(2049)),
    };
    const scanner = createImSdkScanner(bridge);
    const errors: ScanError[] = [];
    scanner.onError((error) => errors.push(error));
    scanner.start();
    await flush();
    expect(errors[0]?.kind).toBe('decode-failed');
  });

  it('唤起超时：报 timeout', async () => {
    vi.useFakeTimers();
    try {
      const bridge: ImScanBridge = {
        isAvailable: () => true,
        scanOnce: () => new Promise<string>(() => {}),
      };
      const scanner = createImSdkScanner(bridge, { timeoutMs: 20 });
      const errors: ScanError[] = [];
      scanner.onError((error) => errors.push(error));
      scanner.start();
      await vi.advanceTimersByTimeAsync(21);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.kind).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop 后旧异步产出一律丢弃；start 幂等（挂起中不重复唤起）', async () => {
    let calls = 0;
    const bridge: ImScanBridge = {
      isAvailable: () => true,
      scanOnce: () => {
        calls += 1;
        return new Promise<string>(() => {});
      },
    };
    const scanner = createImSdkScanner(bridge, { timeoutMs: 60_000 });
    const seen: unknown[] = [];
    scanner.onResult((result) => seen.push(result));
    scanner.onError((error) => seen.push(error));

    scanner.start();
    scanner.start(); // 幂等：仍只有一次唤起
    expect(calls).toBe(1);

    scanner.stop();
    await flush();
    expect(seen).toHaveLength(0);
  });

  it('订阅可退订', async () => {
    const bridge: ImScanBridge = {
      isAvailable: () => true,
      scanOnce: () => Promise.resolve('WO-1'),
    };
    const scanner = createImSdkScanner(bridge);
    const seen: ScanResult[] = [];
    const unsubscribe = scanner.onResult((result) => seen.push(result));
    unsubscribe();
    scanner.start();
    await flush();
    expect(seen).toHaveLength(0);
  });
});
