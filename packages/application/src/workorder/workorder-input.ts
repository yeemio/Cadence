/**
 * workorder 输入解析（HTTP body / query → 业务输入；M2-W1）。
 *
 * 与 org/workbench/approval-input 同一纪律：违规抛 WorkOrderInputError（组合根
 * 映射 400），绝不静默丢弃。命令信封体（POST body）形状：
 *   { operationId, expectedRevision, command: { kind, payload } }
 * ——租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005），控制器
 * 在 makeCommandEnvelope 处补齐后交 service.execute。
 */
import { OperationId, UserId, type ExpectedRevision } from '@smes/business-core';
import { WorkOrderInputError } from './workorder-errors.js';

// ---- 命令动词（02-workorder.md §3 + 派发任务口径：workorder.*.v1） ----

export const WORKORDER_COMMAND_KINDS = [
  'workorder.create.v1',
  'workorder.update.v1',
  'workorder.transition.v1',
  'workorder.close.v1',
  'workorder.attach.v1',
  'workorder.parts.request.v1',
  'workorder.parts.approve.v1',
  'workorder.parts.ship.v1',
  'workorder.kit.refresh.v1',
] as const;

export type WorkOrderCommandKind = (typeof WORKORDER_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface WorkOrderCommand {
  readonly kind: WorkOrderCommandKind;
  readonly payload: unknown;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WorkOrderInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new WorkOrderInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new WorkOrderInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(
  value: unknown,
  what: string,
  min: number,
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

function requireIsoDate(value: unknown, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new WorkOrderInputError(`${what}必须是 ISO 8601 日期时间字符串：${JSON.stringify(value)}`);
  }
  return value;
}

function optionalIsoDate(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIsoDate(value, what);
}

function optionalUserId(value: unknown, what: string): UserId | undefined {
  if (value === undefined || value === null) return undefined;
  return UserId.create(requireBoundedString(value, what, 1, 128));
}

// ---- 信封体解析 ----

export interface WorkOrderEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: WorkOrderCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): WorkOrderEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (expectedRevision !== 'initial' && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)) {
    throw new WorkOrderInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(WORKORDER_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new WorkOrderInputError(
      `command.kind 非法：须为 ${WORKORDER_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new WorkOrderInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload'); // 形状校验；各命令字段由解析器细查
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as WorkOrderCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致（POST /xxx/:id/transitions 只收 transition.v1）。 */
export function parseCommandBodyForKind(input: unknown, expected: WorkOrderCommandKind): WorkOrderEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new WorkOrderInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- 各命令载荷 ----

export interface CreateWorkOrderPayload {
  readonly projectName: string;
  readonly customerRef: string | null;
  readonly salesRep: UserId | null;
  readonly manager: UserId | null;
  readonly plannedDeliveryAt: string | null;
  readonly packagingArrivalAt: string | null;
}

export function parseCreateWorkOrderPayload(input: unknown): CreateWorkOrderPayload {
  const record = requireObject(input, 'workorder.create 载荷');
  return {
    projectName: requireBoundedString(record['projectName'], '项目名 projectName', 1, 200),
    customerRef: optionalBoundedString(record['customerRef'], '客户引用 customerRef', 1, 128) ?? null,
    salesRep: optionalUserId(record['salesRep'], '销售 salesRep') ?? null,
    manager: optionalUserId(record['manager'], '项目经理 manager') ?? null,
    plannedDeliveryAt: optionalIsoDate(record['plannedDeliveryAt'], '计划交付日期 plannedDeliveryAt') ?? null,
    packagingArrivalAt: optionalIsoDate(record['packagingArrivalAt'], '包材到货日期 packagingArrivalAt') ?? null,
  };
}

export interface UpdateWorkOrderPayload {
  readonly customerRef?: string | null;
  readonly projectName?: string;
  readonly salesRep?: UserId | null;
  readonly manager?: UserId | null;
  readonly plannedDeliveryAt?: string | null;
  readonly packagingArrivalAt?: string | null;
}

export function parseUpdateWorkOrderPayload(input: unknown): UpdateWorkOrderPayload {
  const record = requireObject(input, 'workorder.update 载荷');
  const payload: {
    customerRef?: string | null;
    projectName?: string;
    salesRep?: UserId | null;
    manager?: UserId | null;
    plannedDeliveryAt?: string | null;
    packagingArrivalAt?: string | null;
  } = {};
  if (record['customerRef'] !== undefined) {
    payload.customerRef = record['customerRef'] === null ? null : requireBoundedString(record['customerRef'], 'customerRef', 1, 128);
  }
  if (record['projectName'] !== undefined) {
    payload.projectName = requireBoundedString(record['projectName'], 'projectName', 1, 200);
  }
  if (record['salesRep'] !== undefined) {
    payload.salesRep = record['salesRep'] === null ? null : (optionalUserId(record['salesRep'], 'salesRep') ?? null);
  }
  if (record['manager'] !== undefined) {
    payload.manager = record['manager'] === null ? null : (optionalUserId(record['manager'], 'manager') ?? null);
  }
  if (record['plannedDeliveryAt'] !== undefined) {
    payload.plannedDeliveryAt = record['plannedDeliveryAt'] === null ? null : requireIsoDate(record['plannedDeliveryAt'], 'plannedDeliveryAt');
  }
  if (record['packagingArrivalAt'] !== undefined) {
    payload.packagingArrivalAt = record['packagingArrivalAt'] === null ? null : requireIsoDate(record['packagingArrivalAt'], 'packagingArrivalAt');
  }
  if (Object.keys(payload).length === 0) {
    throw new WorkOrderInputError('workorder.update 载荷至少提供 1 个可更新字段');
  }
  return payload;
}

export interface EvidenceRefInput {
  readonly kind: string;
  readonly ref: string;
}

export interface TransitionWorkOrderPayload {
  /** 目标态（九态 id；合法性由配置迁移规则判定，非初版集合 → rejected）。 */
  readonly targetState: string;
  readonly remark: string | null;
  readonly evidence: readonly EvidenceRefInput[];
}

const STATE_ID_LIKE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function parseEvidence(value: unknown): readonly EvidenceRefInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new WorkOrderInputError(`证据 evidence 须为数组：${JSON.stringify(value)}`);
  }
  if (value.length > 50) {
    throw new WorkOrderInputError('证据 evidence 最多 50 条');
  }
  return value.map((entry, index) => {
    const record = requireObject(entry, `evidence[${index}]`);
    return {
      kind: requireBoundedString(record['kind'], `evidence[${index}].kind`, 1, 64),
      ref: requireBoundedString(record['ref'], `evidence[${index}].ref`, 1, 128),
    };
  });
}

export function parseTransitionWorkOrderPayload(input: unknown): TransitionWorkOrderPayload {
  const record = requireObject(input, 'workorder.transition 载荷');
  const targetState = record['targetState'];
  if (typeof targetState !== 'string' || !STATE_ID_LIKE_PATTERN.test(targetState)) {
    throw new WorkOrderInputError(
      `目标态 targetState 非法：须为小写蛇形状态 id（如 in_progress），得到 ${JSON.stringify(targetState)}`,
    );
  }
  return {
    targetState,
    remark: optionalBoundedString(record['remark'], '流转备注 remark', 1, 2000) ?? null,
    evidence: parseEvidence(record['evidence']),
  };
}

export interface CloseWorkOrderPayload {
  readonly remark: string | null;
}

export function parseCloseWorkOrderPayload(input: unknown): CloseWorkOrderPayload {
  const record = requireObject(input, 'workorder.close 载荷');
  return { remark: optionalBoundedString(record['remark'], '关闭备注 remark', 1, 2000) ?? null };
}

export interface AttachPayload {
  readonly name: string;
  readonly kind: string;
  readonly ref: string;
}

const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

export function parseAttachPayload(input: unknown): AttachPayload {
  const record = requireObject(input, 'workorder.attach 载荷');
  const kind = record['kind'];
  if (typeof kind !== 'string' || !SEGMENT_PATTERN.test(kind) || kind.length > 64) {
    throw new WorkOrderInputError(`附件类别 kind 非法：须为单段小写形状（如 drawing），得到 ${JSON.stringify(kind)}`);
  }
  return {
    name: requireBoundedString(record['name'], '附件名 name', 1, 200),
    kind,
    ref: requireBoundedString(record['ref'], '附件指针 ref', 1, 512),
  };
}

export interface PartsRequestPayload {
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly remark: string | null;
}

export function parsePartsRequestPayload(input: unknown): PartsRequestPayload {
  const record = requireObject(input, 'workorder.parts.request 载荷');
  const quantity = record['quantity'];
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) {
    throw new WorkOrderInputError(`申请数量 quantity 须为 (0, 1e9] 内的数：${JSON.stringify(quantity)}`);
  }
  return {
    workOrderId: requireBoundedString(record['workOrderId'], '工作令 workOrderId', 1, 128),
    itemId: requireBoundedString(record['itemId'], '物料 itemId', 1, 128),
    quantity,
    remark: optionalBoundedString(record['remark'], '申请备注 remark', 1, 2000) ?? null,
  };
}

export interface PartsDecisionPayload {
  readonly decision: 'approve' | 'reject';
  readonly remark: string;
}

export function parsePartsDecisionPayload(input: unknown): PartsDecisionPayload {
  const record = requireObject(input, 'workorder.parts.approve 载荷');
  const decision = record['decision'] === undefined ? 'approve' : record['decision'];
  if (decision !== 'approve' && decision !== 'reject') {
    throw new WorkOrderInputError(`决策 decision 须为 approve/reject（缺省 approve），得到 ${JSON.stringify(record['decision'])}`);
  }
  return {
    decision,
    remark: requireBoundedString(record['remark'], '决策理由 remark', 1, 2000),
  };
}

export interface PartsShipPayload {
  readonly shipmentRef: string | null;
  readonly remark: string | null;
}

export function parsePartsShipPayload(input: unknown): PartsShipPayload {
  const record = requireObject(input, 'workorder.parts.ship 载荷');
  return {
    shipmentRef: optionalBoundedString(record['shipmentRef'], '发货单号 shipmentRef', 1, 128) ?? null,
    remark: optionalBoundedString(record['remark'], '发货备注 remark', 1, 2000) ?? null,
  };
}

export function parseKitRefreshPayload(input: unknown): Record<string, unknown> {
  return requireObject(input, 'workorder.kit.refresh 载荷'); // 无必填字段（空对象合法）
}

// ---- 路径/查询参数 ----

/** 路径参数 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what = 'id'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new WorkOrderInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（query；undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new WorkOrderInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 in_progress），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}
