/** Opt-in, disposable database only. Never consumes DATABASE_URL implicitly. */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import {
  AuthService, InMemoryPolicyStore, InMemoryRoleStore, OrgService, PermissionService,
  digestSessionToken, hashPassword, type CreateSessionInput,
} from '@smes/application';
import { PgSessionStore, PgUserStore } from '../src/org/pg-org-stores.js';
import { withRlsTenantSession } from '../src/rls-session.js';
import { seedMain } from '../prisma/seed.mjs';

const url = process.env['CADENCE_IDENTITY_TEST_DATABASE_URL'];
const tenant = TenantId.create('default');

describe.skipIf(!url)('F2/F3 isolated PostgreSQL lifecycle', () => {
  // Evaluate lazily: a skipped suite must not connect or instantiate a client.
  let prisma: PrismaClient | undefined;
  const ids: string[] = [];
  function database() {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/cadence_pr2_test') {
      throw new Error('Requires loopback disposable database cadence_pr2_test');
    }
    return prisma ??= new PrismaClient({ datasources: { db: { url: url! } } });
  }
  async function fixture(paused?: { entered: () => void; resume: Promise<void> }) {
    const client = withRlsTenantSession(database(), { session: true });
    const users = new PgUserStore(client);
    class PausedStore extends PgSessionStore {
      override async rotate(id: string, input: CreateSessionInput) {
        if (paused) { paused.entered(); await paused.resume; }
        return super.rotate(id, input);
      }
    }
    const sessions = new PausedStore(client);
    const permissions = new PermissionService(new InMemoryPolicyStore());
    const user = await users.create({ tenant, username: `pr2-${randomUUID()}`, displayName: 'Synthetic PR2', passwordHash: hashPassword('original-pass') });
    ids.push(user.id);
    const auth = new AuthService(users, sessions, permissions);
    const org = new OrgService(users, new InMemoryRoleStore(), permissions, sessions);
    const issued = await auth.login(tenant, { username: user.username, password: 'original-pass' });
    return { user, auth, org, issued, sessions };
  }
  afterAll(async () => {
    if (!prisma) return;
    await prisma.sessionRecord.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRecord.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('first bootstrap works, then standard seed replay preserves revoked grants and disabled/custom-password accounts', async () => {
    const db = database();
    expect(await db.userRecord.count({ where: { tenantId: tenant } }), 'Start with migrations only, no seed').toBe(0);
    expect(await db.policyRecord.count({ where: { tenantId: tenant } })).toBe(0);
    await seedMain(db);
    const original = await db.userRecord.findUniqueOrThrow({ where: { id: 'user-seed-admin' } });
    ids.push('user-seed-admin', 'user-seed-viewer', 'user-demo-admin', 'user-seed-approver');
    const policyKeys = (await db.policyRecord.findMany({ where: { tenantId: tenant } })).map(row => row.ruleKey);
    try {
      expect(policyKeys).toHaveLength(6);
      await db.policyRecord.deleteMany({ where: { ruleKey: 'grant-role|default|user-seed-admin|admin' } });
      await db.userRecord.update({ where: { id: original.id }, data: { active: false, passwordHash: 'synthetic-custom-hash' } });
      await seedMain(db);
      expect(await db.policyRecord.findUnique({ where: { ruleKey: 'grant-role|default|user-seed-admin|admin' } })).toBeNull();
      expect(await db.userRecord.findUnique({ where: { id: original.id } })).toMatchObject({ active: false, passwordHash: 'synthetic-custom-hash' });
    } finally {
      await db.policyRecord.deleteMany({ where: { ruleKey: { in: policyKeys } } });
    }
  });

  it('concurrent refresh is single use; whole-user revocation also consumes the replacement', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.auth.refresh(tenant, f.issued.token), f.auth.refresh(tenant, f.issued.token)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await database().sessionRecord.count({ where: { userId: f.user.id, revokedAt: null } })).toBe(1);
    await f.sessions.revokeAllForUser(tenant, f.user.id);
    expect(await database().sessionRecord.count({ where: { userId: f.user.id, revokedAt: null } })).toBe(0);
  });

  it('a completed password reset prevents a previously read refresh from issuing', async () => {
    let entered!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { resume = resolve; });
    const f = await fixture({ entered, resume: wait });
    const refresh = f.auth.refresh(tenant, f.issued.token).then(() => 'issued', () => 'rejected');
    await reached;
    await f.org.setUserPassword(tenant, f.user.id, { password: 'replacement-pass' });
    resume();
    expect(await refresh).toBe('rejected');
    expect(await database().sessionRecord.count({ where: { userId: f.user.id, revokedAt: null } })).toBe(0);
  });

  it('replacement insert failure rolls back consumption of the original session', async () => {
    const f = await fixture();
    const old = (await f.sessions.findByTokenDigest(digestSessionToken(f.issued.token)))!;
    await expect(f.sessions.rotate(old.id, {
      ...old, id: randomUUID(), createdAt: new Date(), // same digest forces the unique constraint
    })).rejects.toThrow();
    expect((await f.sessions.findByTokenDigest(old.tokenDigest))?.revokedAt).toBeNull();
  });
});
