/**
 * dispatch 售后报销 id 生成器（U5 A12）。前缀 + uuidv7：与 dispatch-ids 同
 * 口径（uuidv7 复用 dispatch-ids 的模块内生成器；跨模块引用一律 opaque）。
 */
import { uuidv7 } from './dispatch-ids.js';

/** 售后报销单 id：acl-<uuidv7>。 */
export function newAftercareClaimId(): string {
  return `acl-${uuidv7()}`;
}

/** 售后报销行 id：acll-<uuidv7>。 */
export function newAftercareClaimLineId(): string {
  return `acll-${uuidv7()}`;
}
