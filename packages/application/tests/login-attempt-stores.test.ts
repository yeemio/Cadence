/**
 * 登录速率限制单测（M2 安全前置批 SP-1）：InMemoryLoginAttemptStore 窗口语义
 * （计数/阈值锁定/锁到期重新起算/窗口过期链条重启/成功清零/跨租户键隔离）
 * + AuthService.login 集成（锁定期正确口令也拒、固定 429 文案、凭据拒绝
 * message 不变、渐进锁定路径）。
 */
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  AuthCredentialsError,
  AuthRateLimitError,
  AuthService,
  hashPassword,
  InMemoryLoginAttemptStore,
  InMemoryPolicyStore,
  InMemorySessionStore,
  InMemoryUserStore,
  PermissionService,
} from '../src/index.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

/** 短参数存储：2 次失败 / 计数窗 60s / 锁 120s（语义断言用注入时钟驱动）。 */
const PARAMS = { maxFailures: 2, windowMs: 60_000, lockMs: 120_000 };

const T0 = new Date('2026-10-27T08:00:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

describe('InMemoryLoginAttemptStore（窗口失败计数 + 锁定）', () => {
  it('计数到阈值即锁定；锁定期内 isLocked 恒真；锁到期自动解锁', async () => {
    const store = new InMemoryLoginAttemptStore(PARAMS);
    await expect(store.isLocked(t1, 'alice', at(0))).resolves.toBe(false);
    await store.registerFailure(t1, 'alice', at(0)); // 第 1 次：未锁
    await expect(store.isLocked(t1, 'alice', at(1))).resolves.toBe(false);
    await store.registerFailure(t1, 'alice', at(10)); // 第 2 次（60s 窗内）：锁定
    await expect(store.isLocked(t1, 'alice', at(11))).resolves.toBe(true);
    await expect(store.isLocked(t1, 'alice', at(129))).resolves.toBe(true); // 120s 锁内（10s 起 + 120s）
    await expect(store.isLocked(t1, 'alice', at(130))).resolves.toBe(false); // 锁到期
  });

  it('锁定期内 registerFailure 不追加不延长（锁定窗从触发失败起算固定时长）', async () => {
    const store = new InMemoryLoginAttemptStore(PARAMS);
    await store.registerFailure(t1, 'bob', at(0));
    await store.registerFailure(t1, 'bob', at(10)); // 触发锁：应至 130s
    await store.registerFailure(t1, 'bob', at(100)); // 锁定期内的追加（防御分支）
    await expect(store.isLocked(t1, 'bob', at(129))).resolves.toBe(true);
    await expect(store.isLocked(t1, 'bob', at(130))).resolves.toBe(false);
  });

  it('锁到期后重新起算：单次失败不立即再锁（需再攒满阈值）', async () => {
    const store = new InMemoryLoginAttemptStore(PARAMS);
    await store.registerFailure(t1, 'carol', at(0));
    await store.registerFailure(t1, 'carol', at(10)); // 锁至 130s
    await store.registerFailure(t1, 'carol', at(131)); // 到期后第 1 次：重新计数
    await expect(store.isLocked(t1, 'carol', at(132))).resolves.toBe(false);
    await store.registerFailure(t1, 'carol', at(140)); // 第 2 次：再锁
    await expect(store.isLocked(t1, 'carol', at(141))).resolves.toBe(true);
  });

  it('计数窗过期（距上次失败超窗）：链条重启从 1 计', async () => {
    const store = new InMemoryLoginAttemptStore(PARAMS);
    await store.registerFailure(t1, 'dave', at(0));
    await store.registerFailure(t1, 'dave', at(59)); // 59s ≤ 60s 窗：第 2 次 → 锁
    await expect(store.isLocked(t1, 'dave', at(60))).resolves.toBe(true);

    const other = new InMemoryLoginAttemptStore(PARAMS);
    await other.registerFailure(t1, 'erin', at(0));
    await other.registerFailure(t1, 'erin', at(61)); // 61s > 60s 窗：重启为 1
    await expect(other.isLocked(t1, 'erin', at(62))).resolves.toBe(false);
  });

  it('成功登录清零（clear 删行——与从未失败不可区分）', async () => {
    const store = new InMemoryLoginAttemptStore(PARAMS);
    await store.registerFailure(t1, 'frank', at(0));
    await store.clear(t1, 'frank');
    await store.registerFailure(t1, 'frank', at(10)); // 清零后从 1 计
    await expect(store.isLocked(t1, 'frank', at(11))).resolves.toBe(false);
  });

  it('计数键 = (tenant, username) 跨租户隔离：t1 锁定不影响 t2 同名', async () => {
    const store = new InMemoryLoginAttemptStore(PARAMS);
    await store.registerFailure(t1, 'grace', at(0));
    await store.registerFailure(t1, 'grace', at(10)); // t1 锁定
    await expect(store.isLocked(t1, 'grace', at(11))).resolves.toBe(true);
    await expect(store.isLocked(t2, 'grace', at(11))).resolves.toBe(false); // t2 不受影响
  });

  it('缺省参数：5 次失败 / 15 分钟窗 / 15 分钟锁', async () => {
    const store = new InMemoryLoginAttemptStore(); // 缺省
    for (let i = 0; i < 4; i += 1) {
      await store.registerFailure(t1, 'heidi', at(i * 60));
    }
    await expect(store.isLocked(t1, 'heidi', at(4 * 60))).resolves.toBe(false); // 4 次未锁
    await store.registerFailure(t1, 'heidi', at(4 * 60)); // 第 5 次 → 锁
    await expect(store.isLocked(t1, 'heidi', at(4 * 60 + 1))).resolves.toBe(true);
    await expect(store.isLocked(t1, 'heidi', at(15 * 60 + 4 * 60 - 1))).resolves.toBe(true); // 15 分钟锁内
    await expect(store.isLocked(t1, 'heidi', at(15 * 60 + 4 * 60))).resolves.toBe(false); // 到期
  });
});

describe('AuthService.login × LoginAttemptStore（集成）', () => {
  function newAuth(
    now: () => Date,
  ): { auth: AuthService; users: InMemoryUserStore; attempts: InMemoryLoginAttemptStore } {
    const users = new InMemoryUserStore();
    const attempts = new InMemoryLoginAttemptStore(PARAMS);
    const auth = new AuthService(users, new InMemorySessionStore(), new PermissionService(new InMemoryPolicyStore()), {
      loginAttemptStore: attempts,
      now,
    });
    return { auth, users, attempts };
  }

  it('连续失败达阈值 → AuthRateLimitError（固定文案）；锁定期正确口令也拒；到期恢复', async () => {
    let clock = at(0);
    const { auth, users } = newAuth(() => clock);
    await users.create({
      tenant: t1,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: hashPassword('right-password'),
    });

    // 阈值前：凭据拒绝 message 不变（auth.service 四合一同 message 语义不动）
    clock = at(0);
    await expect(auth.login(t1, { username: 'alice', password: 'wrong' })).rejects.toThrow(
      AuthCredentialsError,
    );
    clock = at(10);
    await expect(auth.login(t1, { username: 'alice', password: 'wrong' })).rejects.toThrow(
      '用户名或口令不正确',
    );

    // 阈值后：正确口令也拒（429 固定文案，不含存在性信息）
    clock = at(20);
    await expect(auth.login(t1, { username: 'alice', password: 'right-password' })).rejects.toThrow(
      AuthRateLimitError,
    );
    await expect(auth.login(t1, { username: 'alice', password: 'right-password' })).rejects.toThrow(
      '登录尝试过于频繁，请稍后再试',
    );

    // 锁到期（10s 触发锁 + 120s）：正确口令恢复登录
    clock = at(131);
    const issued = await auth.login(t1, { username: 'alice', password: 'right-password' });
    expect(issued.user.username).toBe('alice');
    expect(await auth.resolveSession(issued.token)).not.toBeNull();
  });

  it('成功登录清零计数：失败→成功→再失败不累积锁定', async () => {
    let clock = at(0);
    const { auth, users } = newAuth(() => clock);
    await users.create({
      tenant: t1,
      username: 'bob',
      displayName: 'Bob',
      passwordHash: hashPassword('right-password'),
    });
    await expect(auth.login(t1, { username: 'bob', password: 'wrong' })).rejects.toThrow(
      AuthCredentialsError,
    );
    clock = at(10);
    expect((await auth.login(t1, { username: 'bob', password: 'right-password' })).user.username).toBe('bob');
    clock = at(20);
    await expect(auth.login(t1, { username: 'bob', password: 'wrong' })).rejects.toThrow(
      AuthCredentialsError, // 清零后从 1 计：仍是凭据拒绝而非 429
    );
  });

  it('不存在的用户同样计数（防候选用户名爆破）', async () => {
    let clock = at(0);
    const { auth } = newAuth(() => clock);
    await expect(auth.login(t1, { username: 'ghost', password: 'x' })).rejects.toThrow(
      AuthCredentialsError,
    );
    clock = at(10);
    await expect(auth.login(t1, { username: 'ghost', password: 'x' })).rejects.toThrow(
      AuthCredentialsError,
    );
    clock = at(20);
    await expect(auth.login(t1, { username: 'ghost', password: 'x' })).rejects.toThrow(
      AuthRateLimitError, // 键 = (t1, ghost)：不存在的用户也进锁定
    );
  });

  it('跨租户键隔离：t1 锁定不影响 t2 登录', async () => {
    let clock = at(0);
    const { auth, users } = newAuth(() => clock);
    await users.create({
      tenant: t1,
      username: 'shared',
      displayName: 't1',
      passwordHash: hashPassword('right-password'),
    });
    await users.create({
      tenant: t2,
      username: 'shared',
      displayName: 't2',
      passwordHash: hashPassword('right-password'),
    });
    for (const time of [0, 10]) {
      clock = at(time);
      await expect(auth.login(t1, { username: 'shared', password: 'wrong' })).rejects.toThrow(
        AuthCredentialsError,
      );
    }
    clock = at(20);
    await expect(auth.login(t1, { username: 'shared', password: 'right-password' })).rejects.toThrow(
      AuthRateLimitError, // t1 已锁
    );
    const issued = await auth.login(t2, { username: 'shared', password: 'right-password' });
    expect(issued.user.tenant).toBe(t2); // t2 同名不受影响
  });
});
