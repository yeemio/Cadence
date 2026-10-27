/**
 * 口令强度策略单测（M2 安全前置批 SP-4）：OrgService 两设置口（建号初始
 * 口令 / 管理员重置）弱口令 400（OrgInputError 同族）、合规通过、长度边界、
 * 策略关闭（min 1）行为与 SP-4 前一致、文案不含口令本体、登录口不校验
 * （存量弱口令仍可登录）。
 */
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  AuthService,
  hashPassword,
  InMemoryDepartmentStore,
  InMemoryPolicyStore,
  InMemoryPositionStore,
  InMemoryRoleStore,
  InMemorySessionStore,
  InMemoryUserStore,
  OrgInputError,
  OrgService,
  PermissionService,
} from '../src/index.js';

const t1 = TenantId.create('t1');

/** 显式策略装配（OrgService 尾参注入——OrgModule.register 选项同槽位）。 */
function newOrg(
  policy?: { minLength: number; requireClasses: boolean },
): {
  org: OrgService;
  auth: AuthService;
  users: InMemoryUserStore;
} {
  const users = new InMemoryUserStore();
  const sessions = new InMemorySessionStore();
  const permissions = new PermissionService(new InMemoryPolicyStore());
  const org = new OrgService(
    users,
    new InMemoryRoleStore(),
    permissions,
    sessions,
    new InMemoryDepartmentStore(),
    new InMemoryPositionStore(),
    policy,
  );
  const auth = new AuthService(users, sessions, permissions);
  return { org, auth, users };
}

describe('SP-4 口令强度：两端点弱口令拒绝（OrgInputError 400 同族）', () => {
  it('POST /org/users（建号初始口令）：7 字符拒 / 8 字符过（缺省 min 8 边界含端点）', async () => {
    const { org } = newOrg(); // 缺省策略：min 8、字符类关
    await expect(
      org.createUser(t1, { username: 'alice', displayName: '甲', password: 'seven77' }),
    ).rejects.toThrow(OrgInputError);
    await expect(
      org.createUser(t1, { username: 'alice', displayName: '甲', password: 'seven77' }),
    ).rejects.toThrow('口令强度不足：长度至少 8 个字符');
    const created = await org.createUser(t1, {
      username: 'alice',
      displayName: '甲',
      password: 'eight888', // 恰 8 字符（边界含端点）
    });
    expect(created.username).toBe('alice');
  });

  it('PUT /org/users/:id/password（重置）：弱口令拒 / 合规过；两端点同策略', async () => {
    const { org } = newOrg();
    const user = await org.createUser(t1, { username: 'bob', displayName: '乙' });
    await expect(org.setUserPassword(t1, user.id, { password: 'short' })).rejects.toThrow(
      OrgInputError,
    );
    const updated = await org.setUserPassword(t1, user.id, { password: 'long-enough' });
    expect(updated.hasPassword).toBe(true);
  });

  it('长度上界 128 维持不变（org-input 口径不动；129 仍为输入形状拒绝）', async () => {
    const { org } = newOrg();
    const user = await org.createUser(t1, { username: 'carol', displayName: '丙' });
    await expect(org.setUserPassword(t1, user.id, { password: 'x'.repeat(129) })).rejects.toThrow(
      OrgInputError, // 1~128 之外的输入形状拒绝（requirePassword 层），先于策略
    );
    await expect(
      org.createUser(t1, { username: 'dave', displayName: '丁', password: 'y'.repeat(128) }),
    ).resolves.toBeTruthy();
  });

  it('策略关闭形态（min 1、无字符类）：1 字符口令可设（SP-4 前行为不变）', async () => {
    const { org } = newOrg({ minLength: 1, requireClasses: false });
    const created = await org.createUser(t1, {
      username: 'eve',
      displayName: '戊',
      password: 'x',
    });
    expect(created.username).toBe('eve');
  });

  it('字符类开关开启：不足三类拒 / 三类过（缺省关闭不破既有习惯）', async () => {
    const { org } = newOrg({ minLength: 8, requireClasses: true });
    await expect(
      org.createUser(t1, { username: 'frank', displayName: '己', password: 'abcdefghij' }),
    ).rejects.toThrow('口令强度不足：须至少包含小写字母、大写字母、数字、符号四类中的 3 类');
    await expect(
      org.createUser(t1, { username: 'frank', displayName: '己', password: 'abcdefg1' }),
    ).rejects.toThrow(OrgInputError); // 小写+数字 = 两类，仍不足
    const created = await org.createUser(t1, {
      username: 'frank',
      displayName: '己',
      password: 'Abcdefg1', // 小写+大写+数字 = 三类
    });
    expect(created.username).toBe('frank');
  });

  it('文案含策略要求、不含口令本体（不回显、不泄漏差异信息）', async () => {
    const { org } = newOrg();
    let message = '';
    try {
      await org.createUser(t1, { username: 'grace', displayName: '庚', password: 'short' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('至少 8 个字符'); // 含策略要求
    expect(message).not.toContain('short'); // 不回显口令本体
    expect(message).not.toContain('grace'); // 不含用户名/存在性信息
  });

  it('登录口不校验（存量弱口令仍可登录——出清走管理员重置，合同登记非目标）', async () => {
    const { org, auth, users } = newOrg();
    const user = await org.createUser(t1, { username: 'heidi', displayName: '辛' });
    // 绕过设置口直插弱口令哈希行（模拟 SP-4 前存量用户）
    await users.updatePassword(t1, user.id, hashPassword('weak'));
    const issued = await auth.login(t1, { username: 'heidi', password: 'weak' });
    expect(issued.user.username).toBe('heidi'); // 弱口令登录不受策略影响
  });
});
