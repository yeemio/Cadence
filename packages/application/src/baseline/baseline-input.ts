/**
 * baseline 命令输入解析（M2-W2；M2 通用合同纪律 1：一切写操作走
 * smes.command.v1 CommandEnvelope，命令命名 {module}.{verb}.v1）。
 *
 * 两层解析、两种失败通道：
 *  - 信封层（本文件 parseBaselineCommandSubmission）：operationId / expectedRevision /
 *    issuedAt / command{kind,payload} 形状非法 → 抛 BaselineInputError（HTTP 400，
 *    命令从未成立）；tenantId/issuedBy 不从请求体进（ADR-0005，由控制器注入）；
 *  - 载荷层（本文件 parseXxxPayload，由 BaselineService 调用）：字段取值非法 →
 *    CommandOutcome.rejected（信封成立、命令被业务拒绝——口径统一后被拒不占用
 *    operationId，可同 id 改后重发重新评估）。
 */
import {
  COMMAND_ENVELOPE_CONTRACT,
  makeCommandEnvelope,
  type CommandEnvelope,
  type ExpectedRevision,
  TenantId,
  UserId,
  OperationId,
} from '@smes/business-core';
import { BaselineInputError } from './baseline-errors.js';
import { decimalToMinor, parseMarginPermyriad } from './outsourcing-price.js';
import type { MaterialValidationLine } from './material-validation.js';
import type { StoredMasterStatus } from './baseline-versioning.js';

/** 命令 kind 清单（合同 §3 最小集 + P1 修订命令 + P2/P3 件）。 */
export const BASELINE_COMMAND_KINDS = {
  processDefine: 'baseline.process.define.v1',
  processRevise: 'baseline.process.revise.v1',
  materialValidate: 'baseline.material.validate.v1',
  outsourcingRuleSet: 'baseline.outsourcing.rule.set.v1',
  outsourcingRuleRevise: 'baseline.outsourcing.rule.revise.v1',
  equipmentRegister: 'baseline.equipment.register.v1',
  equipmentRevise: 'baseline.equipment.revise.v1',
  routingDefine: 'baseline.routing.define.v1',
  routingRevise: 'baseline.routing.revise.v1',
  standardtimeDefine: 'baseline.standardtime.define.v1',
  faultReport: 'baseline.fault.report.v1',
  faultResolve: 'baseline.fault.resolve.v1',
} as const;

export type BaselineCommandKind = (typeof BASELINE_COMMAND_KINDS)[keyof typeof BASELINE_COMMAND_KINDS];

/** baseline 命令载荷形状（信封 command 字段）。 */
export interface BaselineCommand {
  readonly kind: BaselineCommandKind;
  readonly payload: unknown;
}

export type BaselineCommandEnvelope = CommandEnvelope<BaselineCommand>;

// ---- 信封层 ----

export interface CommandSubmissionIdentity {
  readonly tenant: TenantId;
  readonly issuedBy: UserId;
}

function requireRecord(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BaselineInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function parseExpectedRevision(value: unknown): ExpectedRevision {
  if (value === 'initial') return 'initial';
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  throw new BaselineInputError(
    `expectedRevision ${JSON.stringify(value)} 非法：须为 'initial' 或 >=1 的整数（objectVersion 乐观锁）`,
  );
}

function parseCommand(value: unknown): BaselineCommand {
  const record = requireRecord(value, 'command');
  const kind = record['kind'];
  if (typeof kind !== 'string' || !Object.values(BASELINE_COMMAND_KINDS).includes(kind as BaselineCommandKind)) {
    throw new BaselineInputError(
      `command.kind ${JSON.stringify(kind)} 非法：须为 ${Object.values(BASELINE_COMMAND_KINDS).join(' / ')} 之一`,
    );
  }
  const payload = record['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new BaselineInputError(`command.payload 必须是对象：${JSON.stringify(payload)}`);
  }
  return { kind: kind as BaselineCommandKind, payload };
}

export interface CommandSubmissionFields {
  readonly operationId: string;
  readonly expectedRevision: ExpectedRevision;
  readonly issuedAt: string;
  readonly command: BaselineCommand;
}

/** 解析命令提交体（POST body：operationId/expectedRevision/issuedAt?/command）。 */
export function parseCommandSubmission(input: unknown): CommandSubmissionFields {
  const record = requireRecord(input, '命令提交体');
  const operationId = record['operationId'];
  if (typeof operationId !== 'string' || operationId.trim().length === 0 || operationId.length > 128) {
    throw new BaselineInputError(`operationId ${JSON.stringify(operationId)} 非法：须为 1~128 非空白字符`);
  }
  const expectedRevision = parseExpectedRevision(record['expectedRevision']);
  const issuedAtRaw = record['issuedAt'];
  const issuedAt = issuedAtRaw === undefined ? new Date().toISOString() : issuedAtRaw;
  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
    throw new BaselineInputError(`issuedAt ${JSON.stringify(issuedAtRaw)} 非法：须为 ISO 8601 时刻（缺省取服务器当前时刻）`);
  }
  return {
    operationId: operationId.trim(),
    expectedRevision,
    issuedAt,
    command: parseCommand(record['command']),
  };
}

