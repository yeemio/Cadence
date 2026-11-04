import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  ListingService, InventoryService, ManufacturingService, ManufacturingQualityService,
  InMemoryItemStore, InMemoryPurchaseOrderStore, InMemoryListingDomainEventStore,
  InMemoryStockAccountStore, InMemoryStockLocationBalanceStore, InMemoryStockMovementStore,
  InMemoryInventoryDomainEventStore, InMemoryInspectionOrderStore, InMemoryInspectionDomainEventStore,
  type Data, type ListingCommand, type ManufacturingStore, type QualityLot, type SourceKind,
} from '@smes/application';
import { buildAppModule } from '../src/app-registry.js';
import { bindCrossModuleWiring } from '../src/cross-module-wiring.js';

const tenant = TenantId.create('default'), actor = UserId.create('synthetic-buyer');
let app: INestApplicationContext | undefined;
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  // The configured default is deliberately different from the first explicit
  // receipt destination. An omitted warehouse on replay must retain that fact.
  vi.stubEnv('SMES_DEFAULT_WAREHOUSE_CODE', 'B');
  const items = new InMemoryItemStore(), orders = new InMemoryPurchaseOrderStore();
  const accounts = new InMemoryStockAccountStore(), balances = new InMemoryStockLocationBalanceStore();
  const movements = new InMemoryStockMovementStore(), inspections = new InMemoryInspectionOrderStore();
  const listingEvents = new InMemoryListingDomainEventStore();
  const inventoryEvents = new InMemoryInventoryDomainEventStore();
  const inspectionEvents = new InMemoryInspectionDomainEventStore();
  const appended = [listingEvents, inventoryEvents, inspectionEvents].map(store => vi.spyOn(store, 'append'));
  app = await NestFactory.createApplicationContext(buildAppModule(['core', 'listing', 'inventory', 'inspection'], {
    itemStore: items, listingOrderStore: orders, listingDomainEventStore: listingEvents,
    inventoryAccountStore: accounts, inventoryLocationBalanceStore: balances, inventoryMovementStore: movements,
    inventoryDomainEventStore: inventoryEvents, inspectionOrderStore: inspections,
    inspectionDomainEventStore: inspectionEvents,
  }), { logger: ['error'] });
  bindCrossModuleWiring(app);
  const listing = app.get(ListingService), inventory = app.get(InventoryService);
  let sequence = 0;
  const envelope = (kind: ListingCommand['kind'], payload: unknown, revision: 'initial' | number = 'initial') => makeCommandEnvelope({
    tenantId: tenant, issuedBy: actor, operationId: OperationId.create(`receipt-${++sequence}`),
    expectedRevision: revision, issuedAt: '2026-11-03T00:00:00.000Z', command: { kind, payload },
  });
  const item = await items.create({ tenant, code: 'PR3-ITEM', name: 'Synthetic receipt item', unit: 'pcs' });
  const warehouses: string[] = [];
  for (const code of ['A', 'B']) {
    const result = await inventory.execute(makeCommandEnvelope({
      tenantId: tenant, issuedBy: actor, operationId: OperationId.create(`warehouse-${code}`),
      expectedRevision: 'initial', issuedAt: '2026-11-03T00:00:00.000Z',
      command: { kind: 'warehouse.define.v1', payload: { code, name: code, locations: [{ code: 'L1' }] } },
    }));
    expect(result.status).toBe('committed');
    if (result.status !== 'committed' || !result.warehouse) throw new Error('warehouse fixture failed');
    warehouses.push(result.warehouse.id);
  }
  const [warehouseA, warehouseB] = warehouses as [string, string];
  const lots = new Map<string, QualityLot>(), qualityEvents: Data[] = [];
  const sourceRows: Partial<Record<SourceKind, () => Promise<readonly unknown[]>>> = {
    movement: () => movements.list(tenant), account: () => accounts.list(tenant),
    balance: () => balances.list(tenant), inspection: () => inspections.list(tenant),
  };
  // Real quality service, observable memory ports; no PG rollback claim. These
  // tests require refusal before writes even without a transaction rollback.
  const store = {
    transaction: async (_t: TenantId, run: () => Promise<unknown>) => run(),
    sources: async (_t: TenantId, kind: SourceKind) => await sourceRows[kind]?.() ?? [],
    lots: async () => [...lots.values()], saveLot: async (_t: TenantId, lot: QualityLot) => { lots.set(lot.id, lot); },
    qualityReservations: async () => [], saveQualityReservation: async () => {},
    qualityEvents: async () => qualityEvents,
    qualityEvent: async (_t: TenantId, sourceKey: string, kind: string, data: Data) => {
      if (qualityEvents.some(row => row['sourceKey'] === sourceKey)) return false;
      qualityEvents.push({ sourceKey, kind, data }); return true;
    },
  } as unknown as ManufacturingStore;
  const quality = new ManufacturingQualityService(store, new ManufacturingService(store));
  inventory.bindQualityControl(quality); // same binding as main.ts

  const request = await listing.execute(envelope('purchase.request.create.v1', {
    workOrderId: 'wo-PR3', kind: 'standard', itemId: item.id, quantity: 15,
  }));
  if (request.status !== 'committed' || !request.purchaseRequest) throw new Error('request fixture failed');
  const submitted = await listing.execute(envelope('purchase.order.submit.v1', {
    workOrderId: 'wo-PR3', supplierRef: 'synthetic-supplier', buyer: actor,
    promisedAt: '2026-11-30T00:00:00.000Z',
    lines: [{ itemId: item.id, quantity: 10, unitPriceMinor: 100 }, { itemId: item.id, quantity: 5, unitPriceMinor: 100 }],
    requestIds: [request.purchaseRequest.id],
  }));
  if (submitted.status !== 'committed' || !submitted.purchaseOrder) throw new Error('order fixture failed');
  const id = submitted.purchaseOrder.id;
  expect(await listing.execute(envelope('purchase.order.approve.v1', { remark: 'synthetic approval' }, 2), id)).toMatchObject({ status: 'committed' });
  expect(await listing.execute(envelope('purchase.order.issue.v1', {}, 3), id)).toMatchObject({ status: 'committed' });
  const first = await listing.execute(envelope('purchase.order.receive.v1', {
    warehouseId: warehouseA, lines: [{ lineNo: 1, receivedQty: 8 }],
  }, 4), id);
  expect(first).toMatchObject({ status: 'committed' });
  expect(await inspections.list(tenant)).toMatchObject([{ quantity: 8, sourceRefId: `${id}#1` }]);
  expect(await quality.levels(tenant)).toMatchObject([{ qtyOnHand: 8, pendingQty: 8, qualifiedQty: 0 }]);
  expect(await listing.execute(envelope('purchase.return.create.v1', {
    purchaseOrderId: id, lines: [{ lineNo: 1, returnedQty: 3, reason: 'synthetic light return' }],
  }))).toMatchObject({ status: 'committed' });
  expect(await orders.find(tenant, id)).toMatchObject({ state: 'issued', objectVersion: 6, lines: [{ receivedQty: 8 }, { receivedQty: 0 }] });

  const inventorySnapshot = async () => ({ accounts: await accounts.list(tenant), balances: await balances.list(tenant),
    movements: await movements.list(tenant), inspections: await inspections.list(tenant),
    lots: [...lots.values()], qualityEvents, inventoryEvents: appended[1]!.mock.calls, inspectionEvents: appended[2]!.mock.calls });
  const snapshot = async () => JSON.stringify({ order: await orders.find(tenant, id), inventory: await inventorySnapshot(), listingEvents: appended[0]!.mock.calls });
  const receive = (payload: unknown) => listing.execute(envelope('purchase.order.receive.v1', payload, 6), id);
  return { id, item, warehouseA, warehouseB, receive, inventory, snapshot, inventorySnapshot, orders, appended };
}

