/**
 * LoginAttemptStore 端口 + 内存实现（M2 安全前置批 SP-1：登录速率限制）。
 *
 * 与 SessionStore 同一模式：端口在本包定义，内存实现先行，PG adapter 由
 * business-store `./org` 子路径接入。login_attempts 同 sessions 是轻量运营
 * 状态（窗口计数、可清零），非业务事实——不套证据公共列、不设 append-only
 * 触发器（session-stores.ts 同款取舍）。
 *
 * 模型（合同冻结）：窗口失败计数 + 锁定，计数键 = (tenant, username)。
 *   - 缺省 5 次失败 / 15 分钟计数窗 / 锁定 15 分钟；
 *   - 窗口滑动按"最近一次失败时刻起算"实现（不要求滚动精确滑窗）：距上一
 *     次失败超过计数窗 → 链条过期，重新从 1 计；锁定到期后同样重新起算
 *     （过期后一次失败不立即再锁，需再攒满阈值）；
 *   - 成功登录清零（clear 删行）；
 *   - 锁定期内同键一律拒绝——正确口令也拒（判定在 AuthService.login 凭据
 *     验证**之前**，锁不可被探测绕过；锁定期内不追加失败，锁定窗从触发
 *     锁定的那次失败起算固定时长，不随尝试延长）。
 *
 * 参数（maxFailures/windowMs/lockMs）注入在**实现构造**而非服务：语义判定
 * 在存储内（PG 形态计数自增须单语句原子——服务层读改写做不到），组合根按
 * env 覆写构造实例（SMES_LOGIN_MAX_FAILURES / SMES_LOGIN_WINDOW_SECONDS /
 * SMES_LOGIN_LOCK_SECONDS，main.ts 读取）。
 */
import { TenantId } from '@smes/business-core';

/** 登录失败计数存储端口。时间参数由调用方（AuthService 的时钟注入）传入。 */
export interface LoginAttemptStore {
  /** 该键当前是否处于锁定期（lockedUntil > now）。 */
  isLocked(tenant: TenantId, username: string, now: Date): Promise<boolean>;
  /**
   * 记录一次失败（窗口/锁定判定在实现内）。锁定期内调用为无操作（服务层
   * 先检锁再验证——本分支防御性兜底，两实现语义一致）。
   */
  registerFailure(tenant: TenantId, username: string, now: Date): Promise<void>;
  /** 成功登录清零计数（删行——与"从未失败"不可区分）。 */
  clear(tenant: TenantId, username: string): Promise<void>;
}

/** 登录限流参数（两实现同形状；组合根 env 覆写用）。 */
export interface LoginAttemptStoreParams {
  /** 计数窗内失败阈值，达到即锁定；缺省 5。 */
  readonly maxFailures?: number;
  /** 计数窗毫秒；缺省 15 分钟。 */
  readonly windowMs?: number;
  /** 锁定时长毫秒；缺省 15 分钟。 */
  readonly lockMs?: number;
}

export const LOGIN_MAX_FAILURES_DEFAULT = 5;
export const LOGIN_WINDOW_MS_DEFAULT = 15 * 60 * 1000;
export const LOGIN_LOCK_MS_DEFAULT = 15 * 60 * 1000;

interface AttemptRow {
  failureCount: number;
  lastFailureAt: Date;
  lockedUntil: Date | null;
}

/** 行数护栏：防用户名喷射撑爆内存（过期行语义惰性，清扫不改变行为）。 */
const MAX_TRACKED_KEYS = 10_000;

export class InMemoryLoginAttemptStore implements LoginAttemptStore {
  private readonly rows = new Map<string, AttemptRow>(); // key: `${tenant}|${username}`
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;

  constructor(params: LoginAttemptStoreParams = {}) {
    this.maxFailures = params.maxFailures ?? LOGIN_MAX_FAILURES_DEFAULT;
    this.windowMs = params.windowMs ?? LOGIN_WINDOW_MS_DEFAULT;
    this.lockMs = params.lockMs ?? LOGIN_LOCK_MS_DEFAULT;
  }

  async isLocked(tenant: TenantId, username: string, now: Date): Promise<boolean> {
    const row = this.rows.get(keyOf(tenant, username));
    return row !== undefined && row.lockedUntil !== null && now < row.lockedUntil;
  }

  async registerFailure(tenant: TenantId, username: string, now: Date): Promise<void> {
    if (this.rows.size >= MAX_TRACKED_KEYS) {
      this.pruneStale(now);
    }
    const key = keyOf(tenant, username);
    const row = this.rows.get(key);
    if (row !== undefined && row.lockedUntil !== null && now < row.lockedUntil) {
      return; // 锁定期内不追加（防御分支：服务层已先拒）
    }
    // 链条过期 = 距上次失败超计数窗，或上一链条以锁定收场且已到期 → 重新从 1 计
    const streakExpired =
      row === undefined ||
      row.lockedUntil !== null ||
      now.getTime() - row.lastFailureAt.getTime() > this.windowMs;
    const count = streakExpired ? 1 : row.failureCount + 1;
    this.rows.set(key, {
      failureCount: count,
      lastFailureAt: now,
      lockedUntil: count >= this.maxFailures ? new Date(now.getTime() + this.lockMs) : null,
    });
  }

  async clear(tenant: TenantId, username: string): Promise<void> {
    this.rows.delete(keyOf(tenant, username));
  }

  /** 清扫语义惰性行（链条过期且未锁定）；全热时仍有界——最旧键可被覆盖重建。 */
  private pruneStale(now: Date): void {
    for (const [key, row] of this.rows) {
      const expired =
        row.lockedUntil === null
          ? now.getTime() - row.lastFailureAt.getTime() > this.windowMs
          : now >= row.lockedUntil;
      if (expired) {
        this.rows.delete(key);
      }
    }
  }
}

function keyOf(tenant: TenantId, username: string): string {
  return `${tenant}|${username}`;
}
