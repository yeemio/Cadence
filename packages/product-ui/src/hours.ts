/**
 * 工时视图模型（M5 首波：移动端"我的工时"页 137 项）。与 workbench.ts 同一
 * 取舍：纯函数视图模型（测试钉死），fetch 与 URL 在 apps/web 装配层。
 *
 * 后端合同（packages/application/src/hours/，M2-W6）：
 * GET /hours/my?month=YYYY-MM → { my: MyHoursView }——本人已审核净额按日
 * （数据权限"本人"口径：workerId 只取调用方身份，响应 workerId 仅为回显）。
 * month 可省（省略 = 全部月份）；days 按 workDate 升序。
 *
 * 权限码 hours:read 与后端端点一一对应（ADR-0010 通用词：hours）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 工时读取权限码（与 apps/server GET /hours/my 端点同码）。 */
export const HOURS_READ: PermissionCode = permissionCode('hours:read');

/** 我的工时按日行（服务端按 workDate 聚合后的净额）。 */
export interface MyHoursDayView {
  readonly workDate: string;
  readonly totalHours: number;
}

/** 我的工时视图（本人已审核净额；totalHours = days 净额合计——服务端口径）。 */
export interface MyHoursView {
  readonly workerId: string;
  /** 查询月（'YYYY-MM'）；null = 未按月过滤（全量）。 */
  readonly month: string | null;
  readonly days: readonly MyHoursDayView[];
  readonly totalHours: number;
}

export class HoursViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoursViewError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HoursViewError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HoursViewError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalMonth(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new HoursViewError(`字段 '${field}' 须为 'YYYY-MM' 字符串或 null`);
  }
  return value;
}

function requireFiniteHours(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HoursViewError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

/** 解析 GET /hours/my 响应 { my: {...} }。 */
export function parseMyHoursResponse(input: unknown): MyHoursView {
  const envelope = requireObject(input, '我的工时响应');
  const record = requireObject(envelope['my'], '我的工时对象');
  const days = record['days'];
  if (!Array.isArray(days)) {
    throw new HoursViewError("我的工时对象缺 'days' 数组");
  }
  return {
    workerId: requireString(record['workerId'], 'workerId'),
    month: optionalMonth(record['month'], 'month'),
    days: days.map((row) => {
      const item = requireObject(row, 'days 行');
      return {
        workDate: requireString(item['workDate'], 'workDate'),
        totalHours: requireFiniteHours(item['totalHours'], 'totalHours'),
      };
    }),
    totalHours: requireFiniteHours(record['totalHours'], 'totalHours'),
  };
}
