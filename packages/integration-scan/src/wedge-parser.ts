/**
 * 键盘串入（keyboard wedge）解析器——纯函数（M1 增量 3-F，Done-when 4）
 *
 * 行为假设（通用格式，厂商无关）：
 * - 扫码枪工作在键盘模拟模式：码值以高速按键串到达（相邻间隔默认 ≤50ms，
 *   人类打字通常达不到）；
 * - 可配前缀 / 后缀字符（扫描器侧配置，默认无）；
 * - 以终结键收尾（默认 'Enter'，可配 'Tab' 等）；
 * - 中断（相邻间隔超阈，疑似人工输入）与超时（整段超时长上限）都判坏输入，
 *   丢弃整段缓冲，后续按键重新起段；
 * - 有效码值不含控制字符、不收修饰键名，长度在 [minLength, maxLength]。
 *
 * 形状：增量 reducer（nextWedgeParserState，无副作用，时间戳由调用方注入）
 * + 批量折叠（parseWedgeSequence）。含后缀的码值本身出现后缀序列时存在
 * 固有歧义，按"剥离最后一次出现"处理，站点应避免码值与前后缀配置冲突。
 */
import { createScanCode, type ScanCode } from './scan-result.js';

export interface WedgeKeyStroke {
  /** 字符本身；终结 / 修饰键用键名（'Enter' / 'Tab'） */
  readonly key: string;
  /** 事件时间戳（ms），假定单调不减 */
  readonly atMs: number;
}

export interface WedgeParserOptions {
  /** 前缀字符（扫描器配置的起始符），默认 '' */
  readonly prefix?: string;
  /** 后缀字符（终结键前的收尾符），默认 '' */
  readonly suffix?: string;
  /** 终结键名，默认 'Enter' */
  readonly terminator?: string;
  /** 相邻按键最大间隔（ms），超过判中断，默认 50 */
  readonly interKeyGapMs?: number;
  /** 单段串入总时长上限（ms），超过判超时，默认 2_000 */
  readonly maxBurstMs?: number;
  /** 码值最小长度（剥离前缀/后缀后），默认 4（单字符"扫描"不成立，可按站点放宽） */
  readonly minLength?: number;
  /** 码值最大长度，默认 2048（对齐 ScanCode 上限） */
  readonly maxLength?: number;
}

export const DEFAULT_WEDGE_PARSER_OPTIONS: Readonly<Required<WedgeParserOptions>> = Object.freeze({
  prefix: '',
  suffix: '',
  terminator: 'Enter',
  interKeyGapMs: 50,
  maxBurstMs: 2_000,
  minLength: 4,
  maxLength: 2048,
});

export type WedgeRejectReason =
  /** 相邻间隔超阈（疑似人工打字 / 中断） */
  | 'gap-timeout'
  /** 整段超时长上限 */
  | 'burst-timeout'
  | 'prefix-mismatch'
  | 'suffix-mismatch'
  | 'too-short'
  | 'too-long'
  /** 控制字符 / 非数据键（修饰键名等） */
  | 'invalid-character';

export type WedgeParseEvent =
  | { readonly type: 'accepted'; readonly code: ScanCode }
  | { readonly type: 'rejected'; readonly reason: WedgeRejectReason }
  | { readonly type: 'pending' };

export interface WedgeParserState {
  readonly burstStartMs: number;
  readonly lastAtMs: number;
  /** 已收字符（含前缀；不含终结键） */
  readonly buffer: readonly string[];
}

export function resolveWedgeParserOptions(options?: WedgeParserOptions): Required<WedgeParserOptions> {
  if (options === undefined) return { ...DEFAULT_WEDGE_PARSER_OPTIONS };
  const resolved: Required<WedgeParserOptions> = {
    prefix: options.prefix ?? DEFAULT_WEDGE_PARSER_OPTIONS.prefix,
    suffix: options.suffix ?? DEFAULT_WEDGE_PARSER_OPTIONS.suffix,
    terminator: options.terminator ?? DEFAULT_WEDGE_PARSER_OPTIONS.terminator,
    interKeyGapMs: options.interKeyGapMs ?? DEFAULT_WEDGE_PARSER_OPTIONS.interKeyGapMs,
    maxBurstMs: options.maxBurstMs ?? DEFAULT_WEDGE_PARSER_OPTIONS.maxBurstMs,
    minLength: options.minLength ?? DEFAULT_WEDGE_PARSER_OPTIONS.minLength,
    maxLength: options.maxLength ?? DEFAULT_WEDGE_PARSER_OPTIONS.maxLength,
  };
  if (resolved.terminator.length === 0) {
    throw new Error('invalid wedge parser options: terminator must be a non-empty key name');
  }
  if (
    !Number.isFinite(resolved.interKeyGapMs) ||
    resolved.interKeyGapMs < 0 ||
    !Number.isFinite(resolved.maxBurstMs) ||
    resolved.maxBurstMs < 0
  ) {
    throw new Error('invalid wedge parser options: interKeyGapMs / maxBurstMs must be >= 0');
  }
  if (!Number.isInteger(resolved.minLength) || resolved.minLength < 1) {
    throw new Error('invalid wedge parser options: minLength must be an integer >= 1');
  }
  if (!Number.isInteger(resolved.maxLength) || resolved.maxLength < resolved.minLength) {
    throw new Error('invalid wedge parser options: maxLength must be an integer >= minLength');
  }
  return resolved;
}

