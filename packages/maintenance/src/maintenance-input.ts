/**
 * maintenance 输入解析（M3；HTTP body/query → 业务输入）。
 *
 * 与 payroll/hours/costing 输入同一纪律：违规抛 MaintenanceInputError（组合根映射
 * 400），绝不静默丢弃。命令命名 {module}.{verb}.v1（合同 §3）：计划发布/到期扫描/
 * 任务四命令/记录追加。一切写操作走 smes.command.v1 信封（G1 口径：先解析校验
 * 后记账——被拒命令不占用 operationId）。
 *
 * 到期扫描体例对齐 purchase.overdue.scan.v1 / inspection.overdue.scan.v1 先例
 * （信封命令、载荷无必填字段——asOf 可选注入测试确定性时钟）。
 *
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, UserId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import { MaintenanceInputError } from './maintenance-errors.js';
import {
  MAX_CHECKPOINTS,
  MAX_INTERVAL_DAYS,
  MAX_UPKEEP_ACTIONS,
  isTaskKind,
  isValidCycle,
  isIsoDateTime,
  type MaintenanceCycle,
  type MaintenanceTaskKind,
} from './maintenance-config.js';
import { MaintenancePlanId, MaintenanceTaskId, type MaintenancePlanId as MaintenancePlanIdType, type MaintenanceTaskId as MaintenanceTaskIdType } from './maintenance-ids.js';
import type { CheckpointDef } from './maintenance-stores.js';

// ---- 命令动词（02-maintenance.md §3 命令面） ----

export const MAINTENANCE_COMMAND_KINDS = [
  'maintenance.plan.publish.v1',
  'maintenance.plan.due-scan.v1',
  'maintenance.task.create.v1',
  'maintenance.task.start.v1',
  'maintenance.task.complete.v1',
  'maintenance.task.cancel.v1',
  'maintenance.record.append.v1',
] as const;

export type MaintenanceCommandKind = (typeof MAINTENANCE_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface MaintenanceCommand {
  readonly kind: MaintenanceCommandKind;
  readonly payload: unknown;
}

/** maintenance 命令信封（makeCommandEnvelope 产物；服务层入参形状）。 */
export type MaintenanceCommandEnvelope = CommandEnvelope<MaintenanceCommand>;

const KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MaintenanceInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new MaintenanceInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new MaintenanceInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

/** 计划业务身份：kebab-case（人读稳定码，跨版本不变）。 */
export function requirePlanId(value: unknown, what: string): MaintenancePlanIdType {
  const raw = requireBoundedString(value, what, 1, 128);
  if (!KEBAB_PATTERN.test(raw)) {
    throw new MaintenanceInputError(`${what}须为 kebab-case（小写字母数字段 + 连字符，如 'lathe-daily-check'）：${JSON.stringify(raw)}`);
  }
  return MaintenancePlanId.create(raw);
}

/** 任务行 id（mtk-<uuidv7> 前缀形状；品牌化收口）。 */
export function requireTaskId(value: unknown, what: string): MaintenanceTaskIdType {
  const raw = requireBoundedString(value, what, 1, 128);
  return MaintenanceTaskId.create(raw);
}

/** ISO 8601 日期时间（到期时刻/执行时刻/扫描时点）。 */
export function requireIsoDateTime(value: unknown, what: string): string {
  const raw = requireBoundedString(value, what, 10, 64);
  if (!isIsoDateTime(raw)) {
    throw new MaintenanceInputError(`${what}必须是 ISO 8601 日期时间：${JSON.stringify(raw)}`);
  }
  return raw;
}

// ---- 信封体解析 ----

