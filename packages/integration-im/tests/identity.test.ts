import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { createInMemoryImIdentityDirectory, imIdentityBinding } from '../src/index.js';

describe('身份绑定与 InMemory 目录（Done-when #2：IM 用户 ↔ UserId）', () => {
  it('绑定为冻结快照，tenantId/userId 经品牌化工厂校验', () => {
    const binding = imIdentityBinding({
      platform: 'wecom',
      imUserId: 'wu-001',
      tenantId: 't-001',
      userId: 'u-100',
      displayName: '张工',
    });
    expect(binding.tenantId).toBe('t-001');
    expect(binding.userId).toBe('u-100');
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => imIdentityBinding({ platform: 'wecom', imUserId: 'wu-001', tenantId: '', userId: 'u-100' })).toThrow();
    expect(() => imIdentityBinding({ platform: 'wecom', imUserId: 'wu-001', tenantId: 't-001', userId: 'u'.repeat(200) })).toThrow();
    expect(() => imIdentityBinding({ platform: 'dingtalk' as never, imUserId: 'd-1', tenantId: 't-001', userId: 'u-1' })).toThrow();
  });

  it('resolve 按 platform|tenant|imUser 精确命中；同键再绑 = 换绑覆盖', () => {
    const directory = createInMemoryImIdentityDirectory();
    const first = imIdentityBinding({ platform: 'feishu', imUserId: 'ou-1', tenantId: 't-001', userId: 'u-100' });
    directory.bind(first);
    // 同一 IM 用户在不同租户是不同绑定
    expect(directory.resolve('feishu', TenantId.create('t-001'), 'ou-1')).toEqual(first);
    expect(directory.resolve('feishu', TenantId.create('t-002'), 'ou-1')).toBeUndefined();
    // 同生态同键换绑
    const rebound = imIdentityBinding({ platform: 'feishu', imUserId: 'ou-1', tenantId: 't-001', userId: 'u-200' });
    directory.bind(rebound);
    expect(directory.resolve('feishu', TenantId.create('t-001'), 'ou-1')).toEqual(rebound);
    expect(directory.list()).toEqual([rebound]);
    // 跨平台同 id 不串扰
    expect(directory.resolve('wecom', TenantId.create('t-001'), 'ou-1')).toBeUndefined();
  });
});