describe('F4 actual listing/inventory/inspection wiring and quality-lot consistency', () => {
  it.each(['quantity-10', 'quantity-zero', 'warehouse-change', 'new-line-before-conflict'])(
    'first receive 8, light return 3, then %s rejects before PO/stock/QC/event changes', async scenario => {
      const f = await fixture();
      const before = await f.snapshot();
      const lines = scenario === 'new-line-before-conflict'
        ? [{ lineNo: 2, receivedQty: 2 }, { lineNo: 1, receivedQty: 8 }]
        : [{ lineNo: 1, receivedQty: scenario === 'quantity-10' ? 10 : scenario === 'quantity-zero' ? 0 : 8 }];
      const receive = () => f.receive({ lines, warehouseId: scenario.includes('quantity') ? f.warehouseA : f.warehouseB });
      if (scenario === 'quantity-zero') await expect(receive()).rejects.toThrow('receivedQty须为');
      else expect(await receive()).toMatchObject({ status: 'rejected' });
      expect(await f.snapshot()).toBe(before);
    },
  );

  it('same receipt replay preserves original warehouse and does not duplicate stock, inspection or quality evidence', async () => {
    const f = await fixture();
    const before = JSON.stringify(await f.inventorySnapshot());
    const listingCount = f.appended[0]!.mock.calls.length;
    expect(await f.receive({ lines: [{ lineNo: 1, receivedQty: 8 }] })).toMatchObject({ status: 'committed' });
    expect(await f.orders.find(tenant, f.id)).toMatchObject({ state: 'received', objectVersion: 7 });
    expect(f.appended[0]!.mock.calls).toHaveLength(listingCount + 1); // explicit PO reconfirmation only
    expect(JSON.stringify(await f.inventorySnapshot())).toBe(before);
    expect(await f.inventory.receivePurchaseStock(tenant, {
      receiptKey: `${f.id}#1`, purchaseOrderId: f.id, itemId: f.item.id, quantity: 8,
    })).toMatchObject({ received: true, duplicate: true });
    expect(JSON.stringify(await f.inventorySnapshot())).toBe(before);
  });

  it('the inventory port also rejects same-key changes to item or source, without relying on PO validation', async () => {
    const f = await fixture();
    const before = await f.snapshot();
    for (const change of [{ itemId: 'another-item' }, { purchaseOrderId: 'another-order' }]) {
      const command = { receiptKey: `${f.id}#1`, purchaseOrderId: f.id, itemId: f.item.id, quantity: 8, ...change };
      expect(await f.inventory.validatePurchaseReceipt(tenant, command)).toMatchObject({ received: false });
      await expect(f.inventory.receivePurchaseStock(tenant, command)).rejects.toThrow('原请求不一致');
      expect(await f.snapshot()).toBe(before);
    }
  });
});
