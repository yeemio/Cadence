/**
 * TSPL 标签命令生成器（纯字符串，M1 增量 4-K 重点）
 *
 * TSPL/TSPL2 是热敏标签打印机的通用命令语言（TSC / HPRT 等主流厂商兼容）。
 * 本模块只构造命令文本——每条命令一行、以 CRLF 分隔的命令串；不连接打印机，
 * 传输（USB / TCP / 串口）与打印机握手属适配器接线增量。
 *
 * 文本转义语义（写明，Done-when 3）：
 * - TSPL 的字符串参数以双引号 `"` 定界，协议未定义双引号或控制字符的转义写法；
 * - 换行 / 控制字符（U+0000–U+001F、U+007F）会破坏"每命令一行"的行协议，
 *   与双引号一样在构造期直接抛错拒绝（fail-fast），不做静默转义——
 *   不存在的转义不能发明，注入即产出坏标签；
 * - 需要多行文本时按行拆成多条 TEXT 命令（调用方责任）；
 * - 反斜杠 `\` 在 TSPL 中无转义含义，按字面传递，允许出现在内容里。
 *
 * COPY 语义（写明）：`COPY n` 在已打印标签的基础上**追加**重印 n 张
 * （总计 1 + n，参照 TSPL2 手册："duplicates the previously printed label
 * n times"）。打印 N 份同一标签 = `PRINT 1` + `COPY N-1`。
 *
 * 词汇通用性（ADR-0010 三问）：label / text / barcode / qrcode / dpi 均为
 * 跨行业通用词；TSPL 为命令语言名（协议标准名，非单一厂商词），允许作为
 * 模块/导出前缀出现在边缘包（不进 business-core）。
 */

/** 打印方向：出纸方向（0 = 反向，1 = 正向） */
export type TsplDirectionValue = 0 | 1;

/** 旋转角度（度） */
export type TsplRotation = 0 | 90 | 180 | 270;

/** 二维码纠错级别 */
export type TsplEccLevel = 'L' | 'M' | 'Q' | 'H';

/** 支持的一维码码制（构造期按码制校验码值字符域） */
export type TsplBarcodeType = '128' | '39' | 'EAN13' | 'EAN8' | 'UPCA';

/** 命令行分隔符：TSPL 行协议为 CRLF */
export const TSPL_LINE_SEPARATOR = '\r\n';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const CODE39_CHARACTERS = /^[0-9A-Z \-.$/+%]+$/;
const DIGITS = /^\d+$/;
const FONT_NAME = /^[0-9A-Za-z][0-9A-Za-z _-]{0,31}$/;

const ROTATIONS: readonly TsplRotation[] = [0, 90, 180, 270];
const ECC_LEVELS: readonly TsplEccLevel[] = ['L', 'M', 'Q', 'H'];
export const TSPL_BARCODE_TYPES: readonly TsplBarcodeType[] = Object.freeze([
  '128',
  '39',
  'EAN13',
  'EAN8',
  'UPCA',
]);

function isTsplBarcodeType(value: unknown): value is TsplBarcodeType {
  return typeof value === 'string' && (TSPL_BARCODE_TYPES as readonly string[]).includes(value);
}

/** 非负整数（dots 坐标、倍率、份数等） */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${name}: expected a non-negative integer, got ${String(value)}`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid ${name}: expected a positive integer, got ${String(value)}`);
  }
}

/** 正数（mm 尺寸允许小数） */
function assertPositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid ${name}: expected a positive finite number, got ${String(value)}`);
  }
}

function assertNonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid ${name}: expected a non-negative finite number, got ${String(value)}`);
  }
}

/**
 * 可定界内容校验（转义语义入口）：非空、无控制字符、无双引号。
 * 见模块头"文本转义语义"——拒绝而非转义。
 */
