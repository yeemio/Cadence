import { describe, expect, it } from 'vitest';
import {
  createDeviceId,
  createDeviceWedgeScanner,
  type DeviceWedgeScannerPort,
  type ScanError,
  type ScanResult,
  type ScannerPort,
  type Unsubscribe,
  type WedgeKeystrokeSource,
} from '../src/index.js';

/** 假按键源：手动发按键（key, atMs），可观测订阅数 */
function fakeSource(): {
  emit(key: string, atMs: number): void;
  readonly subscriberCount: number;
  source: WedgeKeystrokeSource;
} {
  const handlers = new Set<(key: string, atMs: number) => void>();
  return {
    emit(key: string, atMs: number): void {
      for (const handler of [...handlers]) handler(key, atMs);
    },
    get subscriberCount(): number {
      return handlers.size;
    },
    source: {
      onKeyStroke: (handler: (key: string, atMs: number) => void): Unsubscribe => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
  };
}

function emitBurst(
  fake: { emit(key: string, atMs: number): void },
  text: string,
  startMs: number,
  stepMs = 5,
  terminator = 'Enter',
): void {
  let at = startMs;
  for (const ch of text) {
    fake.emit(ch, at);
    at += stepMs;
  }
  fake.emit(terminator, at);
}

describe('Tier3 DeviceWedgeScanner（键盘串入监听端口，mock 按键源）', () => {
  it('高速串入 + 回车终结：产出 tier3 统一结果（含 deviceId）', () => {
    const fake = fakeSource();
    const deviceId = createDeviceId('wedge-01');
    const scanner = createDeviceWedgeScanner(fake.source, {
      deviceId,
      now: () => 1_800_000_000_000,
    });
    const port: ScannerPort = scanner; // 三档统一实现 ScannerPort（类型级证据）
    const wedgePort: DeviceWedgeScannerPort = scanner;
    expect(port.tier).toBe('tier3-device-wedge');
    expect(wedgePort.tier).toBe('tier3-device-wedge');

    const results: ScanResult[] = [];
    scanner.onResult((result) => results.push(result));
    scanner.start();
    emitBurst(fake, 'WO-1', 0);

    expect(results).toHaveLength(1);
    expect(results[0]?.code).toBe('WO-1');
    expect(results[0]?.tier).toBe('tier3-device-wedge');
    expect(results[0]?.deviceId).toBe('wedge-01');
    expect(results[0]?.scannedAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(Object.isFrozen(results[0])).toBe(true);
  });

  it('串入中断报 timeout 错误，随后新段仍可被接受', () => {
    const fake = fakeSource();
    const scanner = createDeviceWedgeScanner(fake.source);
    const results: ScanResult[] = [];
    const errors: ScanError[] = [];
    scanner.onResult((result) => results.push(result));
    scanner.onError((error) => errors.push(error));
    scanner.start();

    fake.emit('1', 0);
    fake.emit('2', 5);
    fake.emit('3', 400); // gap 395ms > 50：中断
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tier: 'tier3-device-wedge', kind: 'timeout' });

    emitBurst(fake, 'WO-2', 500);
    expect(results).toHaveLength(1);
    expect(results[0]?.code).toBe('WO-2');
  });

  it('坏形状段（前缀偏离）报 malformed-input', () => {
    const fake = fakeSource();
    const scanner = createDeviceWedgeScanner(fake.source, { parser: { prefix: 'AB' } });
    const errors: ScanError[] = [];
    scanner.onError((error) => errors.push(error));
    scanner.start();
    fake.emit('X', 0);
    expect(errors[0]).toMatchObject({ kind: 'malformed-input' });
    expect(errors[0]?.message).toContain('prefix-mismatch');
  });

  it('stop 退订按键源且不再产出；start 幂等（只挂一个监听）', () => {
    const fake = fakeSource();
    const scanner = createDeviceWedgeScanner(fake.source);
    const results: ScanResult[] = [];
    scanner.onResult((result) => results.push(result));
    scanner.start();
    scanner.start();
    expect(fake.subscriberCount).toBe(1);
    scanner.stop();
    scanner.stop();
    expect(fake.subscriberCount).toBe(0);
    emitBurst(fake, 'WO-3', 0);
    expect(results).toHaveLength(0);
  });

  it('多订阅者都收到；退订后不再收', () => {
    const fake = fakeSource();
    const scanner = createDeviceWedgeScanner(fake.source);
    const first: ScanResult[] = [];
    const second: ScanResult[] = [];
    const unsubscribeFirst = scanner.onResult((result) => first.push(result));
    scanner.onResult((result) => second.push(result));
    scanner.start();

    emitBurst(fake, 'WO-4', 0);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    unsubscribeFirst();
    emitBurst(fake, 'WO-5', 100);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });
});
