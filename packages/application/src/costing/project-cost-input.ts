/**
 * U7 项目成本输入解析（体例同 costing-input：违规抛 CostingInputError，组合根映射
 * 400，绝不静默丢弃）。命令两个（独立命令面，不改既有 COSTING_COMMAND_KINDS 冻结面）：
 *  - costing.project.rebuild.v1：工作令×口径 六块重算（命令化跑批——文档 xxl-job
 *    每日 03:00 的 Cadence 重述：调度归部署期，本波只落命令面，U2 波先例）；
 *  - costing.price.entry.v1：录入价格（文档 §2.1.5 两 Tab 的合一命令面）。
 * 信封体形状同既有：{ operationId, expectedRevision, command: { kind, payload } }。
 */
import { OperationId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import { CostingInputError } from './costing-errors.js';
import { parseWorkOrderSelectorPayload } from './costing-input.js';

// ---- 命令动词 ----

export const PROJECT_COST_COMMAND_KINDS = ['costing.project.rebuild.v1', 'costing.price.entry.v1'] as const;

export type ProjectCostCommandKind = (typeof PROJECT_COST_COMMAND_KINDS)[number];

export interface ProjectCostCommand {
  readonly kind: ProjectCostCommandKind;
  readonly payload: unknown;
}

export type ProjectCostCommandEnvelope = CommandEnvelope<ProjectCostCommand>;

export interface ProjectCostEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: ProjectCostCommand;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CostingInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new CostingInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new CostingInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requireBoundedString(value, what, min, max);
}

function optionalNonNegativeIntMinor(value: unknown, what: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new CostingInputError(`${what}须为 [0, 1e12] 内的整数（分，禁止负数）：${JSON.stringify(value)}`);
  }
  return value;
}

/** 解析 U7 命令信封体。 */
export function parseProjectCommandEnvelopeBody(input: unknown): ProjectCostEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new CostingInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(PROJECT_COST_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new CostingInputError(
      `command.kind 非法：须为 ${PROJECT_COST_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new CostingInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as ProjectCostCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseProjectCommandBodyForKind(input: unknown, expected: ProjectCostCommandKind): ProjectCostEnvelopeBody {
  const parsed = parseProjectCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new CostingInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- costing.project.rebuild.v1 载荷（工作令选择器，同 costing.rebuild 形） ----

export interface ProjectRebuildPayload {
  readonly workOrderId: string;
  readonly modelCode?: string;
  readonly modelVersion?: number;
}

export function parseProjectRebuildPayload(input: unknown): ProjectRebuildPayload {
  return parseWorkOrderSelectorPayload(input, 'costing.project.rebuild 载荷');
}

// ---- costing.price.entry.v1 载荷（录入价格） ----

/** 单行录入（发料明细行锚 + 单价/总金额；undefined = 字段未提交，null = 显式清价/清额）。 */
export interface PriceEntryRowInput {
  readonly recordId: string;
  readonly taskLineId: string;
  readonly costUnitPriceMinor: number | null | undefined;
  readonly totalMinor: number | null | undefined;
  /** true = 仅手改总金额（不改单价、不触发同零件联动）。 */
  readonly amountManual: boolean;
}

export interface PriceEntryPayload {
  readonly workOrderId: string;
  readonly rows: readonly PriceEntryRowInput[];
}

const PRICE_ENTRY_MAX_ROWS = 500;

export function parsePriceEntryPayload(input: unknown): PriceEntryPayload {
  const record = requireObject(input, 'costing.price.entry 载荷');
  const rowsRaw = record['rows'];
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    throw new CostingInputError('rows 必须为非空数组（录入价格至少一行）');
  }
  if (rowsRaw.length > PRICE_ENTRY_MAX_ROWS) {
    throw new CostingInputError(`rows 至多 ${PRICE_ENTRY_MAX_ROWS} 行（单批录入上界）`);
  }
  const seen = new Set<string>();
  const rows: PriceEntryRowInput[] = rowsRaw.map((rowRaw, index) => {
    const row = requireObject(rowRaw, `rows[${index}]`);
    const recordId = requireBoundedString(row['recordId'], `rows[${index}].recordId`, 1, 128);
    const taskLineId = requireBoundedString(row['taskLineId'], `rows[${index}].taskLineId`, 1, 128);
    const key = `${recordId}|${taskLineId}`;
    if (seen.has(key)) {
      throw new CostingInputError(`rows 内行锚重复：${key}（同发料明细行只允许一行）`);
    }
    seen.add(key);
    const costUnitPriceMinor = optionalNonNegativeIntMinor(row['costUnitPriceMinor'], `rows[${index}].costUnitPriceMinor`);
    const totalMinor = optionalNonNegativeIntMinor(row['totalMinor'], `rows[${index}].totalMinor`);
    const amountManualRaw = row['amountManual'];
    if (amountManualRaw !== undefined && amountManualRaw !== null && typeof amountManualRaw !== 'boolean') {
      throw new CostingInputError(`rows[${index}].amountManual 须为布尔：${JSON.stringify(amountManualRaw)}`);
    }
    return {
      recordId,
      taskLineId,
      costUnitPriceMinor,
      totalMinor,
      amountManual: amountManualRaw === true,
    };
  });
  return {
    workOrderId: requireBoundedString(record['workOrderId'], 'workOrderId', 1, 128),
    rows,
  };
}
