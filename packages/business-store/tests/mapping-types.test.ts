/**
 * 映射类型测试（编译期断言为主，运行期为空操作）：
 * 存储侧行形状必须完整覆盖 business-core 领域形状的字段面——
 * 漏映射即编译失败（typecheck 红），不改核心公共 API。
 */
import { describe, expect, it } from 'vitest';
import {
  TenantId,
  type BusinessEvent,
  type EvidenceColumns,
  type OutboxRecord,
} from '@smes/business-core';
import {
  asAppendOnly,
  buildEvidenceColumns,
  buildWorkOrderRecordCreate,
  fromBusinessEventRow,
  toBusinessEventRow,
  toOutboxRecord,
  uuidv7,
  type BusinessEventRow,
  type EvidenceColumnsRow,
  type OutboxRow,
  type WorkOrderRecordRow,
} from '../src/index.js';

const tenant = TenantId.create('t-typecheck');

describe('字段面映射（编译期）', () => {
  it('EvidenceColumns 每个字段在 EvidenceColumnsRow 有对应列', () => {
    const mapping: Record<keyof EvidenceColumns, keyof EvidenceColumnsRow> = {
      id: 'id',
      objectVersion: 'objectVersion',
      auditStatus: 'auditStatus',
      provenance: 'provenance',
      supersedes: 'supersedes',
      businessTime: 'businessTime',
      availableTime: 'availableTime',
    };
    expect(Object.keys(mapping)).toContain('id');
  });

  it('OutboxRecord 每个字段在 OutboxRow 有对应列（tenant_id 为存储侧增列）', () => {
    const mapping: Record<keyof OutboxRecord, keyof OutboxRow> = {
      eventId: 'eventId',
      createdAt: 'createdAt',
      attempts: 'attempts',
      lastAttemptAt: 'lastAttemptAt',
      nextAttemptAt: 'nextAttemptAt',
      deliveredAt: 'deliveredAt',
    };
    expect(Object.keys(mapping)).toContain('deliveredAt');
  });

  it('BusinessEvent 每个字段在 BusinessEventRow 有对应列（aggregate 扁平化为三列）', () => {
    const mapping: Record<Exclude<keyof BusinessEvent, 'aggregate'>, keyof BusinessEventRow> = {
      eventId: 'eventId',
      eventType: 'eventType',
      tenantId: 'tenantId',
      occurredAt: 'occurredAt',
      businessTime: 'businessTime',
      availableTime: 'availableTime',
      provenance: 'provenance',
      payload: 'payload',
    };
    expect(Object.keys(mapping)).toContain('payload');
  });

  it('构造器输出可整体展开进 Prisma create 输入形状（结构兼容示例表）', () => {
    const evidence: EvidenceColumnsRow = buildEvidenceColumns({ tenantId: tenant, auditStatus: 'draft' });
    const fact: WorkOrderRecordRow = buildWorkOrderRecordCreate({
      tenantId: tenant,
      auditStatus: 'draft',
      workOrderId: uuidv7(),
    });
    // 行形状是证据公共列的扩展（复用模式：字段块超集）
    const asEvidence: EvidenceColumnsRow = fact;
    expect(asEvidence.id).toBe(fact.id);
    void evidence;
  });

  it('读回路径产出核心领域形状', () => {
    const event = fromBusinessEventRow({
      eventId: 'evt-typecheck',
      eventType: 'smes.workorder.v1.created',
      tenantId: tenant,
      aggregateId: uuidv7(),
      aggregateType: 'workorder',
      aggregateRevision: 1,
      occurredAt: new Date('2026-10-24T10:00:00Z'),
      payload: { qty: 1 },
    });
    const _event: BusinessEvent = event;
    const record = toOutboxRecord(initialRow());
    const _record: OutboxRecord = record;
    expect(true).toBe(true);
    void _event;
    void _record;

    function initialRow(): OutboxRow {
      return {
        eventId: 'evt-typecheck',
        tenantId: tenant,
        createdAt: new Date('2026-10-24T10:00:00Z'),
        attempts: 0,
        deliveredAt: null,
      };
    }
  });
});

describe('append-only 写门', () => {
  const fullDelegate = {
    create: (data: unknown) => data,
    createMany: (data: unknown) => data,
    createManyAndReturn: (data: unknown) => data,
    findUnique: (args: unknown) => args,
    findUniqueOrThrow: (args: unknown) => args,
    findFirst: (args: unknown) => args,
    findFirstOrThrow: (args: unknown) => args,
    findMany: (args: unknown) => args,
    count: (args: unknown) => args,
    update: (args: unknown) => args,
    updateMany: (args: unknown) => args,
    upsert: (args: unknown) => args,
    delete: (args: unknown) => args,
    deleteMany: (args: unknown) => args,
  };

  it('写门面上保留读 + 追加写', () => {
    const gated = asAppendOnly(fullDelegate);
    expect(typeof gated.create).toBe('function');
    expect(typeof gated.findMany).toBe('function');
    expect(typeof gated.count).toBe('function');
    // 运行时同一对象（零开销）；防线是类型层 + DB 触发器
    expect(gated).toBe(fullDelegate);
  });

  it('update / delete 在类型面上不存在（@ts-expect-error 编译期证明）', () => {
    const gated = asAppendOnly(fullDelegate);
    expect(() => {
      // @ts-expect-error — append-only 写门剥离了 update
      gated.update({ where: { id: 'x' } });
      // @ts-expect-error — append-only 写门剥离了 delete
      gated.delete({ where: { id: 'x' } });
      // @ts-expect-error — append-only 写门剥离了 deleteMany
      gated.deleteMany({});
    }).not.toThrow();
  });

  it('toBusinessEventRow 输入面向领域事件（不改核心 API 的消费面）', () => {
    const row = toBusinessEventRow(fromBusinessEventRow({
      eventId: 'evt-typecheck',
      eventType: 'smes.workorder.v1.created',
      tenantId: tenant,
      aggregateId: uuidv7(),
      aggregateType: 'workorder',
      aggregateRevision: 1,
      occurredAt: new Date('2026-10-24T10:00:00Z'),
      payload: {},
    }));
    expect(row.eventType).toBe('smes.workorder.v1.created');
  });
});
