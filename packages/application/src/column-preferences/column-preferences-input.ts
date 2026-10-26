/**
 * 列显隐输入解析与归一（fix-wave-6 6b-3，A14 / RREQ-INT-032）。
 *
 * 纯函数零框架（service 同体例）。归一规则沿源文档 §1.4：键去首尾空格、
 * 最长 128；hiddenProps 去空、去重、保序后落库（null 当空数组——"提交了但
 * 没勾任何列"与"显式全显示"同义）。列 prop 是否真实存在不校验（前端约定）。
 */
import { ColumnPreferenceInputError } from './column-preferences-errors.js';

/** page/table 键上限（源文档 §1.3 varchar(128)）。 */
export const MAX_KEY_LENGTH = 128;

function parseKey(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new ColumnPreferenceInputError(`${what} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ColumnPreferenceInputError(`${what} 不能为空`);
  }
  if (trimmed.length > MAX_KEY_LENGTH) {
    throw new ColumnPreferenceInputError(`${what} 超长（≤${MAX_KEY_LENGTH}）`);
  }
  return trimmed;
}

/** hiddenProps 归一：非字符串数组拒绝；null/缺省 = 空数组；去空/去重/保序。 */
export function normalizeHiddenProps(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ColumnPreferenceInputError('hiddenProps 必须是字符串数组');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ColumnPreferenceInputError('hiddenProps 必须是字符串数组');
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH || seen.has(trimmed)) {
      continue; // 去空/超长/重复静默丢弃（保序语义，同源文档"去空、去重、保序"）
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/** GET ?page= 查询参数解析。 */
export function parsePageQuery(searchParams: URLSearchParams): string {
  return parseKey(searchParams.get('page'), 'page 查询参数');
}

/** PUT body 解析：{ page, table, hiddenProps }（userId 一律忽略——会话身份）。 */
export interface SaveColumnPreferencePayload {
  readonly pageKey: string;
  readonly tableKey: string;
  readonly hiddenProps: readonly string[];
}

export function parseSavePayload(input: unknown): SaveColumnPreferencePayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ColumnPreferenceInputError('请求体必须是对象');
  }
  const record = input as Record<string, unknown>;
  return {
    pageKey: parseKey(record['page'] ?? record['pageKey'], 'page'),
    tableKey: parseKey(record['table'] ?? record['tableKey'], 'table'),
    hiddenProps: normalizeHiddenProps(record['hiddenProps'] ?? record['hidden']),
  };
}
