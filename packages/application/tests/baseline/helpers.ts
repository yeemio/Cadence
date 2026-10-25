/**
 * baseline 测试公共夹具（M2-W2）：命令信封构造 + 内存服务装配。
 * 复杂对账夹具（供活系统黑盒比对）在 @smes/testkit；本文件只服务包内行为测试。
 */
import { makeCommandEnvelope, TenantId, UserId, OperationId, type BusinessEvent, type CommandOutcome } from '@smes/business-core';
import { InMemoryItemStore } from '../../src/masterdata/in-memory-masterdata-stores.js';
import type { ItemStore } from '../../src/masterdata/masterdata-stores.js';
import type { BaselineCommandEnvelope, BaselineCommandKind } from '../../src/baseline/baseline-input.js';
import { BaselineService } from '../../src/baseline/baseline.service.js';
import { createInMemoryBaselineStores } from '../../src/baseline/in-memory-baseline-stores.js';
import type { BaselineServiceOptions } from '../../src/baseline/baseline.service.js';

/** 断言命令已落账并取其事件（类型守卫，替代 as 断言）。 */
export function committedEvents(outcome: CommandOutcome): readonly BusinessEvent[] {
  if (outcome.status !== 'committed') {
    throw new Error(`expected committed outcome, got '${outcome.status}': ${'reason' in outcome ? outcome.reason : ''}`);
  }
  return outcome.events;
}

export const t1 = TenantId.create('t1');
export const t2 = TenantId.create('t2');
export const techUser = UserId.create('u-tech-01');

let counter = 0;

/** 直取命令信封（服务/端口路径用；tenant/操作者显式注入，不经 HTTP 体）。 */
export function envelope(
  kind: BaselineCommandKind,
  payload: unknown,
  options: { expectedRevision?: number | 'initial'; operationId?: string; issuedAt?: string } = {},
): BaselineCommandEnvelope {
  counter += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: techUser,
    operationId: OperationId.create(options.operationId ?? `op-baseline-${counter}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: options.issuedAt ?? '2026-10-25T10:00:00.000Z',
    command: { kind, payload },
  });
}

/** 装配全内存服务（物料库可注入预置条目）。 */
export function newService(itemLibrary: ItemStore = new InMemoryItemStore(), options?: BaselineServiceOptions): BaselineService {
  return new BaselineService(createInMemoryBaselineStores(), itemLibrary, options);
}

/** 预置物品库（物料校验行为测试的比对基准）。 */
export function seedItemLibrary(): InMemoryItemStore {
  return new InMemoryItemStore();
}

export function freshOperationId(): string {
  counter += 1;
  return `op-baseline-${counter}`;
}
