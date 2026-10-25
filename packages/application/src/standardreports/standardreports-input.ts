/**
 * 标准报表查询入参解析（S1 backfill：0920 #89/#91/#92/#96）。
 *
 * POST /standard-reports/query 请求体形状：
 *   { metricId: string, version?: number, from?: ISO, to?: ISO,
 *     timeBasis?: 'business'|'available'|'occurred', dimensionSlice?: {...} }
 * 违规抛 StandardReportsInputError（组合根映射 400）。
 */
import type { MetricQuery, TimeBasis } from '@smes/engine-reporting';
import { StandardReportsInputError } from './standardreports-errors.js';

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new StandardReportsInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new StandardReportsInputError(`字段 '${field}' 须为 ISO 8601 时刻：${JSON.stringify(value)}`);
  }
  return value;
}

function optionalTimeBasis(value: unknown): TimeBasis | undefined {
  if (value === undefined) return undefined;
  if (value !== 'business' && value !== 'available' && value !== 'occurred') {
    throw new StandardReportsInputError(
      `字段 'timeBasis' 须为 business/available/occurred：${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 解析查询体（metricId 必填；version 缺省 = 包内该口径当前版本——由服务层解析）。 */
export function parseReportQueryInput(input: unknown): Omit<MetricQuery, 'version'> {
  const record = requireObject(input, '标准报表查询请求体');
  if (typeof record['metricId'] !== 'string' || record['metricId'].trim().length === 0) {
    throw new StandardReportsInputError(
      `字段 'metricId' 须为非空字符串：${JSON.stringify(record['metricId'])}`,
    );
  }
  const metricId = record['metricId'].trim();
  if (record['version'] !== undefined && !Number.isSafeInteger(record['version'])) {
    throw new StandardReportsInputError(`字段 'version' 须为整数：${JSON.stringify(record['version'])}`);
  }
  const from = optionalIso(record['from'], 'from');
  const to = optionalIso(record['to'], 'to');
  if (from !== undefined && to !== undefined && new Date(from).getTime() > new Date(to).getTime()) {
    throw new StandardReportsInputError(`时间窗颠倒：from '${from}' 晚于 to '${to}'`);
  }

  let dimensionSlice: MetricQuery['dimensionSlice'];
  if (record['dimensionSlice'] !== undefined) {
    const raw = record['dimensionSlice'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new StandardReportsInputError(
        `字段 'dimensionSlice' 须为对象（维度字段 → 标量值数组）：${JSON.stringify(raw)}`,
      );
    }
    for (const [field, values] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(values)) {
        throw new StandardReportsInputError(`dimensionSlice['${field}'] 须为数组：${JSON.stringify(values)}`);
      }
      for (const value of values) {
        if (
          !(value === null || typeof value === 'string' || typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)))
        ) {
          throw new StandardReportsInputError(
            `dimensionSlice['${field}'] 值须为标量：${JSON.stringify(value)}`,
          );
        }
      }
    }
    dimensionSlice = raw as MetricQuery['dimensionSlice'];
  }

  const timeBasis = optionalTimeBasis(record['timeBasis']);
  return {
    metricId,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(timeBasis !== undefined ? { timeBasis } : {}),
    ...(dimensionSlice !== undefined ? { dimensionSlice } : {}),
  };
}