function assertQuotableContent(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${name}: expected a non-empty string`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`invalid ${name}: control characters (incl. line breaks) are not allowed`);
  }
  if (value.includes('"')) {
    throw new Error(
      `invalid ${name}: double quotes are not allowed (TSPL defines no escape for them); split into multiple commands or reword`,
    );
  }
}

/** mm 数值格式化：最多两位小数、去尾零（避免 40.300000000000004 之类的浮点伪影） */
function formatMm(value: number): string {
  return String(Number(value.toFixed(2)));
}

function assertRotation(name: string, value: TsplRotation): void {
  if (!ROTATIONS.includes(value)) {
    throw new Error(`invalid ${name}: expected one of ${ROTATIONS.join(' / ')}`);
  }
}

/**
 * GTIN 校验位计算（EAN13 / EAN8 / UPCA 共用模 10 加权算法）。
 * firstWeight：EAN-13 数据位从权重 1 起；EAN-8 / UPC-A 从权重 3 起。
 */
function gtinCheckDigit(dataDigits: string, firstWeight: 1 | 3): number {
  let sum = 0;
  for (let i = 0; i < dataDigits.length; i++) {
    const digit = Number(dataDigits[i]);
    sum += digit * (i % 2 === 0 ? firstWeight : firstWeight === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** 码值字符域校验（按码制） */
function assertBarcodeContent(type: TsplBarcodeType, content: string): void {
  if (type === '128') {
    // Code 128：可打印 ASCII（含空格）；起始/终止/切换符由打印机自行编码
    if (!PRINTABLE_ASCII.test(content)) {
      throw new Error('invalid barcode content for 128: expected printable ASCII characters');
    }
    return;
  }
  if (type === '39') {
    // Code 39：大写字母 + 数字 + 空格 + - . $ / + %（起始/终止符 * 由打印机附加）
    if (!CODE39_CHARACTERS.test(content)) {
      throw new Error(
        'invalid barcode content for 39: expected 0-9 A-Z space - . $ / + % (start/stop added by printer)',
      );
    }
    return;
  }
  // 定长数字码制：允许"数据位（打印机补校验位）"或"全位（校验位须正确）"两种长度
  const spec: Record<'EAN13' | 'EAN8' | 'UPCA', { data: number; firstWeight: 1 | 3 }> = {
    EAN13: { data: 12, firstWeight: 1 },
    EAN8: { data: 7, firstWeight: 3 },
    UPCA: { data: 11, firstWeight: 3 },
  };
  const { data, firstWeight } = spec[type];
  if (!DIGITS.test(content)) {
    throw new Error(`invalid barcode content for ${type}: expected digits only`);
  }
  if (content.length === data) return; // 数据位，校验位由打印机计算
  if (content.length === data + 1) {
    const provided = Number(content[content.length - 1]);
    const expected = gtinCheckDigit(content.slice(0, data), firstWeight);
    if (provided !== expected) {
      throw new Error(
        `invalid barcode content for ${type}: check digit ${provided} does not match expected ${expected}`,
      );
    }
    return;
  }
  throw new Error(
    `invalid barcode content for ${type}: expected ${data} data digits (printer adds check digit) or ${data + 1} digits with a valid check digit, got ${content.length}`,
  );
}

/** SIZE m,n —— 标签尺寸（mm） */
export function tsplSize(widthMm: number, heightMm: number): string {
  assertPositiveNumber('label width (mm)', widthMm);
  assertPositiveNumber('label height (mm)', heightMm);
  return `SIZE ${formatMm(widthMm)} mm,${formatMm(heightMm)} mm`;
}

/** GAP m,n —— 标签间隙与偏移（mm）；连续纸（间隙 0）用 gapMm = 0 */
export function tsplGap(gapMm: number, offsetMm: number): string {
  assertNonNegativeNumber('label gap (mm)', gapMm);
  assertNonNegativeNumber('label gap offset (mm)', offsetMm);
  return `GAP ${formatMm(gapMm)} mm,${formatMm(offsetMm)} mm`;
}

/** DIRECTION n —— 打印方向 */
export function tsplDirection(direction: TsplDirectionValue): string {
  if (direction !== 0 && direction !== 1) {
    throw new Error(`invalid print direction: expected 0 or 1, got ${String(direction)}`);
  }
  return `DIRECTION ${direction}`;
}

/** CLS —— 清除影像缓冲区 */
export function tsplCls(): string {
  return 'CLS';
}

export interface TsplTextOptions {
  /** 字体：内置位图字体 id（"1"~"5"）或接线期注册的字体名；默认 "2" */
  readonly font?: string;
  readonly rotation?: TsplRotation;
  /** 水平 / 垂直放大倍数（1~10），默认 1 */
  readonly xMultiplier?: number;
  readonly yMultiplier?: number;
}

/** TEXT x,y,"font",rotation,xmul,ymul,"content" —— 文本行（一行一条命令） */
export function tsplText(
  x: number,
  y: number,
  content: string,
  options: TsplTextOptions = {},
): string {
  assertNonNegativeInteger('text x (dots)', x);
  assertNonNegativeInteger('text y (dots)', y);
  assertQuotableContent('text content', content);
  const font = options.font ?? '2';
  if (typeof font !== 'string' || !FONT_NAME.test(font)) {
    throw new Error(
      'invalid text font: expected a built-in font id or an alphanumeric font name (no quotes/commas)',
    );
  }
  const rotation = options.rotation ?? 0;
  assertRotation('text rotation', rotation);
  const xMultiplier = options.xMultiplier ?? 1;
  const yMultiplier = options.yMultiplier ?? 1;
  assertPositiveInteger('text xMultiplier', xMultiplier);
  assertPositiveInteger('text yMultiplier', yMultiplier);
  if (xMultiplier > 10 || yMultiplier > 10) {
    throw new Error('invalid text multiplier: expected 1~10');
  }
  return `TEXT ${x},${y},"${font}",${rotation},${xMultiplier},${yMultiplier},"${content}"`;
}

export interface TsplBarcodeOptions {
  /** 条码高度（dots），默认 80 */
  readonly height?: number;
  /** 人类可读字符（0/1），默认关闭 */
  readonly humanReadable?: boolean;
  readonly rotation?: TsplRotation;
  /** 窄条 / 宽条宽度（dots），默认 2 / 2 */
  readonly narrow?: number;
  readonly wide?: number;
}

/** BARCODE x,y,"type",height,readable,rotation,narrow,wide,"content" —— 一维码 */
export function tsplBarcode(
  x: number,
  y: number,
  type: TsplBarcodeType,
  content: string,
  options: TsplBarcodeOptions = {},
): string {
  assertNonNegativeInteger('barcode x (dots)', x);
  assertNonNegativeInteger('barcode y (dots)', y);
  if (!isTsplBarcodeType(type)) {
    throw new Error(`invalid barcode type: expected one of ${TSPL_BARCODE_TYPES.join(' / ')}`);
  }
  // 先过定界安全检查（非空/无控制字符/无双引号——见模块头转义语义），
  // 再按码制校验字符域；否则 128 的"可打印 ASCII"域会放行双引号、
  // 产出 `...,"A"B"` 破坏 TSPL 定界的坏命令。
  assertQuotableContent('barcode content', content);
  assertBarcodeContent(type, content);
  const height = options.height ?? 80;
  assertPositiveInteger('barcode height (dots)', height);
  const rotation = options.rotation ?? 0;
  assertRotation('barcode rotation', rotation);
  const narrow = options.narrow ?? 2;
  const wide = options.wide ?? 2;
  assertPositiveInteger('barcode narrow width', narrow);
  assertPositiveInteger('barcode wide width', wide);
  const readable = options.humanReadable === true ? 1 : 0;
  return `BARCODE ${x},${y},"${type}",${height},${readable},${rotation},${narrow},${wide},"${content}"`;
}

