import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  buildEvidenceColumns,
  buildWorkOrderRecordCreate,
  fromEvidenceRow,
  uuidv7,
  workOrderRecordScope,
} from '../src/index.js';

const tenant = TenantId.create('t-001');

describe('buildEvidenceColumns（公共列构造器）', () => {
  it('缺省：uuidv7 主键、objectVersion=1、无可选列', () => {
    const row = buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft' });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.objectVersion).toBe(1);
    expect(row.auditStatus).toBe('draft');
    expect(row.tenantId).toBe('t-001');
    expect('supersedes' in row).toBe(false);
    expect('businessTime' in row).toBe(false);
    expect('availableTime' in row).toBe(false);
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('显式覆盖：id、objectVersion、supersedes、双时间与 provenance', () => {
    const id = uuidv7();
    const prev = uuidv7();
    const row = buildEvidenceColumns({
      tenantId: tenant,
      auditStatus: 'approved',
      id,
      objectVersion: 3,
      supersedes: prev,
      provenance: { operationId: 'op-001', source: 'smes' },
      businessTime: '2026-10-24T08:00:00.000Z',
      availableTime: '2026-10-24T08:05:00.000Z',
    });
    expect(row.id).toBe(id);
    expect(row.objectVersion).toBe(3);
    expect(row.supersedes).toBe(prev);
    expect(row.provenance).toEqual({ operationId: 'op-001', source: 'smes' });
    expect(row.businessTime).toEqual(new Date('2026-10-24T08:00:00.000Z'));
    expect(row.availableTime).toEqual(new Date('2026-10-24T08:05:00.000Z'));
  });

  it('拒绝：空 auditStatus / objectVersion < 1 / 非 uuid 的 id 与 supersedes / 非法时间', () => {
    expect(() => buildEvidenceColumns({ tenantId: tenant, auditStatus: '  ' })).toThrow(/auditStatus/);
    expect(() => buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft', objectVersion: 0 })).toThrow(/objectVersion/);
    expect(() => buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft', id: 'nope' })).toThrow(/uuidv7/);
    expect(() => buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft', supersedes: 'nope' })).toThrow(/supersedes/);
    expect(() => buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft', businessTime: 'someday' })).toThrow(/businessTime/);
    expect(() => buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft', availableTime: 'now' })).toThrow(/availableTime/);
  });

  it('fromEvidenceRow：行 → 领域形状（ISO 字符串），可空列缺省省略', () => {
    const row = buildEvidenceColumns({
      tenantId: tenant,
      auditStatus: 'draft',
      businessTime: '2026-10-24T08:00:00.000Z',
    });
    const domain = fromEvidenceRow(row);
    expect(domain.businessTime).toBe('2026-10-24T08:00:00.000Z');
    expect(domain.id).toBe(row.id);
    expect('availableTime' in domain).toBe(false);
    expect(Object.isFrozen(domain)).toBe(true);
  });
});

describe('buildWorkOrderRecordCreate（证据列复用模式首个消费者）', () => {
  it('证据公共列 + 领域键 workOrderId，整体冻结', () => {
    const workOrderId = uuidv7();
    const row = buildWorkOrderRecordCreate({
      tenantId: tenant,
      auditStatus: 'draft',
      workOrderId,
      provenance: { operationId: 'op-002' },
    });
    expect(row.workOrderId).toBe(workOrderId);
    expect(row.objectVersion).toBe(1);
    expect(row.tenantId).toBe('t-001');
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('拒绝非 uuid 的 workOrderId；修正链输入可组合', () => {
    expect(() =>
      buildWorkOrderRecordCreate({ tenantId: tenant, auditStatus: 'draft', workOrderId: 'wo-1' }),
    ).toThrow(/workOrderId/);

    const first = buildWorkOrderRecordCreate({ tenantId: tenant, auditStatus: 'draft', workOrderId: uuidv7() });
    const second = buildWorkOrderRecordCreate({
      tenantId: tenant,
      auditStatus: 'draft',
      workOrderId: first.workOrderId,
      objectVersion: first.objectVersion + 1,
      supersedes: first.id,
    });
    expect(second.objectVersion).toBe(2);
    expect(second.supersedes).toBe(first.id);
    expect(second.workOrderId).toBe(first.workOrderId);
  });

  it('workOrderRecordScope：租户贯通读回键（品牌化 tenantId 入参）', () => {
    const scope = workOrderRecordScope(tenant, uuidv7());
    expect(scope.tenantId).toBe('t-001');
    expect(Object.isFrozen(scope)).toBe(true);
  });
});
