/**
 * 顶栏显示名呈现净化接缝测试（UX-PLAN-13 / UX-AP-06 / UX-VW-02；node 纯逻辑，
 * 体例先例=ShellLayout.test.ts）：presentDisplayName = ShellBody 顶栏 displayName
 * 的呈现净化决策点。种子 displayName（prisma/seed.mjs）带夹具括注/权限码拼接，
 * 服务端种子与 packages 本批不可改——净化收敛在 shell/displayName.ts。
 */
import { describe, expect, it } from 'vitest';
import { presentDisplayName } from './displayName.js';

describe('presentDisplayName（顶栏显示名去夹具括注/权限码）', () => {
  it('UX-PLAN-13：剥夹具括注「（Web 登录流）」（全角）', () => {
    expect(presentDisplayName('演示管理员（Web 登录流）')).toBe('演示管理员');
  });

  it('半角括注 + 前导空格同样剥净', () => {
    expect(presentDisplayName('演示管理员 (Web 登录流)')).toBe('演示管理员');
  });

  it('UX-AP-06：剥权限码括注「（approval:read/write）」', () => {
    expect(presentDisplayName('种子审批人（approval:read/write）')).toBe('演示审批人');
  });

  it('UX-VW-02：剥「（无策略）」并把夹具前缀「种子」改「演示」（与登录页演示账号口径一致）', () => {
    expect(presentDisplayName('种子访客（无策略）')).toBe('演示访客');
  });

  it('业务性括注保留（非权限码形且非已知夹具注释不剥）', () => {
    expect(presentDisplayName('张三（车间主任）')).toBe('张三（车间主任）');
  });

  it('普通名无括注原样返回', () => {
    expect(presentDisplayName('admin')).toBe('admin');
    expect(presentDisplayName('演示管理员')).toBe('演示管理员');
  });

  it('净化结果为空时原样返回（调用方另有 fallbackName 兜底）', () => {
    expect(presentDisplayName('（无策略）')).toBe('（无策略）');
  });
});
