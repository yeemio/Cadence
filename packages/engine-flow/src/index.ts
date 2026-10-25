/**
 * @smes/engine-flow —— 审批流配置引擎（XState 之上的自研薄层）。
 *
 * 分层（ADR-0010 条 2 状态集配置分离首个落地）：
 * - config.ts          版本化配置形状 + 校验冻结（状态集是配置，不是内核；含状态级超时）
 * - default-config.ts  默认通用审批配置（draft → submitted → 评审循环 → 终态）
 * - machine.ts         XState 机器工厂 + 守卫合同（守卫引用按名解析）
 * - record.ts          审批记录（对齐 DomainReview 语义，构造即深冻结）
 * - events.ts          审批事件（BusinessEvent 精简子集，append-only）
 * - runtime.ts         运行时薄层（send / can / snapshot / stop / 账本 / 超时自动迁移）
 * - timer.ts           定时器端口 + 默认 setTimeout 实现 + 确定性假时钟
 * - store.ts           持久化端口（记录/事件存储，append-only）+ 内存实现
 * - guards.ts          常用守卫库（quorum / role / version，纯函数）
 */
export {
  APPROVAL_FLOW_CONFIG_SCHEMA_VERSION,
  defineApprovalFlowConfig,
} from './config.js';
export type {
  ApprovalFlowConfig,
  ApprovalFlowConfigSchemaVersion,
  ApprovalStateDef,
  ApprovalTransitionRule,
  ApprovalDecisionKind,
} from './config.js';
export { DEFAULT_APPROVAL_FLOW_CONFIG } from './default-config.js';
export type { ApprovalGuard, ApprovalGuardContext, ApprovalGuardRegistry, ApprovalFlowMachine } from './machine.js';
export { createApprovalFlowMachine } from './machine.js';
export {
  makeApprovalRecord,
} from './record.js';
export type {
  ApprovalDecision,
  ApprovalDecisionInput,
  ApprovalRecord,
  ApprovalRecordInput,
  EvidenceRef,
} from './record.js';
export { makeApprovalEvent, toBusinessEventInput } from './events.js';
export type { ApprovalEvent, ApprovalEventInput, ApprovalEventPayload } from './events.js';
export { startApprovalFlow } from './runtime.js';
export type {
  ApprovalFlowRuntime,
  ApprovalFlowSnapshot,
  ApprovalSendOutcome,
  ApprovalSubjectRef,
  StartApprovalFlowParams,
} from './runtime.js';
export { DEFAULT_TIMER_PORT, createFakeTimerPort } from './timer.js';
export type { ApprovalTimerPort, ApprovalTimerHandle, FakeApprovalTimerPort } from './timer.js';
export { createInMemoryApprovalRecordStore, createInMemoryApprovalEventStore } from './store.js';
export type {
  ApprovalAggregateKey,
  ApprovalRecordStore,
  ApprovalRecordStoreEntry,
  ApprovalEventStore,
  ApprovalEventPage,
  ApprovalEventCursor,
} from './store.js';
export { quorumGuard, roleGuard, versionGuard } from './guards.js';
export type { QuorumGuardOptions, RoleGuardOptions } from './guards.js';
