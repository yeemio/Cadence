/**
 * 工时视图模型测试（M5 首波）：GET /hours/my 响应解析、权限码常量。
 * 响应形状镜像 packages/application hours.service MyHoursView（本人已审核
 * 净额按日——M2-W6 合同）。
 */
import { describe, expect, it } from 'vitest';
import {
  HOURS_READ,
  HoursViewError,
  parseMyHoursResponse,
} from '../src/index.js';

const myHoursBody = {
  workerId: 'user-demo-operator',
  month: '2026-10',
  days: [
    { workDate: '2026-10-21', totalHours: 7.5 },
    { workDate: '2026-10-22', totalHours: 8 },
  ],
  totalHours: 15.5,
};

describe('我的工时响应解析', () => {
  it('合法响应：信封 my 解包、days 行与合计保留', () => {
    const view = parseMyHoursResponse({ my: myHoursBody });
    expect(view.workerId).toBe('user-demo-operator');
    expect(view.month).toBe('2026-10');
    expect(view.days).toEqual([
      { workDate: '2026-10-21', totalHours: 7.5 },
      { workDate: '2026-10-22', totalHours: 8 },
    ]);
    expect(view.totalHours).toBe(15.5);
  });

  it('month null（未按月过滤的全量口径）合法', () => {
    const view = parseMyHoursResponse({ my: { ...myHoursBody, month: null } });
    expect(view.month).toBeNull();
  });

  it('非法形状拒绝：缺 my / 缺 days / 坏行 / 非数值工时', () => {
    expect(() => parseMyHoursResponse({})).toThrow(HoursViewError);
    expect(() => parseMyHoursResponse({ my: { workerId: 'u', month: null } })).toThrow(HoursViewError);
    expect(() =>
      parseMyHoursResponse({ my: { ...myHoursBody, days: [{ workDate: 'x' }] } }),
    ).toThrow(HoursViewError);
    expect(() =>
      parseMyHoursResponse({
        my: { ...myHoursBody, days: [{ workDate: '2026-10-21', totalHours: '7.5' }] },
      }),
    ).toThrow(HoursViewError);
    expect(() => parseMyHoursResponse(null)).toThrow(HoursViewError);
  });
});

describe('工时权限码常量（与后端端点一一对应）', () => {
  it('hours:read', () => {
    expect(HOURS_READ).toBe('hours:read');
  });
});
