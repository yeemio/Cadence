import type { TenantId } from '@smes/business-core';

/** A costing command's claims, facts, snapshots and events commit together. */
export type CostingTransaction = <T>(tenant: TenantId, run: () => Promise<T>) => Promise<T>;

interface MemoryParticipant { checkpoint(): () => void; }
const queues = new WeakMap<object, { tail: Promise<void> }>();

/** In-memory fallback only. External adapters must supply their real transaction.
 * Both cost services use the shared operation store as lock owner, so their
 * rollback checkpoints cannot erase another command's committed state.
 */
export function memoryCostingTransaction(participants: readonly object[], owner: object): CostingTransaction {
  let queue = queues.get(owner);
  if (!queue) { queue = { tail: Promise.resolve() }; queues.set(owner, queue); }
  const shared = queue;
  return async (_tenant, run) => {
    const previous = shared.tail;
    let release!: () => void;
    shared.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const undo: (() => void)[] = [];
    try {
      for (const participant of participants) {
        if (!('checkpoint' in participant) || typeof participant.checkpoint !== 'function') {
          throw new Error('costing: external stores require a transaction adapter');
        }
        undo.push((participant as MemoryParticipant).checkpoint());
      }
      return await run();
    } catch (error) {
      for (const restore of undo.reverse()) restore();
      throw error;
    } finally { release(); }
  };
}

class RollbackOutcome<T> { constructor(readonly result: T) {} }

/** A returned rejected/indeterminate outcome must also roll back, not commit. */
export async function atomicCostingOutcome<T extends { readonly status: string }>(
  transaction: CostingTransaction, tenant: TenantId, run: () => Promise<T>,
): Promise<T> {
  try {
    return await transaction(tenant, async () => {
      const result = await run();
      if (result.status !== 'committed') throw new RollbackOutcome(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RollbackOutcome) return error.result as T;
    throw error;
  }
}
