import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  CostingService, ProjectCostService, createInMemoryCostingStores, createInMemoryProjectCostStores,
  emptyCostingSourcePorts, emptyProjectCostSourcePorts, DEFAULT_COSTING_MODEL_DEFINITION,
} from '../../src/index.js';

const tenant = TenantId.create('cost-atomicity');
const actor = UserId.create('synthetic-accountant');
const now = '2026-11-03T12:00:00.000Z';

async function fixture(project: boolean) {
  const shared = createInMemoryCostingStores();
  const stores = createInMemoryProjectCostStores();
  await shared.models.insert({ tenant, code: 'standard', name: null,
    definition: DEFAULT_COSTING_MODEL_DEFINITION, status: 'active', objectVersion: 1,
    supersedes: null, auditStatus: 'published', businessTime: now });
  const traditional = new CostingService(shared, {
    ...emptyCostingSourcePorts(), material: { materialLines: async () => [{
      movementId: 'movement-A', workOrderId: 'wo-A', itemId: 'item-A', quantity: 3,
      amountMinor: 750, occurredAt: now,
    }] },
  });
  const sixBlock = new ProjectCostService(stores, shared, {
    ...emptyProjectCostSourcePorts(), equipmentPurchases: { equipmentPurchases: async () => [{
      purchaseOrderId: 'po-A', lineNo: 1, workOrderId: 'wo-A', itemId: 'equipment-A', drawingNo: null,
      quantity: 3, receivedQty: 3, unitPriceMinor: 250, amountMinor: 750,
      equipmentListingLineId: 'listing-equipment-A', equipmentRef: null,
    }] },
  });
  const run = (id: string) => {
    const common = { tenantId: tenant, issuedBy: actor, operationId: OperationId.create(id), expectedRevision: 'initial' as const, issuedAt: now };
    return project
      ? sixBlock.execute(tenant, makeCommandEnvelope({ ...common, command: { kind: 'costing.project.rebuild.v1', payload: { workOrderId: 'wo-A' } } }))
      : traditional.execute(tenant, makeCommandEnvelope({ ...common, command: { kind: 'costing.rebuild.v1', payload: { workOrderId: 'wo-A' } } }));
  };
  const entries = project ? stores.projectEntries : shared.entries;
  const snapshots = project ? stores.projectSnapshots : shared.snapshots;
  const sourceClaim = project ? 'costing-project-pc:eqp:po-A:1' : 'costing-ledger-mat:movement-A';
  return { shared, entries, snapshots, run, sourceClaim };
}

describe.each([false, true])('F7 atomic rebuild, project=%s', project => {
  it.each(['claim', 'entry', 'event'] as const)('failure after %s rolls back every write; same-operation retry commits exactly once', async stage => {
    const f = await fixture(project);
    let armed = true;
    if (stage === 'claim') {
      const original = f.shared.operations.claim.bind(f.shared.operations);
      vi.spyOn(f.shared.operations, 'claim').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (armed && args[1] === f.sourceClaim) { armed = false; throw new Error('synthetic claim failure'); }
        return result;
      });
    } else if (stage === 'entry') {
      // Both interfaces share the callable shape, while their row types differ.
      const target = f.entries as unknown as { insert(input: unknown): Promise<unknown> };
      const original = target.insert.bind(target);
      vi.spyOn(target, 'insert').mockImplementation(async input => {
        const result = await original(input);
        if (armed) { armed = false; throw new Error('synthetic entry failure'); }
        return result;
      });
    } else {
      const original = f.shared.events.append.bind(f.shared.events);
      vi.spyOn(f.shared.events, 'append').mockImplementation(async event => {
        await original(event);
        if (armed) { armed = false; throw new Error('synthetic event failure'); }
      });
    }
    if (stage === 'event') expect(await f.run('retry-same')).toMatchObject({ status: 'indeterminate', retrySafe: true });
    else await expect(f.run('retry-same')).rejects.toThrow('synthetic');
    expect(await f.entries.list(tenant)).toEqual([]);
    expect(await f.snapshots.listByWorkOrder(tenant, 'wo-A')).toEqual([]);
    expect(await f.shared.events.list(tenant)).toEqual([]);
    const retry = await f.run('retry-same');
    expect(retry).toMatchObject({ status: 'committed', entriesCommitted: 1, totals: { grandMinor: 750 } });
    expect(await f.entries.list(tenant)).toHaveLength(1);
    expect(await f.snapshots.listByWorkOrder(tenant, 'wo-A')).toHaveLength(1);
    expect(await f.shared.events.list(tenant)).toHaveLength(2); // one entry + one snapshot event
    expect(await f.run('retry-same')).toMatchObject({ status: 'rejected' });
    expect(await f.run('explicit-rebuild-again')).toMatchObject({ status: 'committed', entriesCommitted: 0, snapshotChanged: false });
    expect(await f.entries.list(tenant)).toHaveLength(1);
    expect(await f.snapshots.listByWorkOrder(tenant, 'wo-A')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('an old orphan source claim is repaired by explicit rebuild instead of silently skipping the missing fact', async () => {
    const f = await fixture(project);
    await f.shared.operations.claim(tenant, f.sourceClaim, 'legacy-failed-rebuild');
    expect(await f.run('repair-orphan')).toMatchObject({ status: 'committed', entriesCommitted: 1, totals: { grandMinor: 750 } });
    expect(await f.entries.list(tenant)).toHaveLength(1);
    expect(await f.shared.events.list(tenant)).toHaveLength(2);
  });

  it('concurrent explicit rebuilds serialize the same source and do not append duplicate deltas', async () => {
    const f = await fixture(project);
    const results = await Promise.all([f.run('parallel-A'), f.run('parallel-B')]);
    expect(results.map(result => result.status)).toEqual(['committed', 'committed']);
    expect(await f.entries.list(tenant)).toHaveLength(1);
    expect(await f.snapshots.listByWorkOrder(tenant, 'wo-A')).toHaveLength(1);
  });
});
