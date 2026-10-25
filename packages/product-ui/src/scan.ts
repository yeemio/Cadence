/**
 * 扫码会话视图模型 + IM 容器识别 + 扫码权限码（M1 收尾波-②）。
 *
 * 依赖方向（ADR-0011）：product-ui 不得 import integration-*（边缘词汇不进
 * 业务层），故 ScanSessionModel 对档位 / 结果 / 错误全程泛型化
 * （TTier extends string / TResult / TError）——组合根（apps/web）以
 * integration-scan 的 ScannerTier / ScanResult / ScanError 代入类型参数，
 * 注入降级判定谓词与 planScanChain 产出的档位链。"消费 planScanChain /
 * ScanResult"以结构兼容 + 依赖倒置达成，integration-scan 词汇零渗入本包。
 *
 * 语义取舍（写明）：
 * - 不可降级错误（相机解码噪声 / 串入坏段）只记入 lastError，不打断会话、
 *   不改档位——对齐边缘包"decode-failed / malformed-input 不触发降级，
 *   避免无码可扫时链被自动打散"的白名单语义；
 * - 可降级错误（能力缺失 / 权限被拒 / 超时）自动推进到链中下一档并追加
 *   降级历史；链耗尽转 exhausted（人工兜底提示由装配层渲染）；
 * - 手动换档（switchTier）不改降级历史（历史只记自动降级），也不隐式启动。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 扫码页权限码（挂菜单与路由守卫；ADR-0010 通用词 scan:read）。 */
export const SCAN_READ: PermissionCode = permissionCode('scan:read');

// ---------------------------------------------------------------------------
// IM 容器识别（纯函数，可测输入形状）
// ---------------------------------------------------------------------------

/** 容器三态：企业微信 / 飞书 / 普通浏览器。 */
export type ImContainerKind = 'wecom' | 'feishu' | 'browser';

/**
 * 容器探测输入（结构化形状，浏览器环境由装配层读取后传入）：
 * - userAgent：navigator.userAgent（可选注入）；
 * - hasWecomJsApi / hasFeishuJsApi：容器注入的 JS-SDK 全局对象存在性
 *   （window.wx / window.tt），比 UA 更强的存在性证据。
 */
export interface ImContainerProbeInput {
  readonly userAgent?: string;
  readonly hasWecomJsApi?: boolean;
  readonly hasFeishuJsApi?: boolean;
}

/** UA 优先（wxwork / feishu / lark 为各容器 WebView 的稳定 UA 标记），JS-SDK 全局对象兜底。 */
export function detectImContainer(input: ImContainerProbeInput): ImContainerKind {
  const userAgent = input.userAgent ?? '';
  if (/wxwork/i.test(userAgent)) return 'wecom';
  if (/feishu|lark/i.test(userAgent)) return 'feishu';
  if (input.hasWecomJsApi === true) return 'wecom';
  if (input.hasFeishuJsApi === true) return 'feishu';
  return 'browser';
}

// ---------------------------------------------------------------------------
// 扫码会话视图模型（泛型状态机，快照外抛）
// ---------------------------------------------------------------------------

/** 会话状态：idle 未启动 / active 扫描中 / exhausted 链耗尽 / stopped 已停止 */
export type ScanSessionStatus = 'idle' | 'active' | 'exhausted' | 'stopped';

/** 一次自动降级记录（from → to；to 为 null 表示链耗尽）。 */
export interface ScanDegradationEntry<TTier extends string, TError> {
  readonly fromTier: TTier;
  readonly toTier: TTier | null;
  readonly error: TError;
}

/** 会话快照（冻结）：当前档 / 全链 / 降级历史 / 最近结果 / 最近错误。 */
export interface ScanSessionState<TTier extends string, TResult, TError> {
  readonly status: ScanSessionStatus;
  readonly currentTier: TTier | null;
  /** 完整降级链（保持构造顺序；当前位置由 currentTier 指示） */
  readonly tiers: readonly TTier[];
  readonly degradations: readonly ScanDegradationEntry<TTier, TError>[];
  readonly recentResults: readonly TResult[];
  readonly lastError: TError | null;
}

export interface ScanSessionModelOptions<TTier extends string, TError> {
  /** 降级链（planScanChain 产出；非空，重复档位被拒） */
  readonly tiers: readonly TTier[];
  /** 可降级判定谓词（组合根注入，如 integration-scan 的 isDegradableScanError） */
  readonly isDegradableError: (error: TError) => boolean;
  /** 最近结果列表容量，默认 20 */
  readonly maxRecentResults?: number;
}

