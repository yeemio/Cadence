/** Optional real-PG proof. Requires a loopback disposable database; never reads DATABASE_URL. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  CostingService, ProjectCostService, DEFAULT_COSTING_MODEL_DEFINITION,
  emptyCostingSourcePorts, emptyProjectCostSourcePorts,
} from '@smes/application';
import { connectCostingStore } from '../src/costing/pg-costing-stores.js';
import { connectProjectCostStore } from '../src/costing/pg-project-cost-stores.js';
import { runWithRlsTenant } from '../src/rls-session.js';

const url = process.env['CADENCE_COST_TEST_DATABASE_URL'];
const disconnect: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(disconnect.splice(0).map(close => close()));
});

describe.skipIf(!url)('F7 real PG transaction propagation across both cost clients', () => {
  it.each([false, true].flatMap(project => ['entry', 'event'].map(stage => ({ project, stage }))))(
    '$project / failure at $stage rolls back claims, entries, snapshots, events and permits same-op retry', async ({ project, stage }) => {
      const parsed = new URL(url!);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/cadence_pr5_test') {
        throw new Error('Requires loopback disposable database cadence_pr5_test');
      }
      vi.stubEnv('SMES_RLS_SESSION', 'on');
      const tenant = TenantId.create(`pr5-${randomUUID()}`);
      const shared = connectCostingStore({ datasourceUrl: url! });
      const projectHandle = connectProjectCostStore({ datasourceUrl: url! });
      disconnect.push(() => shared.disconnect(), () => projectHandle.disconnect());
      await runWithRlsTenant(tenant, () => shared.modelStore.insert({ tenant, code: 'standard', name: null,
        definition: DEFAULT_COSTING_MODEL_DEFINITION, status: 'active', objectVersion: 1, supersedes: null, auditStatus: 'published' }));
      const projectStores = { projectEntries: projectHandle.projectEntryStore, projectSnapshots: projectHandle.projectSnapshotStore, priceEntries: projectHandle.priceEntryStore };
      const classic = new CostingService(shared.stores, { ...emptyCostingSourcePorts(), material: { materialLines: async () => [{
        movementId: 'movement-A', workOrderId: 'wo-A', itemId: 'item-A', quantity: 3, amountMinor: 750, occurredAt: '2026-11-03T00:00:00.000Z',
      }] } }, undefined, { transaction: shared.transaction });
      const sixBlock = new ProjectCostService(projectStores, shared.stores, { ...emptyProjectCostSourcePorts(),
        aftercareClaims: { aftercareClaims: async () => [{ claimId: 'claim-A', dispatchId: 'dispatch-A', workOrderId: 'wo-A', reimburseMinor: 750, filedAt: '2026-11-03T00:00:00.000Z' }] },
      }, { transaction: shared.transaction });
      const entries = project ? projectStores.projectEntries : shared.entryStore;
      const snapshots = project ? projectStores.projectSnapshots : shared.snapshotStore;
      if (stage === 'entry') vi.spyOn(entries, 'insert').mockRejectedValueOnce(new Error('synthetic detail failure after source claim'));
      else {
        const append = shared.eventStore.append.bind(shared.eventStore);
        vi.spyOn(shared.eventStore, 'append').mockImplementationOnce(async event => { await append(event); throw new Error('synthetic event failure'); });
      }
      const run = () => {
        const common = { tenantId: tenant, issuedBy: UserId.create('synthetic-accountant'), operationId: OperationId.create('same-op'), expectedRevision: 'initial' as const, issuedAt: '2026-11-03T00:00:00.000Z' };
        return project
          ? sixBlock.execute(tenant, makeCommandEnvelope({ ...common, command: { kind: 'costing.project.rebuild.v1', payload: { workOrderId: 'wo-A' } } }))
          : classic.execute(tenant, makeCommandEnvelope({ ...common, command: { kind: 'costing.rebuild.v1', payload: { workOrderId: 'wo-A' } } }));
      };
      if (stage === 'entry') await expect(run()).rejects.toThrow('synthetic');
      else expect(await run()).toMatchObject({ status: 'indeterminate', retrySafe: true });
      await runWithRlsTenant(tenant, async () => {
        expect(await entries.list(tenant)).toEqual([]);
        expect(await snapshots.listByWorkOrder(tenant, 'wo-A')).toEqual([]);
        expect(await shared.eventStore.list(tenant)).toEqual([]);
      });
      expect(await run()).toMatchObject({ status: 'committed', entriesCommitted: 1, totals: { grandMinor: 750 } });
      await runWithRlsTenant(tenant, async () => {
        expect(await entries.list(tenant)).toHaveLength(1);
        expect(await snapshots.listByWorkOrder(tenant, 'wo-A')).toHaveLength(1);
        expect(await shared.eventStore.list(tenant)).toHaveLength(2);
      });
      expect(await run()).toMatchObject({ status: 'rejected' });
      // No deletes of cost evidence: each run uses a fresh synthetic tenant.
    },
  );
});
