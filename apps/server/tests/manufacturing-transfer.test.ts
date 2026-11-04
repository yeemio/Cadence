import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { ExecutionContext, INestApplicationContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  DispatchService, ReportingService, ManufacturingService, ManufacturingQualityService, ManufacturingCommandGuard,
  InMemoryDispatchOrderStore, InMemoryDispatchDomainEventStore, TenantContext,
  type ControlRecord, type Data, type DispatchCommand, type ManufacturingStore, type SourceKind,
} from '@smes/application';
import { buildAppModule } from '../src/app-registry.js';
import { bindCrossModuleWiring } from '../src/cross-module-wiring.js';
import { ManufacturingTransactionInterceptor } from '../src/manufacturing-http.js';

const tenant = TenantId.create('default'), planner = UserId.create('planner'), operator = UserId.create('approved-operator');
let app: INestApplicationContext | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function fixture(legacyAssignee = false) {
  const orders = new InMemoryDispatchOrderStore(), events = new InMemoryDispatchDomainEventStore();
  app = await NestFactory.createApplicationContext(buildAppModule(['core', 'dispatch', 'reporting'], {
    dispatchOrderStore: orders, dispatchDomainEventStore: events,
  }), { logger: ['error'] });
  bindCrossModuleWiring(app);
  const dispatch = app.get(DispatchService), reporting = app.get(ReportingService), context = app.get(TenantContext);
  let sequence = 0;
  const envelope = (kind: DispatchCommand['kind'], payload: unknown, revision: number | 'initial' = 'initial') => makeCommandEnvelope({
    tenantId: tenant, issuedBy: planner, operationId: OperationId.create(`transfer-${++sequence}`),
    expectedRevision: revision, issuedAt: '2026-11-03T00:00:00.000Z', command: { kind, payload },
  });
  const created = await dispatch.execute(envelope('dispatch.create.v1', { kind: 'part', workOrderId: 'wo-A', drawingNo: 'part-A', operationCode: 'OP-A', quantity: 10 }));
  expect(created.status).toBe('committed');
  if (created.status !== 'committed' || !created.dispatchOrder) throw new Error('fixture create failed');
  const id = created.dispatchOrder.id;
  expect((await dispatch.execute(envelope('dispatch.assign.v1', { assignee: legacyAssignee ? 'old-operator' : operator }, 1), id)).status).toBe('committed');
  expect((await dispatch.execute(envelope('dispatch.start.v1', {}, 2), id)).status).toBe('committed');

  const record = (kind: string, sourceId: string, state: string, data: Data): ControlRecord => ({
    id: `${kind}-A`, tenantId: String(tenant), sourceId, state, version: 1, data,
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
  });
  const schedule = record('schedule', id, 'approved', { dispatchId: id, workOrderId: 'wo-A', processCode: 'OP-A',
    machineId: 'machine-A', machineCode: 'M-A', toolId: 'tool-A', operatorId: operator,
    startsAt: '2026-11-03T08:00:00.000Z', endsAt: '2026-11-03T09:00:00.000Z' });
  const qualification = record('qualification', String(operator), 'active', { processCode: 'OP-A' });
  const sources: Partial<Record<SourceKind, Data[]>> = {
    machine: [{ id: 'machine-A', code: 'M-A', objectVersion: 1, status: 'active' }],
    tool: [{ id: 'tool-A', type: 'tooling', active: true }], user: [{ id: operator, active: true }],
  };
  const store = {
    transaction: async (_tenant: TenantId, run: () => Promise<unknown>) => run(),
    list: async (_tenant: TenantId, kind: string) => kind === 'schedule' ? [schedule] : kind === 'qualification' ? [qualification] : [],
    sources: async (_tenant: TenantId, kind: SourceKind) => sources[kind] ?? [],
    source: async (_tenant: TenantId, kind: SourceKind, sourceId: string) => kind === 'dispatch'
      ? await orders.find(tenant, sourceId) : sources[kind]?.find(row => row['id'] === sourceId) ?? null,
  } as unknown as ManufacturingStore;
  const control = new ManufacturingService(store), quality = new ManufacturingQualityService(store, control);
  const guard = new ManufacturingCommandGuard(control, quality);
  const interceptor = new ManufacturingTransactionInterceptor(context, { control, quality, guard });
  function controlled<T>(kind: string, payload: Data, action: () => Promise<T>) {
    const req = { method: 'POST', url: '/synthetic-command', params: { id }, smesUser: operator,
      body: { operationId: `intercept-${sequence}`, command: { kind, payload } } };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    return context.run(tenant, () => lastValueFrom(interceptor.intercept(ctx, { handle: () => defer(action) })));
  }
  const report = () => controlled('report.submit.v1', { dispatchId: id }, () => reporting.execute(makeCommandEnvelope({
    tenantId: tenant, issuedBy: operator, operationId: OperationId.create(`report-${++sequence}`), expectedRevision: 'initial',
    issuedAt: '2026-11-03T00:00:00.000Z', command: { kind: 'report.submit.v1', payload: { dispatchId: id, doneQty: 1, laborMinutes: 30 } },
  })));
  return { id, dispatch, orders, events, schedule, envelope, controlled, report };
}

describe('F5 real manufacturing interceptor + dispatch/reporting composition', () => {
  it.each([{ operationCode: 'OP-B' }, { operationCode: 'OP-B', assignee: operator }, { assignee: 'unapproved-operator' }])(
    'rejects unapproved target %j before dispatch or event writes, and the original report path remains usable', async payload => {
      const f = await fixture();
      const before = JSON.stringify({ order: await f.orders.find(tenant, f.id), schedule: f.schedule,
        events: await f.events.byAggregate({ id: f.id, type: 'dispatch-order' }) });
      const action = vi.fn(() => f.dispatch.execute(f.envelope('dispatch.transfer.v1', payload, 3), f.id));
      await expect(f.controlled('dispatch.transfer.v1', payload, action)).rejects.toMatchObject({ status: 409 });
      expect(action).not.toHaveBeenCalled();
      expect(JSON.stringify({ order: await f.orders.find(tenant, f.id), schedule: f.schedule,
        events: await f.events.byAggregate({ id: f.id, type: 'dispatch-order' }) })).toBe(before);
      expect(await f.report()).toMatchObject({ status: 'committed' });
    },
  );

  it('retains transfer back to the approved operator on the approved process, followed by successful reporting', async () => {
    const f = await fixture(true);
    const before = JSON.stringify(f.schedule);
    const payload = { assignee: operator, operationCode: ' OP-A ' };
    expect(await f.controlled('dispatch.transfer.v1', payload,
      () => f.dispatch.execute(f.envelope('dispatch.transfer.v1', payload, 3), f.id))).toMatchObject({ status: 'committed' });
    expect(await f.orders.find(tenant, f.id)).toMatchObject({ assignee: operator, operationCode: 'OP-A' });
    expect(JSON.stringify(f.schedule)).toBe(before);
    expect(await f.report()).toMatchObject({ status: 'committed' });
  });
});