/** 提交体 + 身份（租户/操作者，控制器注入）→ 深冻结命令信封。 */
export function makeBaselineCommandEnvelope(
  input: unknown,
  identity: CommandSubmissionIdentity,
): BaselineCommandEnvelope {
  const fields = parseCommandSubmission(input);
  return makeCommandEnvelope<BaselineCommand>({
    tenantId: identity.tenant,
    issuedBy: identity.issuedBy,
    operationId: OperationId.create(fields.operationId),
    expectedRevision: fields.expectedRevision,
    issuedAt: fields.issuedAt,
    command: fields.command,
  });
}

/**
 * 提交体 + 身份 + 端点合法 kind 集 → 深冻结命令信封（P2/P3 新端点用：命令动词
 * 与端点绑定，防止跨资源命令经他端点提交——体例同 inspection 的
 * parseCommandBodyForKind；P1 既有端点行为不动）。
 */
export function makeBaselineCommandEnvelopeForKind(
  input: unknown,
  identity: CommandSubmissionIdentity,
  allowedKinds: readonly BaselineCommandKind[],
): BaselineCommandEnvelope {
  const envelope = makeBaselineCommandEnvelope(input, identity);
  if (!allowedKinds.includes(envelope.command.kind)) {
    throw new BaselineInputError(
      `command.kind '${envelope.command.kind}' 与端点不符：本端点只接受 ${allowedKinds.join(' / ')}`,
    );
  }
  return envelope;
}