const WEDGE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isDataKey(key: string): boolean {
  return key.length === 1 && !WEDGE_CONTROL_CHARACTERS.test(key);
}

function rejected(reason: WedgeRejectReason): WedgeParseEvent {
  return Object.freeze({ type: 'rejected', reason });
}

/**
 * 增量推进一步按键。返回新状态（null = 丢弃整段、回到空闲）与本次事件：
 * accepted / rejected 为终态事件，pending 表示继续缓冲。
 */
export function nextWedgeParserState(
  state: WedgeParserState | null,
  stroke: WedgeKeyStroke,
  options?: WedgeParserOptions,
): { readonly state: WedgeParserState | null; readonly event: WedgeParseEvent } {
  const opts = resolveWedgeParserOptions(options);
  const { key, atMs } = stroke;

  if (typeof key !== 'string' || key.length === 0 || typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    return { state, event: rejected('invalid-character') };
  }

  if (state !== null) {
    if (atMs - state.lastAtMs > opts.interKeyGapMs) {
      return { state: null, event: rejected('gap-timeout') };
    }
    if (atMs - state.burstStartMs > opts.maxBurstMs) {
      return { state: null, event: rejected('burst-timeout') };
    }
  }

  if (key === opts.terminator) {
    return finalizeBurst(state, opts);
  }
  if (!isDataKey(key)) {
    return { state: null, event: rejected('invalid-character') };
  }

  const buffer = state === null ? [key] : [...state.buffer, key];
  const text = buffer.join('');

  // 仍处前缀区但已偏离 → 立即拒绝（不必等到终结键）
  if (text.length <= opts.prefix.length && !opts.prefix.startsWith(text)) {
    return { state: null, event: rejected('prefix-mismatch') };
  }
  // 总长闸：前缀 + 码值 + 后缀
  if (text.length > opts.prefix.length + opts.maxLength + opts.suffix.length) {
    return { state: null, event: rejected('too-long') };
  }

  return {
    state: Object.freeze({
      burstStartMs: state === null ? atMs : state.burstStartMs,
      lastAtMs: atMs,
      buffer: Object.freeze(buffer),
    }),
    event: Object.freeze({ type: 'pending' }),
  };
}

function finalizeBurst(
  state: WedgeParserState | null,
  opts: Required<WedgeParserOptions>,
): { readonly state: WedgeParserState | null; readonly event: WedgeParseEvent } {
  if (state === null) {
    // 光有终结键：空段
    return { state: null, event: rejected('too-short') };
  }
  const raw = state.buffer.join('');
  if (opts.prefix !== '' && !raw.startsWith(opts.prefix)) {
    return { state: null, event: rejected('prefix-mismatch') };
  }
  let body = raw.slice(opts.prefix.length);
  if (opts.suffix !== '') {
    if (!body.endsWith(opts.suffix)) {
      return { state: null, event: rejected('suffix-mismatch') };
    }
    body = body.slice(0, -opts.suffix.length);
  }
  if (body.length < opts.minLength) {
    return { state: null, event: rejected('too-short') };
  }
  if (body.length > opts.maxLength) {
    return { state: null, event: rejected('too-long') };
  }
  return { state: null, event: Object.freeze({ type: 'accepted', code: createScanCode(body) }) };
}

/**
 * 批量折叠整段按键序列：序列中任一 burst 被接受 → 返回首个 accepted
 * （有码可采）；否则返回首个 rejected（第一处坏输入，其后尾随噪声不再
 * 覆盖）；全程无终态事件则 pending。时间戳全部由调用方提供，函数本身
 * 无 IO、无时钟。
 */
export function parseWedgeSequence(
  strokes: readonly WedgeKeyStroke[],
  options?: WedgeParserOptions,
): WedgeParseEvent {
  let state: WedgeParserState | null = null;
  let firstRejected: WedgeParseEvent | undefined;
  for (const stroke of strokes) {
    const step = nextWedgeParserState(state, stroke, options);
    state = step.state;
    if (step.event.type === 'accepted') return step.event;
    if (step.event.type === 'rejected' && firstRejected === undefined) firstRejected = step.event;
  }
  return firstRejected ?? Object.freeze({ type: 'pending' });
}