export interface ScanSessionModel<TTier extends string, TResult, TError> {
  /** 当前快照（冻结；跨调用返回新对象，可直接进 React state） */
  getState(): ScanSessionState<TTier, TResult, TError>;
  /** 订阅状态变化（每次变化回调新快照），返回退订函数 */
  subscribe(listener: (state: ScanSessionState<TTier, TResult, TError>) => void): () => void;
  /** 启动会话：idle / stopped / exhausted → active（当前档位不变；exhausted 后重启回到链首） */
  start(): void;
  /** 停止会话：active → stopped（幂等） */
  stop(): void;
  /** 手动换档：档位须在链内；不隐式启动（idle/stopped 下只改选择） */
  switchTier(tier: TTier): void;
  /** 扫码器产出结果入列（容量截断丢弃最旧） */
  pushResult(result: TResult): void;
  /** 扫码器错误入模型：可降级则自动换档/链耗尽；不可降级只记 lastError */
  pushError(error: TError): void;
}

const DEFAULT_MAX_RECENT_RESULTS = 20;

/**
 * 构造扫码会话视图模型。链为空抛错（等价于边缘包 NoScannerAvailableError
 * 的组合根侧防御；泛型层不复用其类型以免词汇渗入）。
 */
export function createScanSessionModel<TTier extends string, TResult, TError>(
  options: ScanSessionModelOptions<TTier, TError>,
): ScanSessionModel<TTier, TResult, TError> {
  const { tiers, isDegradableError } = options;
  const maxRecentResults = options.maxRecentResults ?? DEFAULT_MAX_RECENT_RESULTS;
  if (tiers.length === 0) {
    throw new Error('invalid scan session: tiers must be a non-empty chain');
  }
  if (new Set(tiers).size !== tiers.length) {
    throw new Error('invalid scan session: tiers must not contain duplicates');
  }
  if (!Number.isInteger(maxRecentResults) || maxRecentResults < 1) {
    throw new Error('invalid scan session: maxRecentResults must be an integer >= 1');
  }

  let status: ScanSessionStatus = 'idle';
  const firstTier = tiers[0];
  if (firstTier === undefined) {
    throw new Error('invalid scan session: tiers must be a non-empty chain');
  }
  let currentTier: TTier = firstTier;
  let degradations: readonly ScanDegradationEntry<TTier, TError>[] = [];
  let recentResults: readonly TResult[] = [];
  let lastError: TError | null = null;

  const listeners = new Set<(state: ScanSessionState<TTier, TResult, TError>) => void>();
  let snapshot = freezeState();

  function freezeState(): ScanSessionState<TTier, TResult, TError> {
    return Object.freeze({
      status,
      currentTier,
      tiers: Object.freeze([...tiers]),
      degradations: Object.freeze([...degradations]),
      recentResults: Object.freeze([...recentResults]),
      lastError,
    });
  }

  function publish(): void {
    snapshot = freezeState();
    for (const listener of [...listeners]) listener(snapshot);
  }

  return {
    getState(): ScanSessionState<TTier, TResult, TError> {
      return snapshot;
    },
    subscribe(listener: (state: ScanSessionState<TTier, TResult, TError>) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(): void {
      if (status === 'exhausted') {
        // 链耗尽后重启：回到链首重新尝试（降级历史保留为审计轨迹）
        currentTier = firstTier;
      }
      if (status === 'active') return;
      status = 'active';
      publish();
    },
    stop(): void {
      if (status !== 'active') return;
      status = 'stopped';
      publish();
    },
    switchTier(tier: TTier): void {
      if (!tiers.includes(tier)) {
        throw new Error(`invalid scan session: tier ${String(tier)} is not in the chain`);
      }
      if (tier === currentTier && status !== 'exhausted') return;
      currentTier = tier;
      if (status === 'exhausted') status = 'idle'; // 换档解锁耗尽态，等待 start
      publish();
    },
    pushResult(result: TResult): void {
      recentResults = [...recentResults, result].slice(-maxRecentResults);
      publish();
    },
    pushError(error: TError): void {
      lastError = error;
      if (status !== 'active' || !isDegradableError(error)) {
        // 不可降级（解码噪声 / 坏输入）或非扫描中：只记错误态，会话不动
        publish();
        return;
      }
      const index = tiers.indexOf(currentTier);
      const next = tiers.slice(index + 1)[0] ?? null;
      degradations = [
        ...degradations,
        Object.freeze({ fromTier: currentTier, toTier: next, error }),
      ];
      if (next === null) {
        status = 'exhausted';
      } else {
        currentTier = next;
      }
      publish();
    },
  };
}
