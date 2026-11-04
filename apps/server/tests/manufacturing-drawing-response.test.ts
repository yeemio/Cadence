import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import {
  ManufacturingService,
  REQUEST_USER_KEY,
  TenantContext,
  digest,
  type AuthenticatedRequest,
  type ControlKind,
  type ControlRecord,
  type Data,
  type ManufacturingStore,
  type SourceKind,
} from '@smes/application';
import {
  ManufacturingController,
  StockQualityController,
  type ManufacturingRuntime,
} from '../src/manufacturing-http.js';

const tenant = TenantId.create('default');
const fileA = 'storage://private-drawings/part-A/v1.pdf';
const fileB = 'storage://private-drawings/part-A/v2.pdf';
const request = (role: string): AuthenticatedRequest => ({ [REQUEST_USER_KEY]: UserId.create(role) });

function fixture() {
  const records = new Map<ControlKind, ControlRecord[]>();
  const operations = new Map<string, Data>();
  const events: Data[] = [];
  const sources: Partial<Record<SourceKind, Data[]>> = {
    workorder: [{ id: 'wo-A' }],
    listing: [{ id: 'line-A', workOrderId: 'wo-A', drawingNo: 'part-A' }],
    routing: [{ id: 'routing-A', code: 'part-A', version: 1 }],
    drawing: [
      { id: 'drawing-A-1', drawingId: 'part-A', version: 1, classification: 'restricted', fileRef: fileA },
      { id: 'drawing-A-2', drawingId: 'part-A', version: 2, classification: 'restricted', fileRef: fileB },
    ],
  };
  // Return actual stored objects, not defensive copies: a mutating projection
  // would corrupt the before/after comparisons below, just as it would in a cache.
  const store: ManufacturingStore = {
    transaction: async (_t, run) => run(),
    list: async (_t, kind) => records.get(kind) ?? [],
    find: async (_t, kind, id) => records.get(kind)?.find(row => row.id === id) ?? null,
    save: async (_t, kind, value, expected) => {
      const bucket = records.get(kind) ?? [];
      const saved = { ...value, version: expected === null ? 1 : expected + 1 };
      records.set(kind, [...bucket.filter(row => row.id !== value.id), saved]);
      return saved;
    },
    sources: async (_t, kind) => sources[kind] ?? [],
    source: async (_t, kind, id) => sources[kind]?.find(row => row['id'] === id) ?? null,
    roles: async (_t, actor) => actor.startsWith('mfg-') ? [actor] : [],
    event: async (_t, _op, _actor, _kind, _id, payload) => { events.push(payload); },
    operation: async (_t, op) => operations.get(op) ?? null,
    saveResult: async (_t, op, result) => { operations.set(op, result); },
    lots: async () => [],
    saveLot: async () => {},
    qualityReservations: async () => [],
    saveQualityReservation: async () => {},
    qualityEvent: async () => true,
    qualityEvents: async () => [],
  };
  const control = new ManufacturingService(store);
  const qualityResult = { status: 'committed', result: { evidence: { file_ref: fileA, quantity: 3 } } };
  const runtime = {
    control,
    quality: { reconcile: async () => qualityResult, levels: async () => [] },
  } as unknown as ManufacturingRuntime;
  const context = new TenantContext();
  const controller = new ManufacturingController(context, runtime);
  const command = (actor: string, op: string, kind: string, payload: Data, revision: unknown = 'initial') =>
    controller.command(request(actor), { operationId: op, expectedRevision: revision, command: { kind, payload } });
  return { controller, command, records, operations, events, sources, store, runtime, context, qualityResult };
}

function noContentReference(response: unknown) {
  const body = JSON.stringify(response);
  expect(body).not.toContain('fileRef');
  expect(body).not.toContain('file_ref');
  expect(body).not.toContain('storage://private-drawings/');
}

const engineeringInput = {
  workOrderId: 'wo-A', versionLabel: 'A', listingLineIds: ['line-A'],
  drawingRevisionIds: ['drawing-A-1'], routingIds: ['routing-A'], basis: 'approved source',
};