export interface TsplQrcodeOptions {
  /** 纠错级别，默认 M */
  readonly ecc?: TsplEccLevel;
  /** 单元格宽度（dots，1~10），默认 4 */
  readonly cellWidth?: number;
  readonly rotation?: TsplRotation;
}

/**
 * QRCODE x,y,ECC,cell,mode,rotation,"content" —— 二维码。
 * mode 固定 A（自动掩码）；manual 掩码模式（M，带 mask 参数）暂不支持，
 * 接入真机有需要再扩——避免凭记忆写出未经验证的掩码参数序。
 */
export function tsplQrcode(
  x: number,
  y: number,
  content: string,
  options: TsplQrcodeOptions = {},
): string {
  assertNonNegativeInteger('qrcode x (dots)', x);
  assertNonNegativeInteger('qrcode y (dots)', y);
  assertQuotableContent('qrcode content', content);
  const ecc = options.ecc ?? 'M';
  if (!ECC_LEVELS.includes(ecc)) {
    throw new Error(`invalid qrcode ecc: expected one of ${ECC_LEVELS.join(' / ')}`);
  }
  const cellWidth = options.cellWidth ?? 4;
  assertPositiveInteger('qrcode cellWidth', cellWidth);
  if (cellWidth > 10) {
    throw new Error('invalid qrcode cellWidth: expected 1~10');
  }
  const rotation = options.rotation ?? 0;
  assertRotation('qrcode rotation', rotation);
  return `QRCODE ${x},${y},${ecc},${cellWidth},A,${rotation},"${content}"`;
}

/** PRINT m —— 打印 m 张（m ≥ 1） */
export function tsplPrint(labelCount = 1): string {
  assertPositiveInteger('print count', labelCount);
  return `PRINT ${labelCount}`;
}

/** COPY n —— 在已打印标签基础上追加重印 n 张（总计 1 + n，见模块头语义说明） */
export function tsplCopy(count: number): string {
  assertPositiveInteger('copy count', count);
  return `COPY ${count}`;
}

/**
 * 命令拼接：每命令一行（CRLF 分隔，无尾随分隔符）。
 * 逐条校验：非空、单行、无控制字符——防止外来字符串破坏行协议。
 */
export function buildTsplProgram(
  commands: readonly string[],
  separator: string = TSPL_LINE_SEPARATOR,
): string {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('invalid tspl program: expected at least one command');
  }
  for (const command of commands) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('invalid tspl program: every command must be a non-empty string');
    }
    if (CONTROL_CHARACTERS.test(command)) {
      throw new Error('invalid tspl program: commands must be single-line strings without control characters');
    }
  }
  return commands.join(separator);
}
