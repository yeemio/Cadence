import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { InMemoryPolicyStore, roleName } from '../src/index.js';

const t1 = TenantId.create('t1');
const alice = UserId.create('alice');

describe('InMemoryPolicyStore（端口先行实现）', () => {
  it('append 幂等：重复规则不产生重复行', async () => {
    const store = new InMemoryPolicyStore();
    const rule = {
      kind: 'grant-role',
      tenant: t1,
      user: alice,
      role: roleName('operator'),
    } as const;
    await store.append([rule, rule]);
    expect(await store.load()).toHaveLength(1);
    await store.append([rule]);
    expect(await store.load()).toHaveLength(1);
  });

  it('remove 幂等：不存在的规则静默跳过；等值不同引用可移除', async () => {
    const store = new InMemoryPolicyStore();
    await store.append([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName('operator') },
    ]);
    await store.remove([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName('operator') },
    ]);
    expect(await store.load()).toHaveLength(0);
    await store.remove([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName('operator') },
    ]);
    expect(await store.load()).toHaveLength(0);
  });
});
