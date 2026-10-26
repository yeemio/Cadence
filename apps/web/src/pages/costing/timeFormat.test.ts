/**
 * D-13 回归（fix-wave-2）：costing 页时刻列（口径版本链"发布时刻"/快照"生成
 * 时刻"/口径事件"时刻"）不得直出 UTC ISO 串，应为本地时区 YYYY-MM-DD
 * HH:mm:ss。时区敏感断言用 getTimezoneOffset 独立算术构造期望值，任意机器
 * 时区下确定性成立（体例同 tests/ 纯逻辑 node 测试，无 DOM 渲染）。
 */
import { describe, expect, it } from 'vitest';
import { formatLocalStamp, formatStampColumn } from './timeFormat';

const RAW_ISO = '2026-10-26T03:49:26.749Z';

describe('D-13 costing 时刻本地格式化', () => {
  it('发布时刻渲染值不再等于原始 UTC ISO 串，且为 YYYY-MM-DD HH:mm:ss 形态', () => {
    const rendered = formatLocalStamp(RAW_ISO);
    expect(rendered).not.toBe(RAW_ISO);
    expect(rendered).not.toContain('T');
    expect(rendered).not.toContain('Z');
    expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('值为本地时区换算结果（getTimezoneOffset 独立算术对照，机器时区无关）', () => {
    const epoch = Date.parse(RAW_ISO);
    const local = new Date(epoch - new Date(epoch).getTimezoneOffset() * 60_000);
    const p2 = (value: number) => String(value).padStart(2, '0');
    const expected = `${local.getUTCFullYear()}-${p2(local.getUTCMonth() + 1)}-${p2(local.getUTCDate())} ${p2(local.getUTCHours())}:${p2(local.getUTCMinutes())}:${p2(local.getUTCSeconds())}`;
    expect(formatLocalStamp(RAW_ISO)).toBe(expected);
  });

  it('表格行喂入前替换 createdAt 为格式化值，其余字段与非字符串值原样保留', () => {
    const rows = formatStampColumn([
      { id: 'e1', kind: 'published', createdAt: RAW_ISO },
      { id: 'e2', kind: 'rebuilt', createdAt: null },
      { id: 'e3', kind: 'exported' },
    ]);
    const first = rows[0];
    expect(first?.createdAt).not.toBe(RAW_ISO);
    expect(first?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(first).toMatchObject({ id: 'e1', kind: 'published' });
    expect(rows[1]?.createdAt).toBeNull();
    expect(rows[2]).not.toHaveProperty('createdAt');
    expect(formatStampColumn(undefined)).toEqual([]);
  });

  it('无法解析的字符串原样返回（表格原文语义不变）', () => {
    expect(formatLocalStamp('not-a-date')).toBe('not-a-date');
  });
});
