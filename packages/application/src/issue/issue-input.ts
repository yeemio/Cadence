/**
 * issue 输入解析（U1；HTTP body/query → 业务输入）。与 workorder/listing/
 * dispatch 输入同一纪律：违规抛 IssueInputError（组合根映射 400），绝不静默
 * 丢弃。命令命名 {module}.{verb}.v1：issue.sync / issue.confirm / issue.revoke /
 * issue.cleanup（均 .v1）。信封体形状：{ operationId, expectedRevision,
 * command: { kind, payload } }——租户与操作者不从请求体进（TenantContext /
 * AuthGuard，ADR-0005）。
 */
import { OperationId, type ExpectedRevision } from '@smes/business-core';
import { IssueInputError } from './issue-errors.js';
import {
  ISSUE_CONFIRM_MAX_LINES,
  ISSUE_DISPATCH_KINDS,
  ISSUE_EXPRESS_MAX_IMAGES,
  ISSUE_LINE_KINDS,
  ISSUE_MAX_ALLOCATIONS_PER_LINE,
  ISSUE_MAX_QTY,
  ISSUE_SYNC_MAX_EQUIPMENT_REFS,
  type IssueDispatchKind,
  type IssueLineKind,
} from './issue-config.js';

// ---- 命令动词 ----

export const ISSUE_COMMAND_KINDS = [
  'issue.sync.v1',
  'issue.confirm.v1',
  'issue.revoke.v1',
  'issue.cleanup.v1',
] as const;

export type IssueCommandKind = (typeof ISSUE_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface IssueCommand {
  readonly kind: IssueCommandKind;
  readonly payload: unknown;
}

// ---- 基础形状工具 ----

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new IssueInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new IssueInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new IssueInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

function requireIsoDateTime(value: unknown, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new IssueInputError(`${what}必须是 ISO 8601 日期时间字符串：${JSON.stringify(value)}`);
  }
  return value;
}

function optionalIsoDateTime(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIsoDateTime(value, what);
}

