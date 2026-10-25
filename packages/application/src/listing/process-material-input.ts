/**
 * listing 工序×原材料关联输入解析（U4；体例同 listing-input：违规抛
 * ListingInputError 映射 400，绝不静默丢弃）。信封体形状与 listing 命令族
 * 同构：{ operationId, expectedRevision, command: { kind, payload } }——租户
 * 与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。命令动词
 * 自持本文件（不改 LISTING_COMMAND_KINDS——新文件族零侵入 listing-input）。
 *
 * 尺寸校验口径（原文 §1.3.4 / §三、8）：
 *   - partLength（长或面积值）恒必填，>0、最多 2 位小数；
 *   - partWidth / partHeight 仅体积形式（length-width-height）可填且必填、
 *     >0、最多 2 位小数；长度/面积形式填了即拒（原文：须为 NULL）；
 *   - measureType / cutSizeUnit 不收客户端值——由 cutSizeForm 确定性派生
 *     （原文「以后端按物料主数据计算为准」的无主数据数据面化重述）。
 */
import { OperationId, type ExpectedRevision } from '@smes/business-core';
import { ListingInputError } from './listing-errors.js';
import {
  CUT_SIZE_FORMS,
  cutSizeUnitOfCutSizeForm,
  measureTypeOfCutSizeForm,
  type CutSizeForm,
} from './process-material-stores.js';

// ---- 命令动词（U4 数据面：整表替换一个写面） ----

export const PROCESS_MATERIAL_COMMAND_KINDS = ['listing.process-material.replace.v1'] as const;

