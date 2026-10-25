/**
 * 数据源端口（MetricSource）：报表数据读取的注入接缝——形状对齐事件/事实行
 * （EvidenceColumns 三时间列 + occurredAt + 领域字段），不实现任何具体存储。
 *
 * 与 engine-flow 存储端口同一取舍：方法为异步（Promise）——PG/事件表实现天然异步，
 * 端口按异步定形才能让 business-store 落地时不改调用方。本文件另附确定性内存实现
 * （测试 / 单进程演示用，即时 resolve，无真实 IO）。
 *
 * 下推语义：read 可按请求（时间窗 + 过滤）下推筛选；求值正确性由引擎
 * （evaluate.ts）兜底——引擎对取回行**重复施加同一谓词**，下推只是优化，
 * 不改变结果（重复过滤幂等，见 tests/evaluate.test.ts 全流程用例）。
 */
import type { EvidenceColumns } from '@smes/business-core';
import { deepFreeze } from './internal/freeze.js';
import { isPlainObject } from './internal/checks.js';
import { evaluateMetricFilter, validateMetricFilter, type MetricFilter } from './filter.js';
import { TIME_BASES, type TimeBasis } from './definition.js';

/**
 * 数据行：证据三时间列（对齐 business-core EvidenceColumns / contracts/evidence-columns.v1.md）
 * + occurredAt + 任意领域字段（如 dispatchId / quantity / hours）。
 * occurredAt 必有；businessTime / availableTime 可空（口径回落语义见 definition.ts）。
 */
export interface MetricSourceRow extends Pick<EvidenceColumns, 'businessTime' | 'availableTime'> {
  readonly occurredAt: string;
  readonly [field: string]: unknown;
}

/** 读行请求：按源种类 + 时间口径列 + 时间窗（含端点）+ 过滤取行。 */
export interface MetricSourceRequest {
  readonly sourceKind: string;
  readonly timeBasis: TimeBasis;
  /** ISO 8601；含下界 */
  readonly from?: string;
  /** ISO 8601；含上界 */
  readonly to?: string;
  readonly filter?: MetricFilter;
}

/** 数据源端口：由 business-store（事实表/事件表读取）实现、组合根接线。 */
export interface MetricSource {
  read(request: MetricSourceRequest): Promise<readonly MetricSourceRow[]>;
}

const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 解析 ISO 8601 时刻为毫秒；非法即抛（fail-fast，错误信息含出处）。 */
export function parseIsoTime(value: string, what: string): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${what}: expected an ISO 8601 date-time string, got "${String(value)}"`);
  }
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`invalid ${what}: expected an ISO 8601 date-time string, got "${value}"`);
  }
  return ms;
}

/**
 * 解析行的口径时间列（三态 + 回落）：
 * business → businessTime ?? occurredAt；available → availableTime ?? occurredAt；occurred → occurredAt。
 */
export function rowTimeIso(row: Readonly<Record<string, unknown>>, basis: TimeBasis): string {
  const iso =
    basis === 'business'
      ? row.businessTime ?? row.occurredAt
      : basis === 'available'
        ? row.availableTime ?? row.occurredAt
        : row.occurredAt;
  if (typeof iso !== 'string' || iso.length === 0) {
    throw new Error(`invalid source row: missing ${basis}-basis time column (occurredAt is required)`);
  }
  return iso;
}

/**
 * 单源内存实现：绑定一种 sourceKind（镜像真实适配器绑一张表）；
 * 创建即冻结全部行（防御性拷贝），read 语义与引擎同一套纯函数。
 */
export function createInMemoryMetricSource(sourceKind: string, rows: readonly MetricSourceRow[]): MetricSource {
  if (typeof sourceKind !== 'string' || !KEBAB_PATTERN.test(sourceKind) || sourceKind.length > 64) {
    throw new Error(`invalid sourceKind: expected kebab-case (max 64 chars), got "${String(sourceKind)}"`);
  }
  if (!Array.isArray(rows)) {
    throw new Error('invalid rows: expected an array of source rows');
  }
  const stored: readonly MetricSourceRow[] = Object.freeze(
    rows.map((row): MetricSourceRow => {
      if (!isPlainObject(row)) {
        throw new Error('invalid source row: expected a plain object');
      }
      // 展开含索引签名的接口会吞掉命名属性的类型，收窄回行形状
      return deepFreeze({ ...row } as MetricSourceRow);
    }),
  );

  return {
    read: async (request) => {
      if (!isPlainObject(request)) {
        throw new Error('invalid metric source request: expected a plain object');
      }
      if (request.sourceKind !== sourceKind) {
        throw new Error(`unknown sourceKind "${String(request.sourceKind)}": this source serves "${sourceKind}"`);
      }
      if (typeof request.timeBasis !== 'string' || !TIME_BASES.includes(request.timeBasis as TimeBasis)) {
        throw new Error(`invalid timeBasis: expected one of ${TIME_BASES.join('/')}, got "${String(request.timeBasis)}"`);
      }
      const fromMs = request.from === undefined ? undefined : parseIsoTime(request.from, 'request from');
      const toMs = request.to === undefined ? undefined : parseIsoTime(request.to, 'request to');
      const filter = request.filter === undefined ? undefined : validateMetricFilter(request.filter);
      const basis = request.timeBasis as TimeBasis;

      return Object.freeze(
        stored.filter((row) => {
          if (fromMs !== undefined || toMs !== undefined) {
            const ms = parseIsoTime(rowTimeIso(row, basis), `source row ${basis} time`);
            if (fromMs !== undefined && ms < fromMs) return false;
            if (toMs !== undefined && ms > toMs) return false;
          }
          return filter === undefined || evaluateMetricFilter(filter, row);
        }),
      );
    },
  };
}
