import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  InMemoryListingLineStore, InMemoryPurchaseOrderStore, InMemoryIssueRecordStore,
  ISSUE_DEMAND_SOURCE, IssueService,
  type IssueCommand, type IssueCommandResult, type IssueCommitted, type IssueDemandSourcePort,
} from '@smes/application';
import { buildAppModule } from '../src/app-registry.js';

const tenant = TenantId.create('pool-tenant');
let seq = 0;
function envelope(kind: IssueCommand['kind'], payload: unknown, expectedRevision: number | 'initial' = 'initial') {
  return makeCommandEnvelope<IssueCommand>({ tenantId: tenant, issuedBy: UserId.create('pool-worker'), operationId: OperationId.create(`pool-${++seq}`), expectedRevision, issuedAt: '2026-10-28T00:00:00.000Z', command: { kind, payload } });
}
function committed(outcome: IssueCommandResult): IssueCommitted {
  expect(outcome.status, JSON.stringify(outcome)).toBe('committed');
  return outcome as IssueCommitted;
}

describe('外购设备同物料共享实收池（IS-020）', () => {
  it('两行实收1只分1，跨行/分次封顶；新增行/重同步保留有效占用，撤销不造供给，退回不篡改历史', async () => {
    const lines = new InMemoryListingLineStore();
    const orders = new InMemoryPurchaseOrderStore();
    const records = new InMemoryIssueRecordStore();
    const append = async (id: string, itemId: string, lineNo: number, origin: 'production' | 'aftermarket' = 'production') => lines.appendLines([{
      tenant, id, workOrderId: 'wo-pool', sheetId: 'sheet-pool', equipmentRef: null, origin, kind: 'equipment', lineNo,
      drawingNo: null, code: itemId, name: id, spec: null, itemId, requiredQty: 1, neededBy: null,
      validationStatus: 'matched', candidateItemId: null, candidateItemCode: null, similarity: 1, basis: 'code-exact', source: 'excel',
    }]);
    await append('line-1', 'item-A', 1); await append('line-2', 'item-A', 2);
    await append('line-B', 'item-B', 3); await append('aftermarket', 'item-A', 4, 'aftermarket');
    const poLines = ['item-A', 'item-B'].map((itemId, i) => ({ lineNo: i + 1, itemId, drawingNo: null, quantity: 1, unitPriceMinor: null, receivedQty: 1 }));
    await orders.create({ tenant, id: 'po-pool', workOrderId: 'wo-pool', flowConfigId: 'purchase-order', state: 'received', objectVersion: 1, supplierRef: null, supplierName: '合成供方', promisedAt: '2026-11-01', lines: poLines, requestIds: [], buyer: null, remark: null });
    const app = await NestFactory.createApplicationContext(buildAppModule(['core', 'issue'], { listingLineStore: lines, listingOrderStore: orders, issueRecordStore: records }), { logger: false });
    try {
      const service = app.get(IssueService, { strict: false });
      const source = app.get<IssueDemandSourcePort>(ISSUE_DEMAND_SOURCE, { strict: false });
      const projected = await source.demandLines(tenant, 'wo-pool');
      expect(projected.filter((r) => r.itemId === 'item-A').map((r) => r.inboundCompletedQty)).toEqual([1, 0, 0]);
      expect(projected.find((r) => r.itemId === 'item-B')?.inboundCompletedQty).toBe(1);
      const sync = () => service.execute(envelope('issue.sync.v1', { workOrderId: 'wo-pool', dispatchKind: 'assembly', rollup: true }));
      const task = committed(await sync()).tasks![0]!;
      const detail = () => service.taskDetail(tenant, task.id);
      const firstDetail = await detail();
      expect(firstDetail.lines).toHaveLength(3);
      const id = (sourceId: string) => firstDetail.lines.find((r) => r.sourceLineId === sourceId)!.lineId;
      const confirm = (entries: { taskLineId: string; quantity: number }[]) => service.execute(envelope('issue.confirm.v1', { lineKind: 'equipment', lines: entries }), task.id);
      const totalA = async () => (await records.list(tenant, { workOrderId: 'wo-pool', state: 'active' })).flatMap((r) => r.lines).filter((r) => r.itemId === 'item-A').reduce((n, r) => n + r.thisQty, 0);
      expect((await confirm([{ taskLineId: id('line-1'), quantity: 1 }, { taskLineId: id('line-2'), quantity: 1 }])).status).toBe('rejected');
      expect(await records.list(tenant)).toHaveLength(0);
      const first = committed(await confirm([{ taskLineId: id('line-1'), quantity: 0.4 }])).record!;
      const originalSnapshot = JSON.stringify(first);
      expect((await confirm([{ taskLineId: id('line-2'), quantity: 0.7 }])).status).toBe('rejected');
      committed(await confirm([{ taskLineId: id('line-1'), quantity: 0.6 }]));
      expect(await totalA()).toBe(1);
      await append('line-0', 'item-A', 5); // 新ID排序在已发行之前，也不能挤走有效占用。
      const repeated = committed(await sync());
      expect(repeated.tasks?.map((r) => r.id)).toEqual([task.id]);
      expect((await detail()).lines.filter((r) => r.sourceLineId.startsWith('line-')).reduce((n, r) => n + (r.sourceLineId === 'line-B' ? 0 : r.availableNowQty), 0)).toBe(0);
      expect((await source.demandLines(tenant, 'wo-pool')).find((r) => r.listingLineId === 'line-1')?.inboundCompletedQty).toBe(1);
      committed(await service.execute(envelope('issue.revoke.v1', {}, first.objectVersion), first.id));
      const revoked = (await records.find(tenant, first.id))!;
      expect(revoked.lines).toEqual(JSON.parse(originalSnapshot).lines);
      expect(await totalA()).toBe(0.6);
      const afterRevoke = await detail();
      const line0 = afterRevoke.lines.find((r) => r.sourceLineId === 'line-0')!;
      expect(line0.availableNowQty).toBeCloseTo(0.4);
      committed(await confirm([{ taskLineId: line0.lineId, quantity: 0.4 }]));
      expect(await totalA()).toBe(1);
      expect((await confirm([{ taskLineId: id('line-2'), quantity: 0.1 }])).status).toBe('rejected');
      expect((await detail()).lines.find((r) => r.sourceLineId === 'line-B')?.availableNowQty).toBe(1);
      committed(await confirm([{ taskLineId: id('line-B'), quantity: 1 }]));
      await orders.advance(tenant, 'po-pool', 1, 'issued', 2, { lines: poLines.map((r) => ({ ...r, receivedQty: r.itemId === 'item-A' ? 0 : 1 })) });
      expect((await detail()).lines.filter((r) => r.sourceLineId !== 'line-B').every((r) => r.availableNowQty === 0)).toBe(true);
      expect((await confirm([{ taskLineId: id('line-2'), quantity: 0.1 }])).status).toBe('rejected');
      expect(await totalA()).toBe(1); // 实收退回不改历史已发。
      expect((await records.find(tenant, first.id))?.lines).toEqual(JSON.parse(originalSnapshot).lines);
    } finally { await app.close(); }
  });
});