// ---- 载荷层（业务拒绝 → rejected outcome 的 reason 文案由 BaselineService 统一包装） ----

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function requireMasterCode(value: unknown, what: string): string {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new BaselineInputError(
      `${what} '${JSON.stringify(value)}' 非法：须为字母/数字开头，仅含字母/数字/点/下划线/连字符（1~64 字符）`,
    );
  }
  return value;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BaselineInputError(`名称必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new BaselineInputError(`名称须为 1~128 个非空白字符：${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** 可选自由文本：undefined → 不动；null → 清空；纯空白 → 清空；超长拒绝。 */
function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new BaselineInputError(`字段 '${field}' 须为字符串或 null：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new BaselineInputError(`字段 '${field}' 超长（>${maxLength}）：${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** 写入态（draft/active，缺省 active——P1 无审批环节，定义即生效；draft 供后续流程预留）。 */
export function parseStoredStatus(value: unknown): StoredMasterStatus {
  if (value === undefined) return 'active';
  if (value === 'draft' || value === 'active') return value;
  throw new BaselineInputError(`status ${JSON.stringify(value)} 非法：须为 'draft' 或 'active'（缺省 'active'）`);
}

export interface ProcessDefinePayload {
  readonly code: string;
  readonly name: string;
  readonly category?: string | null;
  readonly description?: string | null;
  readonly status?: StoredMasterStatus;
}

export function parseProcessDefinePayload(input: unknown): ProcessDefinePayload {
  const record = requireRecord(input, 'process.define 载荷');
  const payload: {
    code: string;
    name: string;
    category?: string | null;
    description?: string | null;
    status?: StoredMasterStatus;
  } = { code: requireMasterCode(record['code'], '工序 code'), name: requireName(record['name']) };
  const category = optionalText(record['category'], 'category', 64);
  if (category !== undefined) payload.category = category;
  const description = optionalText(record['description'], 'description', 512);
  if (description !== undefined) payload.description = description;
  const status = parseStoredStatus(record['status']);
  if (record['status'] !== undefined) payload.status = status;
  return payload;
}

export interface ProcessRevisePayload {
  readonly code: string;
  readonly name?: string;
  readonly category?: string | null;
  readonly description?: string | null;
  readonly status?: StoredMasterStatus;
}

/** 修订载荷：字段级期望态（未提供的键沿用当前版；code 不可变、必传作定位）。 */
export function parseProcessRevisePayload(input: unknown): ProcessRevisePayload {
  const record = requireRecord(input, 'process.revise 载荷');
  const payload: {
    code: string;
    name?: string;
    category?: string | null;
    description?: string | null;
    status?: StoredMasterStatus;
  } = { code: requireMasterCode(record['code'], '工序 code') };
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const category = optionalText(record['category'], 'category', 64);
  if (category !== undefined) payload.category = category;
  const description = optionalText(record['description'], 'description', 512);
  if (description !== undefined) payload.description = description;
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface EquipmentRegisterPayload {
  readonly code: string;
  readonly name: string;
  readonly type?: string | null;
  readonly location?: string | null;
  readonly status?: StoredMasterStatus;
}

export function parseEquipmentRegisterPayload(input: unknown): EquipmentRegisterPayload {
  const record = requireRecord(input, 'equipment.register 载荷');
  const payload: {
    code: string;
    name: string;
    type?: string | null;
    location?: string | null;
    status?: StoredMasterStatus;
  } = { code: requireMasterCode(record['code'], '设备 code'), name: requireName(record['name']) };
  const type = optionalText(record['type'], 'type', 128);
  if (type !== undefined) payload.type = type;
  const location = optionalText(record['location'], 'location', 128);
  if (location !== undefined) payload.location = location;
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface EquipmentRevisePayload {
  readonly code: string;
  readonly name?: string;
  readonly type?: string | null;
  readonly location?: string | null;
  readonly status?: StoredMasterStatus;
}

export function parseEquipmentRevisePayload(input: unknown): EquipmentRevisePayload {
  const record = requireRecord(input, 'equipment.revise 载荷');
  const payload: {
    code: string;
    name?: string;
    type?: string | null;
    location?: string | null;
    status?: StoredMasterStatus;
  } = { code: requireMasterCode(record['code'], '设备 code') };
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const type = optionalText(record['type'], 'type', 128);
  if (type !== undefined) payload.type = type;
  const location = optionalText(record['location'], 'location', 128);
  if (location !== undefined) payload.location = location;
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface OutsourcingRuleSetPayload {
  readonly code: string;
  readonly processCode: string;
  readonly name?: string | null;
  /** 工序单价（十进制串，'12.50'——解析为分）。 */
  readonly unitPrice: string;
  /** 利润率（万分比整数，1500=15%）。 */
  readonly marginPermyriad: number;
  readonly status?: StoredMasterStatus;
}

export function parseOutsourcingRuleSetPayload(input: unknown): OutsourcingRuleSetPayload {
  const record = requireRecord(input, 'outsourcing.rule.set 载荷');
  const unitPriceRaw = record['unitPrice'];
  if (typeof unitPriceRaw !== 'string') {
    throw new BaselineInputError(`unitPrice ${JSON.stringify(unitPriceRaw)} 非法：须为十进制金额串（如 '12.50'）`);
  }
  decimalToMinor(unitPriceRaw, 'unitPrice'); // 取值域预检（落库换算由服务层做，此处只挡非法）
  const payload: {
    code: string;
    processCode: string;
    name?: string | null;
    unitPrice: string;
    marginPermyriad: number;
    status?: StoredMasterStatus;
  } = {
    code: requireMasterCode(record['code'], '计价规则 code'),
    processCode: requireMasterCode(record['processCode'], '工序 code'),
    unitPrice: unitPriceRaw,
    marginPermyriad: parseMarginPermyriad(record['marginPermyriad'], 'marginPermyriad'),
  };
  const name = optionalText(record['name'], 'name', 128);
  if (name !== undefined) payload.name = name;
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface OutsourcingRuleRevisePayload {
  readonly code: string;
  readonly processCode?: string;
  readonly name?: string | null;
  readonly unitPrice?: string;
  readonly marginPermyriad?: number;
  readonly status?: StoredMasterStatus;
}

export function parseOutsourcingRuleRevisePayload(input: unknown): OutsourcingRuleRevisePayload {
  const record = requireRecord(input, 'outsourcing.rule.revise 载荷');
  const payload: {
    code: string;
    processCode?: string;
    name?: string | null;
    unitPrice?: string;
    marginPermyriad?: number;
    status?: StoredMasterStatus;
  } = { code: requireMasterCode(record['code'], '计价规则 code') };
  if (record['processCode'] !== undefined) payload.processCode = requireMasterCode(record['processCode'], '工序 code');
  const name = optionalText(record['name'], 'name', 128);
  if (name !== undefined) payload.name = name;
  if (record['unitPrice'] !== undefined) {
    if (typeof record['unitPrice'] !== 'string') {
      throw new BaselineInputError(`unitPrice ${JSON.stringify(record['unitPrice'])} 非法：须为十进制金额串`);
    }
    decimalToMinor(record['unitPrice'], 'unitPrice');
    payload.unitPrice = record['unitPrice'];
  }
  if (record['marginPermyriad'] !== undefined) {
    payload.marginPermyriad = parseMarginPermyriad(record['marginPermyriad'], 'marginPermyriad');
  }
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface MaterialValidatePayload {
  readonly lines: readonly MaterialValidationLine[];
}

const MAX_VALIDATION_LINES = 200;

export function parseMaterialValidatePayload(input: unknown): MaterialValidatePayload {
  const record = requireRecord(input, 'material.validate 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_VALIDATION_LINES) {
    throw new BaselineInputError(`lines 非法：须为 1~${MAX_VALIDATION_LINES} 行的数组`);
  }
  const lines: MaterialValidationLine[] = [];
  for (const [index, raw] of rawLines.entries()) {
    const line = requireRecord(raw, `lines[${index}]`);
    const code = optionalText(line['code'], `lines[${index}].code`, 64);
    const name = optionalText(line['name'], `lines[${index}].name`, 128);
    const spec = optionalText(line['spec'], `lines[${index}].spec`, 256);
    if ((code ?? null) === null && (name ?? null) === null && (spec ?? null) === null) {
      throw new BaselineInputError(`lines[${index}] 非法：code/name/spec 至少一项非空`);
    }
    lines.push({ code: code ?? null, name: name ?? null, spec: spec ?? null });
  }
  return { lines };
}

// ---- P2/P3 件载荷（工艺路线 / 额定工时 / 故障上报，M2-W7） ----

/** 工序步载荷（数组位置即工序顺序；seq 由服务层按位置回填 1 起单调）。 */
export interface RoutingStepInput {
  readonly processCode: string;
  readonly remark?: string | null;
}

const MAX_ROUTING_STEPS = 50;

function parseRoutingSteps(value: unknown): RoutingStepInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROUTING_STEPS) {
    throw new BaselineInputError(`steps 非法：须为 1~${MAX_ROUTING_STEPS} 步的数组`);
  }
  const steps: RoutingStepInput[] = [];
  for (const [index, raw] of value.entries()) {
    const step = requireRecord(raw, `steps[${index}]`);
    const payload: { processCode: string; remark?: string | null } = {
      processCode: requireMasterCode(step['processCode'], `steps[${index}].processCode`),
    };
    const remark = optionalText(step['remark'], `steps[${index}].remark`, 128);
    if (remark !== undefined) payload.remark = remark;
    steps.push(payload);
  }
  return steps;
}

export interface RoutingDefinePayload {
  /** 图号（= 工艺路线业务键：租户内一图一链）。 */
  readonly drawingNo: string;
  readonly name?: string | null;
  readonly steps: readonly RoutingStepInput[];
  readonly status?: StoredMasterStatus;
}

export function parseRoutingDefinePayload(input: unknown): RoutingDefinePayload {
  const record = requireRecord(input, 'routing.define 载荷');
  const payload: {
    drawingNo: string;
    name?: string | null;
    steps: readonly RoutingStepInput[];
    status?: StoredMasterStatus;
  } = {
    drawingNo: requireMasterCode(record['drawingNo'], '图号 drawingNo'),
    steps: parseRoutingSteps(record['steps']),
  };
  const name = optionalText(record['name'], 'name', 128);
  if (name !== undefined) payload.name = name;
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface RoutingRevisePayload {
  readonly drawingNo: string;
  readonly name?: string | null;
  /** 未提供 = 沿用当前版工序序列。 */
  readonly steps?: readonly RoutingStepInput[];
  readonly status?: StoredMasterStatus;
}

export function parseRoutingRevisePayload(input: unknown): RoutingRevisePayload {
  const record = requireRecord(input, 'routing.revise 载荷');
  const payload: {
    drawingNo: string;
    name?: string | null;
    steps?: readonly RoutingStepInput[];
    status?: StoredMasterStatus;
  } = { drawingNo: requireMasterCode(record['drawingNo'], '图号 drawingNo') };
  const name = optionalText(record['name'], 'name', 128);
  if (name !== undefined) payload.name = name;
  if (record['steps'] !== undefined) payload.steps = parseRoutingSteps(record['steps']);
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

/** 额定工时量纲上界（秒）：1000 小时/件与/批，覆盖机加工域并留量级余量。 */
export const MAX_STANDARD_SECONDS = 3_600_000;

function parseSeconds(value: unknown, field: string, minimum: 0 | 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > MAX_STANDARD_SECONDS) {
    throw new BaselineInputError(
      `${field} ${JSON.stringify(value)} 非法：须为 ${minimum}~${MAX_STANDARD_SECONDS} 的整数（秒，150=2.5 分钟）`,
    );
  }
  return value;
}

export interface StandardTimeDefinePayload {
  readonly code: string;
  /** 对标维度：process=按工序 / product=按产品（图号）。 */
  readonly scope: 'process' | 'product';
  /** 对标目标业务码（工序码或产品图号）。 */
  readonly targetCode: string;
  /** 每件标准工时（秒，正整数）。 */
  readonly standardSeconds: number;
  /** 每批/每任务预备工时额度（秒，非负整数，缺省 0）。 */
  readonly preparationSeconds?: number;
  readonly status?: StoredMasterStatus;
}

export function parseStandardTimeDefinePayload(input: unknown): StandardTimeDefinePayload {
  const record = requireRecord(input, 'standardtime.define 载荷');
  const scope = record['scope'];
  if (scope !== 'process' && scope !== 'product') {
    throw new BaselineInputError(`scope ${JSON.stringify(scope)} 非法：须为 'process' 或 'product'`);
  }
  const payload: {
    code: string;
    scope: 'process' | 'product';
    targetCode: string;
    standardSeconds: number;
    preparationSeconds?: number;
    status?: StoredMasterStatus;
  } = {
    code: requireMasterCode(record['code'], '额定工时 code'),
    scope,
    targetCode: requireMasterCode(record['targetCode'], '对标目标 targetCode'),
    standardSeconds: parseSeconds(record['standardSeconds'], 'standardSeconds', 1),
  };
  if (record['preparationSeconds'] !== undefined) {
    payload.preparationSeconds = parseSeconds(record['preparationSeconds'], 'preparationSeconds', 0);
  }
  if (record['status'] !== undefined) payload.status = parseStoredStatus(record['status']);
  return payload;
}

export interface FaultReportPayload {
  /** 故障设备业务码（设备台账挂接，业务码引用不落外键）。 */
  readonly equipmentCode: string;
  /** 故障描述（上报留痕）。 */
  readonly description: string;
  /** 维修人员（上报即派修：assigned 进入即发 IM 推送 + 待办）。 */
  readonly assignee: string;
}

export function parseFaultReportPayload(input: unknown): FaultReportPayload {
  const record = requireRecord(input, 'fault.report 载荷');
  const assignee = record['assignee'];
  if (typeof assignee !== 'string' || assignee.trim().length === 0 || assignee.length > 128) {
    throw new BaselineInputError(`assignee ${JSON.stringify(assignee)} 非法：须为 1~128 字符的用户 id`);
  }
  const descriptionRaw = record['description'];
  if (typeof descriptionRaw !== 'string') {
    throw new BaselineInputError(`故障描述 description 必须是字符串：${JSON.stringify(descriptionRaw)}`);
  }
  const description = descriptionRaw.trim();
  if (description.length === 0 || description.length > 2000) {
    throw new BaselineInputError(`故障描述须为 1~2000 个非空白字符：${JSON.stringify(descriptionRaw)}`);
  }
  return {
    equipmentCode: requireMasterCode(record['equipmentCode'], '设备 code'),
    description,
    assignee: assignee.trim(),
  };
}

export interface FaultResolvePayload {
  readonly remark?: string | null;
}

export function parseFaultResolvePayload(input: unknown): FaultResolvePayload {
  const record = requireRecord(input, 'fault.resolve 载荷');
  const payload: { remark?: string | null } = {};
  const remark = optionalText(record['remark'], 'remark', 2000);
  if (remark !== undefined) payload.remark = remark;
  return payload;
}