export interface MaintenanceEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: MaintenanceCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): MaintenanceEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new MaintenanceInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(MAINTENANCE_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new MaintenanceInputError(
      `command.kind 非法：须为 ${MAINTENANCE_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new MaintenanceInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as MaintenanceCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: MaintenanceCommandKind): MaintenanceEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new MaintenanceInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- 周期与点检项解析（版本化计划数据） ----

export function parseCycle(input: unknown): MaintenanceCycle {
  if (!isValidCycle(input)) {
    throw new MaintenanceInputError(
      `cycle 非法：须为 {kind:'daily'} 或 {kind:'interval',days:1~${MAX_INTERVAL_DAYS} 整数}，得到 ${JSON.stringify(input)}`,
    );
  }
  return input;
}

function parseCheckpoints(input: unknown): readonly CheckpointDef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new MaintenanceInputError(`checkpoints 须为数组（<= ${MAX_CHECKPOINTS} 项），得到 ${JSON.stringify(input)}`);
  }
  if (input.length > MAX_CHECKPOINTS) {
    throw new MaintenanceInputError(`checkpoints 超上界：<= ${MAX_CHECKPOINTS} 项，得到 ${input.length}`);
  }
  const seen = new Set<string>();
  return input.map((item, index) => {
    const record = requireObject(item, `checkpoints[${index}]`);
    const checkpointId = requireBoundedString(record['checkpointId'], `checkpoints[${index}].checkpointId`, 1, 64);
    if (!KEBAB_PATTERN.test(checkpointId)) {
      throw new MaintenanceInputError(
        `checkpoints[${index}].checkpointId 须为 kebab-case（计划内唯一），得到 ${JSON.stringify(checkpointId)}`,
      );
    }
    if (seen.has(checkpointId)) {
      throw new MaintenanceInputError(`checkpoints[${index}].checkpointId 计划内重复：'${checkpointId}'`);
    }
    seen.add(checkpointId);
    return {
      checkpointId,
      label: requireBoundedString(record['label'], `checkpoints[${index}].label`, 1, 128),
      ...(record['expectation'] === undefined || record['expectation'] === null
        ? {}
        : { expectation: requireBoundedString(record['expectation'], `checkpoints[${index}].expectation`, 1, 512) }),
    };
  });
}

function parseUpkeepActions(input: unknown): readonly string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new MaintenanceInputError(`upkeepActions 须为字符串数组（<= ${MAX_UPKEEP_ACTIONS} 项），得到 ${JSON.stringify(input)}`);
  }
  if (input.length > MAX_UPKEEP_ACTIONS) {
    throw new MaintenanceInputError(`upkeepActions 超上界：<= ${MAX_UPKEEP_ACTIONS} 项，得到 ${input.length}`);
  }
  return input.map((item, index) => requireBoundedString(item, `upkeepActions[${index}]`, 1, 256));
}

// ---- maintenance.plan.publish.v1 载荷（发布/修订=新版本） ----

export interface MaintenancePlanPublishPayload {
  /** 计划业务身份（kebab；同名修订 = expectedRevision 乐观锁 + 新版本行）。 */
  readonly planId: MaintenancePlanId;
  readonly name: string | null;
  readonly resourceRef: string;
  readonly cycle: MaintenanceCycle;
  readonly checkpoints: readonly CheckpointDef[];
  readonly upkeepActions: readonly string[];
}

export function parsePlanPublishPayload(input: unknown): MaintenancePlanPublishPayload {
  const record = requireObject(input, 'maintenance.plan.publish 载荷');
  return {
    planId: requirePlanId(record['planId'], 'planId'),
    name: optionalBoundedString(record['name'], 'name', 1, 256) ?? null,
    resourceRef: requireBoundedString(record['resourceRef'], 'resourceRef', 1, 128),
    cycle: parseCycle(record['cycle']),
    checkpoints: parseCheckpoints(record['checkpoints']),
    upkeepActions: parseUpkeepActions(record['upkeepActions']),
  };
}

// ---- maintenance.plan.due-scan.v1 载荷（信封命令；无必填字段——对齐 overdue.scan 先例） ----

export interface MaintenanceDueScanPayload {
  /** 扫描时点（缺省服务时钟；注入确定性时钟供测试/回放）。 */
  readonly asOf?: string;
}

export function parseDueScanPayload(input: unknown): MaintenanceDueScanPayload {
  const record = requireObject(input, 'maintenance.plan.due-scan 载荷');
  const asOf = record['asOf'];
  if (asOf === undefined || asOf === null) return {}; // 空对象合法（系统/主管动作）
  return { asOf: requireIsoDateTime(asOf, 'asOf') };
}

// ---- maintenance.task.create.v1 载荷（手工/故障联动建任务） ----

export interface MaintenanceTaskCreatePayload {
  readonly resourceRef: string;
  readonly kind: MaintenanceTaskKind;
  /** baseline 故障上报 id 形状引用（携带则 source=fault 且 kind 须为 repair）。 */
  readonly faultRef?: string;
  /** 溯源计划（手工任务可带；服务层校验存在性）。 */
  readonly planId?: MaintenancePlanId;
  readonly assignee?: UserId;
  /** 手工安排的到期时刻（可选；plan-due 任务由扫描推导）。 */
  readonly dueAt?: string;
}

export function parseTaskCreatePayload(input: unknown): MaintenanceTaskCreatePayload {
  const record = requireObject(input, 'maintenance.task.create 载荷');
  const kindRaw = record['kind'];
  const kind = typeof kindRaw === 'string' && isTaskKind(kindRaw) ? kindRaw : null;
  if (kind === null) {
    throw new MaintenanceInputError(`kind 非法：须为 repair/upkeep/checkpoint 之一，得到 ${JSON.stringify(kindRaw)}`);
  }
  const faultRef = optionalBoundedString(record['faultRef'], 'faultRef', 1, 128);
  if (faultRef !== undefined && kind !== 'repair') {
    throw new MaintenanceInputError(
      `faultRef 只能挂在 repair 任务（故障联动维修，合同 §2），kind='${kind}' 不得携带 faultRef`,
    );
  }
  const assigneeRaw = optionalBoundedString(record['assignee'], 'assignee', 1, 128);
  const dueAtRaw = record['dueAt'];
  const planIdRaw = record['planId'];
  return {
    resourceRef: requireBoundedString(record['resourceRef'], 'resourceRef', 1, 128),
    kind,
    ...(faultRef === undefined ? {} : { faultRef }),
    ...(planIdRaw === undefined || planIdRaw === null ? {} : { planId: requirePlanId(planIdRaw, 'planId') }),
    ...(assigneeRaw === undefined ? {} : { assignee: UserId.create(assigneeRaw) }),
    ...(dueAtRaw === undefined || dueAtRaw === null ? {} : { dueAt: requireIsoDateTime(dueAtRaw, 'dueAt') }),
  };
}

// ---- maintenance.task.start/complete/cancel.v1 载荷 ----

export interface MaintenanceTaskRefPayload {
  readonly taskId: MaintenanceTaskId;
}

export function parseTaskRefPayload(input: unknown, what: string): MaintenanceTaskRefPayload {
  const record = requireObject(input, `${what} 载荷`);
  return { taskId: requireTaskId(record['taskId'], 'taskId') };
}

export interface MaintenanceTaskCancelPayload extends MaintenanceTaskRefPayload {
  /** 撤单原因（仅 scheduled 可撤；留痕进迁移事件）。 */
  readonly reason?: string;
}

export function parseTaskCancelPayload(input: unknown): MaintenanceTaskCancelPayload {
  const base = parseTaskRefPayload(input, 'maintenance.task.cancel');
  const record = requireObject(input, 'maintenance.task.cancel 载荷');
  const reason = optionalBoundedString(record['reason'], 'reason', 1, 512);
  return reason === undefined ? base : { ...base, reason };
}

// ---- maintenance.record.append.v1 载荷（三态记录追加，kind 判别） ----

export type MaintenanceRecordAppendPayload =
  | {
      readonly kind: 'checkpoint';
      readonly resourceRef: string;
      readonly taskId?: MaintenanceTaskId;
      readonly planId?: MaintenancePlanId;
      readonly checkpointId: string;
      readonly result: 'pass' | 'fail';
      readonly performedAt?: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'upkeep';
      readonly resourceRef: string;
      readonly taskId?: MaintenanceTaskId;
      readonly planId?: MaintenancePlanId;
      /** 本次完成的动作（计划 upkeepActions 的子集引用或自由描述；可空=纯备注补录）。 */
      readonly actionsDone?: readonly string[];
      readonly performedAt?: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'repair';
      readonly resourceRef: string;
      readonly taskId?: MaintenanceTaskId;
      readonly faultRef?: string;
      readonly restored: boolean;
      readonly performedAt?: string;
      readonly note?: string;
    };

export function parseRecordAppendPayload(input: unknown): MaintenanceRecordAppendPayload {
  const record = requireObject(input, 'maintenance.record.append 载荷');
  const kind = record['kind'];
  const resourceRef = requireBoundedString(record['resourceRef'], 'resourceRef', 1, 128);
  const taskIdRaw = record['taskId'];
  const taskId = taskIdRaw === undefined || taskIdRaw === null ? undefined : requireTaskId(taskIdRaw, 'taskId');
  const performedAtRaw = record['performedAt'];
  const performedAt =
    performedAtRaw === undefined || performedAtRaw === null
      ? undefined
      : requireIsoDateTime(performedAtRaw, 'performedAt');
  const note = optionalBoundedString(record['note'], 'note', 1, 512);

  if (kind === 'checkpoint') {
    const result = record['result'];
    if (result !== 'pass' && result !== 'fail') {
      throw new MaintenanceInputError(`result 非法：须为 'pass' | 'fail'（人工判定，§10 v1 口径），得到 ${JSON.stringify(result)}`);
    }
    const planIdRaw = record['planId'];
    return {
      kind: 'checkpoint',
      resourceRef,
      ...(taskId === undefined ? {} : { taskId }),
      ...(planIdRaw === undefined || planIdRaw === null ? {} : { planId: requirePlanId(planIdRaw, 'planId') }),
      checkpointId: (() => {
        const raw = requireBoundedString(record['checkpointId'], 'checkpointId', 1, 64);
        if (!KEBAB_PATTERN.test(raw)) {
          throw new MaintenanceInputError(`checkpointId 须为 kebab-case，得到 ${JSON.stringify(raw)}`);
        }
        return raw;
      })(),
      result,
      ...(performedAt === undefined ? {} : { performedAt }),
      ...(note === undefined ? {} : { note }),
    };
  }

  if (kind === 'upkeep') {
    const actionsRaw = record['actionsDone'];
    if (actionsRaw !== undefined && actionsRaw !== null && !Array.isArray(actionsRaw)) {
      throw new MaintenanceInputError(`actionsDone 须为字符串数组，得到 ${JSON.stringify(actionsRaw)}`);
    }
    const planIdRaw = record['planId'];
    return {
      kind: 'upkeep',
      resourceRef,
      ...(taskId === undefined ? {} : { taskId }),
      ...(planIdRaw === undefined || planIdRaw === null ? {} : { planId: requirePlanId(planIdRaw, 'planId') }),
      ...((actionsRaw ?? []) as readonly unknown[]).length === 0
        ? {}
        : { actionsDone: ((actionsRaw ?? []) as readonly unknown[]).map((item, index) => requireBoundedString(item, `actionsDone[${index}]`, 1, 256)) },
      ...(performedAt === undefined ? {} : { performedAt }),
      ...(note === undefined ? {} : { note }),
    };
  }

  if (kind === 'repair') {
    const restored = record['restored'];
    if (typeof restored !== 'boolean') {
      throw new MaintenanceInputError(`restored 须为布尔（是否恢复设备可用），得到 ${JSON.stringify(restored)}`);
    }
    const faultRef = optionalBoundedString(record['faultRef'], 'faultRef', 1, 128);
    return {
      kind: 'repair',
      resourceRef,
      ...(taskId === undefined ? {} : { taskId }),
      ...(faultRef === undefined ? {} : { faultRef }),
      restored,
      ...(performedAt === undefined ? {} : { performedAt }),
      ...(note === undefined ? {} : { note }),
    };
  }

  throw new MaintenanceInputError(`kind 非法：须为 checkpoint/upkeep/repair 之一（三态记录判别），得到 ${JSON.stringify(kind)}`);
}

// ---- 查询参数解析 ----

export function parseIdParam(value: string, what: string): string {
  return requireBoundedString(value, what, 1, 128);
}

export function parseOptionalIsoParam(value: string | undefined, what: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return requireIsoDateTime(value, what);
}
