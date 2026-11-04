import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  AuthCredentialsError, AuthService, InMemoryPolicyStore, InMemoryRoleStore,
  InMemorySessionStore, InMemoryUserStore, OrgService, PermissionService,
  hashPassword, type CreateSessionInput,
} from '../src/index.js';

const tenant = TenantId.create('rotation-test');
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(sessions = new InMemorySessionStore()) {
  const users = new InMemoryUserStore();
  const permissions = new PermissionService(new InMemoryPolicyStore());
  const auth = new AuthService(users, sessions, permissions);
  const org = new OrgService(users, new InMemoryRoleStore(), permissions, sessions);
  const user = await users.create({ tenant, username: 'operator', displayName: 'Operator', passwordHash: hashPassword('original-pass') });
  const issued = await auth.login(tenant, { username: 'operator', password: 'original-pass' });
  return { auth, org, user, issued, sessions };
}

describe('F2 refresh linearization with whole-user revocation', () => {
  it('reset completes after the old session/account reads: resuming refresh cannot issue a usable session', async () => {
    const entered = gate(), resume = gate();
    class PausedStore extends InMemorySessionStore {
      override async rotate(previousId: string, input: CreateSessionInput) {
        entered.release();
        await resume.promise;
        return super.rotate(previousId, input);
      }
    }
    const f = await fixture(new PausedStore());
    const refresh = f.auth.refresh(tenant, f.issued.token);
    const outcome = expect(refresh).rejects.toThrow(AuthCredentialsError);
    await entered.promise;
    await f.org.setUserPassword(tenant, f.user.id, { password: 'replacement-pass' });
    expect(await f.auth.resolveSession(f.issued.token)).toBeNull();
    resume.release();
    await outcome;
    const fresh = await f.auth.login(tenant, { username: 'operator', password: 'replacement-pass' });
    expect(await f.auth.resolveSession(fresh.token)).toMatchObject({ userId: f.user.id });
  });

  it('a replacement committed before reset is also revoked when reset returns', async () => {
    const f = await fixture();
    const replacement = await f.auth.refresh(tenant, f.issued.token);
    await f.org.setUserPassword(tenant, f.user.id, { password: 'replacement-pass' });
    expect(await f.auth.resolveSession(replacement.token)).toBeNull();
    await expect(f.auth.refresh(tenant, replacement.token)).rejects.toThrow(AuthCredentialsError);
  });

  it('two refreshes that both read a live token produce exactly one replacement', async () => {
    const both = gate(); let arrived = 0;
    class ConcurrentStore extends InMemorySessionStore {
      override async rotate(previousId: string, input: CreateSessionInput) {
        if (++arrived === 2) both.release();
        await both.promise;
        return super.rotate(previousId, input);
      }
    }
    const f = await fixture(new ConcurrentStore());
    const results = await Promise.allSettled([
      f.auth.refresh(tenant, f.issued.token), f.auth.refresh(tenant, f.issued.token),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await f.auth.resolveSession(f.issued.token)).toBeNull();
    const success = results.find(result => result.status === 'fulfilled')!;
    if (success.status === 'fulfilled') expect(await f.auth.resolveSession(success.value.token)).not.toBeNull();
  });

  it('rotation rechecks the absolute window and tenant/user binding in the storage critical section', async () => {
    const f = await fixture();
    const base = { id: 'old', tenant, userId: f.user.id, tokenDigest: 'old-digest',
      createdAt: new Date(0), expiresAt: new Date(10), refreshExpiresAt: new Date(20) };
    await f.sessions.create(base);
    for (const patch of [
      { tenant: TenantId.create('other') }, { refreshExpiresAt: new Date(21) }, { createdAt: new Date(20) },
    ]) {
      expect(await f.sessions.rotate('old', { ...base, id: 'new', tokenDigest: 'new-digest', ...patch })).toBe(false);
    }
    expect(await f.sessions.findByTokenDigest('new-digest')).toBeNull();
    expect((await f.sessions.findByTokenDigest('old-digest'))?.revokedAt).toBeNull();
  });
});