export type ProcessMaterialCommandKind = (typeof PROCESS_MATERIAL_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由解析器定形）。 */
export interface ProcessMaterialCommand {
  readonly kind: ProcessMaterialCommandKind;
  readonly payload: unknown;
}

// ---- 小工具（同 listing-input 体例，本文件自持） ----

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ListingInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new ListingInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ListingInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

// ---- 信封体解析 ----

export interface ProcessMaterialEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: ProcessMaterialCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseProcessMaterialEnvelopeBody(input: unknown): ProcessMaterialEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new ListingInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(PROCESS_MATERIAL_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new ListingInputError(
      `command.kind 非法：须为 ${PROCESS_MATERIAL_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new ListingInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as ProcessMaterialCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseProcessMaterialBodyForKind(
  input: unknown,
  expected: ProcessMaterialCommandKind,
): ProcessMaterialEnvelopeBody {
  const parsed = parseProcessMaterialEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new ListingInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- listing.process-material.replace 载荷 ----

/** 单行录入值（measureType/cutSizeUnit 为派生结果，随载荷一并产出）。 */
export interface ProcessMaterialRowPayload {
  readonly rawMaterialId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly measureType: ReturnType<typeof measureTypeOfCutSizeForm>;
  readonly partLength: number;
  readonly partWidth: number | null;
  readonly partHeight: number | null;
  readonly cutSizeForm: CutSizeForm;
  readonly cutSizeUnit: ReturnType<typeof cutSizeUnitOfCutSizeForm>;
}

export interface ProcessMaterialReplacePayload {
  readonly listingLineId: string;
  readonly processId: string;
  /** 空数组 = 显式清空该工序全部关联行（「空列表不覆盖」门禁归下单编排波）。 */
  readonly materials: readonly ProcessMaterialRowPayload[];
}

const MAX_UNIT_PRICE_MINOR = 2_000_000_000; // int32 安全上界内（PG Int 列；同 listing-input 口径）
const MAX_MATERIAL_ROWS = 200; // 同 MAX_ORDER_LINES 量级上界

/** 尺寸值：>0、最多 2 位小数、有限（原文 decimal(18,2) 的输入面等价）。 */
function requireDimension(value: unknown, what: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1_000_000_000 ||
    Math.round(value * 100) !== value * 100
  ) {
    throw new ListingInputError(
      `${what}须为 (0, 1e9] 内最多 2 位小数的数：${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 可空尺寸：undefined/null → null；否则按尺寸值校验（体积形式必填路径用）。 */
function optionalDimension(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null;
  return requireDimension(value, what);
}

export function parseProcessMaterialReplacePayload(input: unknown): ProcessMaterialReplacePayload {
  const record = requireObject(input, 'listing.process-material.replace 载荷');
  const listingLineId = requireBoundedString(record['listingLineId'], '零件清单行 listingLineId', 1, 128);
  const processId = requireBoundedString(record['processId'], '工序行引用 processId', 1, 128);
  const rawMaterials = record['materials'];
  if (!Array.isArray(rawMaterials) || rawMaterials.length > MAX_MATERIAL_ROWS) {
    throw new ListingInputError(`materials 非法：须为 0~${MAX_MATERIAL_ROWS} 行的数组`);
  }
  const materials: ProcessMaterialRowPayload[] = [];
  const seenRawMaterialIds = new Set<string>();
  for (const [index, raw] of rawMaterials.entries()) {
    const row = requireObject(raw, `materials[${index}]`);
    const rawMaterialId = requireBoundedString(
      row['rawMaterialId'],
      `materials[${index}].rawMaterialId`,
      1,
      128,
    );
    if (seenRawMaterialIds.has(rawMaterialId)) {
      throw new ListingInputError(`同一工序的原材料不可重复选择：materials[${index}].rawMaterialId '${rawMaterialId}' 重复`);
    }
    seenRawMaterialIds.add(rawMaterialId);
    const quantityRaw = row['quantity'];
    if (
      typeof quantityRaw !== 'number' ||
      !Number.isInteger(quantityRaw) ||
      quantityRaw <= 0 ||
      quantityRaw > 1_000_000_000
    ) {
      throw new ListingInputError(
        `materials[${index}].quantity 须为 (0, 1e9] 内的整数：${JSON.stringify(quantityRaw)}`,
      );
    }
    const unitPriceRaw = row['unitPriceMinor'];
    let unitPriceMinor: number | null = null;
    if (unitPriceRaw !== undefined && unitPriceRaw !== null) {
      if (
        typeof unitPriceRaw !== 'number' ||
        !Number.isInteger(unitPriceRaw) ||
        unitPriceRaw < 0 ||
        unitPriceRaw > MAX_UNIT_PRICE_MINOR
      ) {
        throw new ListingInputError(
          `materials[${index}].unitPriceMinor 须为 [0, ${MAX_UNIT_PRICE_MINOR}] 内的整数（分）：${JSON.stringify(unitPriceRaw)}`,
        );
      }
      unitPriceMinor = unitPriceRaw;
    }
    const formRaw = row['cutSizeForm'];
    if (typeof formRaw !== 'string' || !(CUT_SIZE_FORMS as readonly string[]).includes(formRaw)) {
      throw new ListingInputError(
        `materials[${index}].cutSizeForm 非法：须为 ${CUT_SIZE_FORMS.join('/')} 之一，得到 ${JSON.stringify(formRaw)}`,
      );
    }
    const cutSizeForm = formRaw as CutSizeForm;
    const partLength = requireDimension(row['partLength'], `materials[${index}].partLength`);
    let partWidth: number | null;
    let partHeight: number | null;
    if (cutSizeForm === 'length-width-height') {
      // 体积形式：宽/厚必填（原文：仅计量方式=体积时有值且须 >0）。
      partWidth = optionalDimension(row['partWidth'], `materials[${index}].partWidth`);
      partHeight = optionalDimension(row['partHeight'], `materials[${index}].partHeight`);
      if (partWidth === null || partHeight === null) {
        throw new ListingInputError(
          `materials[${index}] 下料尺寸形式为体积（length-width-height）时宽/厚必填且 >0`,
        );
      }
    } else {
      // 长度/面积形式：宽/厚须为空（原文：须为 NULL）。
      if (row['partWidth'] !== undefined && row['partWidth'] !== null) {
        throw new ListingInputError(
          `materials[${index}].partWidth 仅体积形式（length-width-height）可填，当前形式 ${cutSizeForm} 须为空`,
        );
      }
      if (row['partHeight'] !== undefined && row['partHeight'] !== null) {
        throw new ListingInputError(
          `materials[${index}].partHeight 仅体积形式（length-width-height）可填，当前形式 ${cutSizeForm} 须为空`,
        );
      }
      partWidth = null;
      partHeight = null;
    }
    materials.push({
      rawMaterialId,
      quantity: quantityRaw,
      unitPriceMinor,
      measureType: measureTypeOfCutSizeForm(cutSizeForm),
      partLength,
      partWidth,
      partHeight,
      cutSizeForm,
      cutSizeUnit: cutSizeUnitOfCutSizeForm(cutSizeForm),
    });
  }
  return { listingLineId, processId, materials };
}
