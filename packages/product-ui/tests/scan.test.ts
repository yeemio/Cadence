/**
 * 扫码会话视图模型 + IM 容器识别单测（M1 收尾波-②）。
 * 模型为泛型纯状态机：测试用本地最小档位/错误形状钉死语义；
 * 与 integration-scan 真实形状的结构兼容接线证明在 apps/web 测试
 * （本包不得依赖 integration-*，ADR-0011）。
 */
import { describe, expect, it } from 'vitest';
import {
  detectImContainer,
  createScanSessionModel,
  SCAN_READ,
  type ImContainerKind,
  type ScanSessionState,
} from '../src/index.js';

type Tier = 'camera' | 'wedge';
interface FakeResult {
  readonly code: string;
}
interface FakeError {
  readonly kind: 'unavailable' | 'permission-denied' | 'decode-failed';
  readonly message: string;
}

const DEGRADABLE: ReadonlySet<FakeError['kind']> = new Set(['unavailable', 'permission-denied']);
const isDegradable = (error: FakeError): boolean => DEGRADABLE.has(error.kind);

function createModel(tiers: readonly Tier[] = ['camera', 'wedge']) {
  return createScanSessionModel<Tier, FakeResult, FakeError>({
    tiers,
    isDegradableError: isDegradable,
  });
}

const err = (kind: FakeError['kind']): FakeError => ({ kind, message: `${kind}!` });

describe('createScanSessionModel 构造校验', () => {
  it('空链 / 重复档位 / 非法容量抛错', () => {
    expect(() => createModel([])).toThrow();
    expect(() => createModel(['camera', 'camera'])).toThrow();
    expect(() =>
      createScanSessionModel<Tier, FakeResult, FakeError>({
        tiers: ['camera'],
        isDegradableError: isDegradable,
        maxRecentResults: 0,
      }),
    ).toThrow();
  });
});

describe('ScanSessionModel 会话状态机', () => {
  it('初始快照：idle、链首档、空历史/结果、无错误；快照冻结', () => {
    const model = createModel();
    const state = model.getState();
    expect(state).toMatchObject({ status: 'idle', currentTier: 'camera' });
    expect(state.tiers).toEqual(['camera', 'wedge']);
    expect(state.degradations).toEqual([]);
    expect(state.recentResults).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('start/stop 往返：idle → active → stopped → active（档位保持）', () => {
    const model = createModel();
    const seen: ScanSessionStatusLog = [];
    model.subscribe((state) => seen.push(state.status));
    model.start();
    expect(model.getState().status).toBe('active');
    model.stop();
    model.stop(); // 幂等
    expect(model.getState().status).toBe('stopped');
    model.start();
    expect(model.getState().status).toBe('active');
    expect(model.getState().currentTier).toBe('camera');
    expect(seen).toEqual(['active', 'stopped', 'active']);
  });

  it('pushResult：入列、容量截断丢弃最旧', () => {
    const model = createScanSessionModel<Tier, FakeResult, FakeError>({
      tiers: ['camera'],
      isDegradableError: isDegradable,
      maxRecentResults: 3,
    });
    for (let i = 1; i <= 5; i += 1) {
      model.pushResult({ code: `C-${i}` });
    }
    expect(model.getState().recentResults.map((result) => result.code)).toEqual(['C-3', 'C-4', 'C-5']);
  });

  it('可降级错误：自动换档 + 追加降级历史；链耗尽转 exhausted；重启回链首', () => {
    const model = createModel();
    model.start();
    model.pushError(err('permission-denied'));
    const degraded = model.getState();
    expect(degraded.status).toBe('active');
    expect(degraded.currentTier).toBe('wedge');
    expect(degraded.degradations).toHaveLength(1);
    expect(degraded.degradations[0]).toMatchObject({ fromTier: 'camera', toTier: 'wedge' });
    expect(degraded.lastError?.kind).toBe('permission-denied');

    model.pushError(err('unavailable')); // 链上再无档
    const exhausted = model.getState();
    expect(exhausted.status).toBe('exhausted');
    expect(exhausted.degradations[1]).toMatchObject({ fromTier: 'wedge', toTier: null });

    model.start(); // 耗尽后重启：回链首，历史保留
    const restarted = model.getState();
    expect(restarted.status).toBe('active');
    expect(restarted.currentTier).toBe('camera');
    expect(restarted.degradations).toHaveLength(2);
  });

  it('不可降级错误（decode-failed）：只记 lastError，档位/状态不动', () => {
    const model = createModel();
    model.start();
    model.pushError(err('decode-failed'));
    const state = model.getState();
    expect(state.status).toBe('active');
    expect(state.currentTier).toBe('camera');
    expect(state.degradations).toHaveLength(0);
    expect(state.lastError?.kind).toBe('decode-failed');
  });

  it('switchTier：链内换档生效；链外抛错；不隐式启动；耗尽态换档解锁为 idle', () => {
    const model = createModel();
    model.switchTier('wedge'); // idle 下只改选择
    expect(model.getState()).toMatchObject({ status: 'idle', currentTier: 'wedge' });
    expect(() => model.switchTier('camera' as Tier)).not.toThrow();
    expect(() => model.switchTier('im-sdk' as unknown as Tier)).toThrow();

    model.start();
    model.switchTier('wedge'); // 扫描中切到链尾
    model.pushError(err('unavailable')); // wedge 是链尾 → exhausted
    expect(model.getState().status).toBe('exhausted');
    model.switchTier('camera');
    expect(model.getState()).toMatchObject({ status: 'idle', currentTier: 'camera' });
  });

  it('订阅退订后不再收快照', () => {
    const model = createModel();
    const seen: string[] = [];
    const unsubscribe = model.subscribe((state) => seen.push(state.status));
    model.start();
    unsubscribe();
    model.stop();
    expect(seen).toEqual(['active']);
  });
});

type ScanSessionStatusLog = ScanSessionState<Tier, FakeResult, FakeError>['status'][];

describe('detectImContainer（纯函数，结构化输入）', () => {
  it.each<[string, ImContainerProbeShape, ImContainerKind]>([
    ['企微 UA（wxwork）', { userAgent: 'Mozilla/5.0 ... wxwork/4.1.29 MicroMessenger' }, 'wecom'],
    ['飞书 UA（feishu）', { userAgent: 'Mozilla/5.0 ... feishu/7.22.0 lark' }, 'feishu'],
    ['Lark 海外标', { userAgent: 'Mozilla/5.0 ... Lark/7.22' }, 'feishu'],
    ['企微 JS-SDK 全局对象兜底', { userAgent: 'Mozilla/5.0 (Macintosh)', hasWecomJsApi: true }, 'wecom'],
    ['飞书 JS-SDK 全局对象兜底', { userAgent: '', hasFeishuJsApi: true }, 'feishu'],
    ['普通浏览器', { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130' }, 'browser'],
    ['空输入', {}, 'browser'],
  ])('%s → %s', (_name, input, expected) => {
    expect(detectImContainer(input)).toBe(expected);
  });
});

interface ImContainerProbeShape {
  readonly userAgent?: string;
  readonly hasWecomJsApi?: boolean;
  readonly hasFeishuJsApi?: boolean;
}

describe('SCAN_READ 权限码', () => {
  it('值为 scan:read（ADR-0010 通用模块:动词形式）', () => {
    expect(SCAN_READ).toBe('scan:read');
  });
});