describe('F1 manufacturing HTTP response boundary', () => {
  it.each(['mfg-e01', 'mfg-e02', 'mfg-e05', 'mfg-e07', 'mfg-e08', 'mfg-e10', 'mfg-e13'])(
    '%s sees metadata without content references in current sources or historical nested snapshots',
    async role => {
      const f = fixture();
      const historical: ControlRecord = {
        id: 'historical-change', tenantId: String(tenant), sourceId: 'wo-A', state: 'approved', version: 2,
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
        data: { snapshots: [{ snapshot: { drawings: [
          { id: 'old-camel', fileRef: fileA, version: 1 },
          { id: 'old-snake', file_ref: fileB, version: 2 },
        ], routings: [], active: true, quantity: 0, note: null } }] },
      };
      f.records.set('engineering', [historical]);
      f.records.set('binding', [{ ...historical, id: 'historical-binding', data: { kind: 'engineering-version', snapshot: historical.data } }]);
      const before = JSON.stringify({ records: [...f.records], sources: f.sources });
      const body = await f.controller.board(request(role));
      noContentReference(body);
      expect(body?.['roles']).toEqual([role]);
      expect(body?.['cases']).toMatchObject({ engineering: [{ id: 'historical-change', data: {
        snapshots: [{ snapshot: { drawings: [{ id: 'old-camel', version: 1 }, { id: 'old-snake', version: 2 }], active: true, quantity: 0, note: null } }],
      } }] });
      if (['mfg-e02', 'mfg-e05'].includes(role)) {
        expect(body?.['options']).toMatchObject({ drawing: [
          { id: 'drawing-A-1', drawingId: 'part-A', version: 1, classification: 'restricted' },
          { id: 'drawing-A-2', drawingId: 'part-A', version: 2, classification: 'restricted' },
        ] });
      }
      expect(JSON.stringify({ records: [...f.records], sources: f.sources })).toBe(before);
    },
  );

  it('projects initialize/freeze/approve and duplicate command replies without rewriting evidence or hashes', async () => {
    const f = fixture();
    const initial = await f.command('mfg-e05', 'initialize-A', 'mfg.engineering.initialize.v1', engineeringInput);
    noContentReference(initial);
    expect(initial).toMatchObject({ status: 'committed', newRevision: 1 });
    const originalReceipt = JSON.stringify(f.operations.get('initialize-A'));
    expect(originalReceipt).toContain(fileA);
    expect(initial?.['requestHash']).toBe(digest({ kind: 'mfg.engineering.initialize.v1', p: engineeringInput, revision: 'initial' }));
    const duplicate = await f.command('mfg-e05', 'initialize-A', 'mfg.engineering.initialize.v1', engineeringInput);
    noContentReference(duplicate);
    expect(duplicate).toMatchObject({ duplicate: true, requestHash: initial?.['requestHash'] });

    const frozen = await f.command('mfg-e05', 'freeze-B', 'mfg.engineering.freeze.v1', {
      ...engineeringInput, workOrderIds: ['wo-A'], fromVersion: 'A', toVersion: 'B',
      drawingRevisionIds: ['drawing-A-2'], reason: 'engineering change',
    });
    noContentReference(frozen);
    const change = frozen?.['record'] as ControlRecord;
    const approved = await f.command('mfg-e02', 'approve-B', 'mfg.engineering.approve.v1', { id: change.id, basis: 'independent approval' }, change.version);
    noContentReference(approved);
    expect(approved).toMatchObject({ status: 'committed', record: { state: 'approved' } });
    expect(JSON.stringify(f.records.get('engineering'))).toContain(fileB);
    expect(JSON.stringify(f.records.get('binding'))).toContain(fileB);
    expect(JSON.stringify(f.events)).toContain(fileA);
    expect(JSON.stringify(f.operations.get('initialize-A'))).toBe(originalReceipt);
  });

  it('projects pre-fix persisted idempotent receipts on read, including legacy snake-case snapshots', async () => {
    const f = fixture();
    const kind = 'mfg.engineering.initialize.v1';
    const oldReceipt = { status: 'committed', record: { data: { snapshots: [{ file_ref: fileA, version: 1 }] } }, requestHash: digest({ kind, p: engineeringInput, revision: 'initial' }) };
    f.operations.set('old-operation', oldReceipt);
    const before = JSON.stringify(oldReceipt);
    const reply = await f.command('mfg-e05', 'old-operation', kind, engineeringInput);
    noContentReference(reply);
    expect(reply).toMatchObject({ duplicate: true, record: { data: { snapshots: [{ version: 1 }] } } });
    expect(JSON.stringify(f.operations.get('old-operation'))).toBe(before);
    expect(f.events).toHaveLength(0);
  });

  it('projects the quality command branch and quality-lot evidence at the same HTTP boundary', async () => {
    const f = fixture();
    const before = JSON.stringify(f.qualityResult);
    const reply = await f.command('mfg-e10', 'quality-operation', 'mfg.quality.reconcile.v1', {});
    noContentReference(reply);
    expect(reply).toMatchObject({ result: { evidence: { quantity: 3 } } });
    expect(JSON.stringify(f.qualityResult)).toBe(before);
    f.store.lots = async () => [{ id: 'lot-A', tenantId: String(tenant), itemId: 'item-A', warehouseId: 'main', locationId: null, sourceKind: 'receipt', sourceRefId: 'receipt-A', qualityState: 'pending', quantity: 3, receivedAt: '2026-10-01T00:00:00.000Z', evidence: { snapshot: { fileRef: fileA, approved: false } } }];
    const quality = new StockQualityController(f.context, f.runtime);
    noContentReference(await quality.list());
    expect(JSON.stringify(await f.store.lots(tenant))).toContain(fileA);
  });

  it('keeps manufacturing role denial intact', async () => {
    await expect(fixture().controller.board(request('viewer'))).rejects.toMatchObject({ status: 403 });
  });
});