function requireQuantity(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ISSUE_MAX_QTY) {
    throw new IssueInputError(`${what}须为 (0, ${ISSUE_MAX_QTY}] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  what: string,
  maxItems: number,
  itemMax: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new IssueInputError(`${what}须为 1~${maxItems} 个元素的数组`);
  }
  return value.map((entry) => requireBoundedString(entry, `${what} 元素`, 1, itemMax));
}

function optionalStringArray(
  value: unknown,
  what: string,
  maxItems: number,
  itemMax: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new IssueInputError(`${what}须为 1~${maxItems} 个元素的数组`);
  }
  return value.map((entry) => requireBoundedString(entry, `${what} 元素`, 1, itemMax));
}

function requireLineKind(value: unknown, what: string): IssueLineKind {
  if (typeof value !== 'string' || !(ISSUE_LINE_KINDS as readonly string[]).includes(value)) {
    throw new IssueInputError(`${what}非法：须为 ${ISSUE_LINE_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as IssueLineKind;
}

function requireDispatchKind(value: unknown, what: string): IssueDispatchKind {
  if (typeof value !== 'string' || !(ISSUE_DISPATCH_KINDS as readonly string[]).includes(value)) {
    throw new IssueInputError(`${what}非法：须为 ${ISSUE_DISPATCH_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as IssueDispatchKind;
}

function optionalBoolean(value: unknown, what: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new IssueInputError(`${what}必须是布尔值：${JSON.stringify(value)}`);
  }
  return value;
}

// ---- 信封体解析 ----

export interface IssueEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: IssueCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseIssueCommandEnvelopeBody(input: unknown): IssueEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new IssueInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(ISSUE_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new IssueInputError(
      `command.kind 非法：须为 ${ISSUE_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new IssueInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as IssueCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseIssueCommandBodyForKind(input: unknown, expected: IssueCommandKind): IssueEnvelopeBody {
  const parsed = parseIssueCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new IssueInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- issue.sync 载荷（派工触发生成/补全） ----

export interface IssueSyncPayload {
  readonly workOrderId: string;
  readonly dispatchKind: IssueDispatchKind;
  readonly equipmentRefs?: readonly string[] | undefined;
  readonly rollup?: boolean | undefined;
  readonly workOrderLabel?: string | null | undefined;
  readonly plannedStartAt?: string | null | undefined;
  readonly plannedEndAt?: string | null | undefined;
  readonly operators?: readonly string[] | undefined;
  readonly triggerRef?: { readonly type: string; readonly id: string } | null | undefined;
}

export function parseIssueSyncPayload(input: unknown): IssueSyncPayload {
  const record = requireObject(input, 'issue.sync 载荷');
  const equipmentRefsRaw = record['equipmentRefs'];
  const payload: {
    workOrderId: string;
    dispatchKind: IssueDispatchKind;
    equipmentRefs?: readonly string[];
    rollup?: boolean;
    workOrderLabel?: string | null;
    plannedStartAt?: string | null;
    plannedEndAt?: string | null;
    operators?: readonly string[];
    triggerRef?: { readonly type: string; readonly id: string } | null;
  } = {
    workOrderId: requireBoundedString(record['workOrderId'], 'workOrderId', 1, 128),
    dispatchKind: requireDispatchKind(record['dispatchKind'], 'dispatchKind'),
  };
  if (equipmentRefsRaw !== undefined && equipmentRefsRaw !== null) {
    payload.equipmentRefs = requireStringArray(
      equipmentRefsRaw,
      'equipmentRefs',
      ISSUE_SYNC_MAX_EQUIPMENT_REFS,
      128,
    );
  }
  const rollup = optionalBoolean(record['rollup'], 'rollup');
  if (rollup !== undefined) payload.rollup = rollup;
  const workOrderLabel = optionalBoundedString(record['workOrderLabel'], 'workOrderLabel', 1, 200);
  if (workOrderLabel !== undefined) payload.workOrderLabel = workOrderLabel;
  const plannedStartAt = optionalIsoDateTime(record['plannedStartAt'], 'plannedStartAt');
  if (plannedStartAt !== undefined) payload.plannedStartAt = plannedStartAt;
  const plannedEndAt = optionalIsoDateTime(record['plannedEndAt'], 'plannedEndAt');
  if (plannedEndAt !== undefined) payload.plannedEndAt = plannedEndAt;
  const operators = optionalStringArray(record['operators'], 'operators', 50, 64);
  if (operators !== undefined) payload.operators = operators;
  const triggerRaw = record['triggerRef'];
  if (triggerRaw !== undefined && triggerRaw !== null) {
    const trigger = requireObject(triggerRaw, 'triggerRef');
    payload.triggerRef = {
      type: requireBoundedString(trigger['type'], 'triggerRef.type', 1, 64),
      id: requireBoundedString(trigger['id'], 'triggerRef.id', 1, 128),
    };
  }
  return payload;
}

// ---- issue.confirm 载荷（确认发料） ----

/** 确认行载荷：part/equipment 携 quantity；standard/electrical 携库位分配集。 */
export interface IssueConfirmLinePayload {
  readonly taskLineId: string;
  readonly quantity: number | null;
  readonly allocations: readonly {
    readonly locationId: string;
    readonly quantity: number;
    readonly recommended: boolean;
  }[] | null;
}

/** 发货头载荷（配件发料；生产链路可省）。 */
export interface IssueExpressPayload {
  readonly trackingNo: string;
  readonly shipper: string;
  readonly shipTime: string;
  readonly imageRefs: readonly string[];
}

export interface IssueConfirmPayload {
  readonly lineKind: IssueLineKind;
  readonly lines: readonly IssueConfirmLinePayload[];
  readonly express: IssueExpressPayload | null;
  readonly remark: string | null;
}

export function parseIssueConfirmPayload(input: unknown): IssueConfirmPayload {
  const record = requireObject(input, 'issue.confirm 载荷');
  const linesRaw = record['lines'];
  if (!Array.isArray(linesRaw) || linesRaw.length === 0 || linesRaw.length > ISSUE_CONFIRM_MAX_LINES) {
    throw new IssueInputError(`lines 须为 1~${ISSUE_CONFIRM_MAX_LINES} 个元素的数组（必须至少勾选一行）`);
  }
  const lines: IssueConfirmLinePayload[] = linesRaw.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    const taskLineId = requireBoundedString(line['taskLineId'], `lines[${index}].taskLineId`, 1, 128);
    const quantityRaw = line['quantity'];
    const allocationsRaw = line['allocations'];
    let quantity: number | null = null;
    if (quantityRaw !== undefined && quantityRaw !== null) {
      quantity = requireQuantity(quantityRaw, `lines[${index}].quantity`);
    }
    let allocations: IssueConfirmLinePayload['allocations'] = null;
    if (allocationsRaw !== undefined && allocationsRaw !== null) {
      // 两字段都缺 = 勾选但未在出库弹窗确认（standard/electrical 跳过语义——
      // 不发不报错；part/equipment 由 service 按缺 quantity 拒绝）。
      if (!Array.isArray(allocationsRaw) || allocationsRaw.length === 0 || allocationsRaw.length > ISSUE_MAX_ALLOCATIONS_PER_LINE) {
        throw new IssueInputError(
          `lines[${index}].allocations 须为 1~${ISSUE_MAX_ALLOCATIONS_PER_LINE} 个元素的数组`,
        );
      }
      allocations = allocationsRaw.map((rawAllocation, allocationIndex) => {
        const allocation = requireObject(rawAllocation, `lines[${index}].allocations[${allocationIndex}]`);
        const recommendedRaw = allocation['recommended'];
        return {
          locationId: requireBoundedString(
            allocation['locationId'],
            `lines[${index}].allocations[${allocationIndex}].locationId`,
            1,
            128,
          ),
          quantity: requireQuantity(
            allocation['quantity'],
            `lines[${index}].allocations[${allocationIndex}].quantity`,
          ),
          recommended: recommendedRaw === undefined ? false : optionalBoolean(recommendedRaw, `lines[${index}].allocations[${allocationIndex}].recommended`) ?? false,
        };
      });
    }
    return { taskLineId, quantity, allocations };
  });
  const expressRaw = record['express'];
  let express: IssueExpressPayload | null = null;
  if (expressRaw !== undefined && expressRaw !== null) {
    const expressRecord = requireObject(expressRaw, 'express');
    const imageRefsRaw = expressRecord['imageRefs'];
    express = {
      trackingNo: requireBoundedString(expressRecord['trackingNo'], 'express.trackingNo', 1, 64),
      shipper: requireBoundedString(expressRecord['shipper'], 'express.shipper', 1, 100),
      shipTime: requireIsoDateTime(expressRecord['shipTime'], 'express.shipTime'),
      imageRefs:
        imageRefsRaw === undefined || imageRefsRaw === null
          ? []
          : requireStringArray(imageRefsRaw, 'express.imageRefs', ISSUE_EXPRESS_MAX_IMAGES, 512),
    };
  }
  const remark = optionalBoundedString(record['remark'], 'remark', 1, 500);
  return {
    lineKind: requireLineKind(record['lineKind'], 'lineKind'),
    lines,
    express,
    remark: remark ?? null,
  };
}

// ---- issue.revoke 载荷（整单撤销） ----

export interface IssueRevokePayload {
  readonly remark: string | null;
}

export function parseIssueRevokePayload(input: unknown): IssueRevokePayload {
  const record = requireObject(input, 'issue.revoke 载荷');
  const remark = optionalBoundedString(record['remark'], 'remark', 1, 500);
  return { remark: remark ?? null };
}

// ---- issue.cleanup 载荷（撤销派工清理） ----

export interface IssueCleanupPayload {
  readonly workOrderId: string;
  readonly dispatchKind: IssueDispatchKind;
  readonly equipmentRefs?: readonly string[] | undefined;
  readonly includeRollup?: boolean | undefined;
  readonly remark: string | null;
}

export function parseIssueCleanupPayload(input: unknown): IssueCleanupPayload {
  const record = requireObject(input, 'issue.cleanup 载荷');
  const payload: {
    workOrderId: string;
    dispatchKind: IssueDispatchKind;
    equipmentRefs?: readonly string[];
    includeRollup?: boolean;
    remark: string | null;
  } = {
    workOrderId: requireBoundedString(record['workOrderId'], 'workOrderId', 1, 128),
    dispatchKind: requireDispatchKind(record['dispatchKind'], 'dispatchKind'),
    remark: optionalBoundedString(record['remark'], 'remark', 1, 500) ?? null,
  };
  const equipmentRefsRaw = record['equipmentRefs'];
  if (equipmentRefsRaw !== undefined && equipmentRefsRaw !== null) {
    payload.equipmentRefs = requireStringArray(
      equipmentRefsRaw,
      'equipmentRefs',
      ISSUE_SYNC_MAX_EQUIPMENT_REFS,
      128,
    );
  }
  const includeRollup = optionalBoolean(record['includeRollup'], 'includeRollup');
  if (includeRollup !== undefined) payload.includeRollup = includeRollup;
  return payload;
}

// ---- 查询参数解析（列表过滤 / 去发料页） ----

export function parseOptionalFilterParam(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return requireBoundedString(trimmed, what, 1, 128);
}

export function parseIssueTaskStateFilter(value: string | undefined): string | undefined {
  return parseOptionalFilterParam(value, 'state');
}

export function parseIssueRecordStateFilter(value: string | undefined): string | undefined {
  return parseOptionalFilterParam(value, 'state');
}

/** 去发料页明细查询：lineKind / 模块 / 名称 / 待发状态 / 分页。 */
export type IssuePendingFilter = 'partial' | 'all-available' | 'none';

export interface IssueDetailQuery {
  readonly lineKind: IssueLineKind | undefined;
  readonly moduleName: string | undefined;
  readonly name: string | undefined;
  readonly pendingFilter: IssuePendingFilter | undefined;
  readonly current: number;
  readonly size: number;
}

export function parseIssueDetailQuery(params: {
  lineKind?: string | undefined;
  moduleName?: string | undefined;
  name?: string | undefined;
  pendingFilter?: string | undefined;
  current?: string | undefined;
  size?: string | undefined;
}): IssueDetailQuery {
  const lineKindRaw = params.lineKind === undefined ? undefined : params.lineKind.trim();
  const lineKind =
    lineKindRaw === undefined || lineKindRaw.length === 0
      ? undefined
      : requireLineKind(lineKindRaw, 'lineKind');
  const pendingRaw = params.pendingFilter === undefined ? undefined : params.pendingFilter.trim();
  let pendingFilter: IssuePendingFilter | undefined;
  if (pendingRaw !== undefined && pendingRaw.length > 0) {
    if (pendingRaw !== 'partial' && pendingRaw !== 'all-available' && pendingRaw !== 'none') {
      throw new IssueInputError(
        `pendingFilter 非法：须为 partial/all-available/none 之一，得到 ${JSON.stringify(pendingRaw)}`,
      );
    }
    pendingFilter = pendingRaw;
  }
  const currentRaw = params.current === undefined ? undefined : Number.parseInt(params.current, 10);
  const sizeRaw = params.size === undefined ? undefined : Number.parseInt(params.size, 10);
  const current = currentRaw === undefined || Number.isNaN(currentRaw) ? 1 : currentRaw;
  const size = sizeRaw === undefined || Number.isNaN(sizeRaw) ? 20 : sizeRaw;
  if (!Number.isInteger(current) || current < 1 || !Number.isInteger(size) || size < 1 || size > 500) {
    throw new IssueInputError('current 须为 >= 1 的整数，size 须为 1~500 的整数');
  }
  return {
    lineKind,
    moduleName: parseOptionalFilterParam(params.moduleName, 'moduleName'),
    name: parseOptionalFilterParam(params.name, 'name'),
    pendingFilter,
    current,
    size,
  };
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseIssueIdParam(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new IssueInputError(`${what}非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
