/**
 * 会话保活（M1 收尾波-③，ADR-0009 参照清单 §3.1 三规则的产品化落地）：
 *
 * 规则 1 临期主动续期：剩余 TTL < TTL/3（8h TTL → 剩约 2h40m 起）时，每
 *   KEEPALIVE_TICK_MS（60s）尝试一次 POST /auth/refresh；网络失败不清会话
 *   （下一 tick 重试）；服务端明确拒绝（401）才清会话并跳登录。续期窗口
 *   上界 7d 由服务端收口（绝对上限不滑动）。
 * 规则 2 请求失败不清会话：本模块与 apiClient 的约定一致——只有服务端 401
 *   才清（AuthRejectedError）；网络错误一律保留会话。
 * 规则 3 空闲计时仅在页面可见时累计：visibilitychange 切后台即暂停（回来
 *   时刻重置起点——后台时间不计入空闲）；且有进行中请求（apiClient 计数 >0）
 *   时不判空闲。空闲阈值 IDLE_TIMEOUT_MS（30 分钟）到点：尽力真实登出 +
 *   清本地 + 跳登录。
 *
 * 纯判定函数（shouldProactivelyRefresh / isIdleSessionExpired）独立导出，
 * 单测钉死三条规则；startSessionKeepalive 负责浏览器事件装配（仅主壳入口
 * 挂载——登录 bundle 不需要）。
 */
import { toTokenSession, type AuthTransport, type TokenSessionStore } from '@smes/product-ui';

/** 服务端访问 TTL（8h，与 application SESSION_TOKEN_TTL_MS 一致）。 */
export const SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
/** 临期阈值：剩余 TTL 的 1/3（≈2h40m）起开始主动续期。 */
export const PROACTIVE_REFRESH_THRESHOLD_MS = SESSION_TOKEN_TTL_MS / 3;
/** 保活检查间隔（60s）。 */
export const KEEPALIVE_TICK_MS = 60 * 1000;
/** 空闲登出阈值（30 分钟，仅页面可见且无进行中请求时累计）。 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** 空闲检查间隔（30s）。 */
export const IDLE_TICK_MS = 30 * 1000;
/** 重置空闲计时的用户活动事件。 */
const ACTIVITY_EVENTS = ['click', 'keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

/** 规则 1 纯判定：是否到达主动续期阈值。 */
export function shouldProactivelyRefresh(
  expiresAtMs: number,
  nowMs: number,
  thresholdMs: number = PROACTIVE_REFRESH_THRESHOLD_MS,
): boolean {
  return nowMs >= expiresAtMs - thresholdMs;
}

export interface IdleCheckInput {
  readonly nowMs: number;
  readonly lastActivityMs: number;
  readonly idleTimeoutMs: number;
  readonly pageVisible: boolean;
  readonly inFlightRequests: number;
}

/** 规则 3 纯判定：空闲是否到点（页面不可见或有进行中请求 = 不累计不判）。 */
export function isIdleSessionExpired(input: IdleCheckInput): boolean {
  if (!input.pageVisible) return false; // 后台标签不计时
  if (input.inFlightRequests > 0) return false; // 有进行中请求视为活跃
  return input.nowMs - input.lastActivityMs >= input.idleTimeoutMs;
}

export interface SessionKeepaliveDeps {
  readonly store: TokenSessionStore;
  readonly transport: AuthTransport;
  /** 会话失效（401）或空闲到点时的收尾动作（清会话 + 跳登录由调用方定）。 */
  readonly onSessionEnd: () => void;
  /** 时钟/间隔注入（测试用；缺省系统时钟）。 */
  readonly now?: () => number;
  readonly keepaliveTickMs?: number;
  readonly idleTickMs?: number;
}

/**
 * 启动保活（浏览器装配）：返回停止函数（卸载时清理监听与定时器）。
 * 定时器在会话不存在时空转跳过（登录页/登出后无副作用）。
 */
export function startSessionKeepalive(deps: SessionKeepaliveDeps): () => void {
  const now = deps.now ?? Date.now;
  const keepaliveTick = deps.keepaliveTickMs ?? KEEPALIVE_TICK_MS;
  const idleTick = deps.idleTickMs ?? IDLE_TICK_MS;

  let lastActivityMs = now();
  let refreshing = false;

  const markActivity = (): void => {
    lastActivityMs = now();
  };
  const onVisibility = (): void => {
    // 规则 3：切后台暂停；回前台重置起点——后台时间不计入空闲
    if (document.visibilityState === 'visible') {
      markActivity();
    }
  };
  for (const type of ACTIVITY_EVENTS) {
    document.addEventListener(type, markActivity, { passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);

  const endSession = (): void => {
    deps.onSessionEnd();
  };

  const keepaliveTimer = window.setInterval((): void => {
    const session = deps.store.read();
    if (session === null || refreshing) return;
    if (!shouldProactivelyRefresh(Date.parse(session.expiresAt), now())) return;
    refreshing = true;
    void deps.transport
      .refresh(session.token)
      .then((payload) => {
        // 换新成功：整体覆写会话（新 token + 新 expiresAt + 服务端权限投影）
        deps.store.write(toTokenSession(payload));
      })
      .catch((error: unknown) => {
        // 规则 2：网络失败不清会话（下一 tick 重试）；仅服务端明确拒绝才终结
        if (error instanceof Error && error.name === 'AuthRejectedError') {
          endSession();
        }
      })
      .finally((): void => {
        refreshing = false;
      });
  }, keepaliveTick);

  const idleTimer = window.setInterval((): void => {
    const session = deps.store.read();
    if (session === null) return;
    if (
      isIdleSessionExpired({
        nowMs: now(),
        lastActivityMs,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        pageVisible: document.visibilityState === 'visible',
        // 跨模块读计数：apiClient 模块内计数器经此函数暴露（装配层单例）
        inFlightRequests: idleInFlightProvider(),
      })
    ) {
      // 尽力真实登出（失败也继续本地清 + 跳转）
      void deps.transport.logout(session.token).catch(() => undefined);
      endSession();
    }
  }, idleTick);

  return () => {
    window.clearInterval(keepaliveTimer);
    window.clearInterval(idleTimer);
    for (const type of ACTIVITY_EVENTS) {
      document.removeEventListener(type, markActivity);
    }
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** 进行中请求数提供者——由 main.tsx 接 apiClient.authInFlightCount（避免环依赖）。 */
let idleInFlightProvider: () => number = () => 0;

export function setInFlightProvider(provider: () => number): void {
  idleInFlightProvider = provider;
}
