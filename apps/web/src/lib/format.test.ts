/**
 * 共享展示格式化工具单测（P2 横切批）：钉 formatLocalDateTime 的时区/缺省/
 * 纯日期守卫口径与 shortId 的截断阈值/头尾保留口径——多页面共用的形状出口。
 */
import { describe, expect, it } from 'vitest';
import { formatCell, formatLocalDateTime, shortId } from './format';

const RAW_ISO = '2026-10-27T02:42:01.759Z';

/** 期望值按 getTimezoneOffset 独立算术构造（体例同 costing/timeFormat.test，任意机器时区确定性成立）。 */
function expectedLocalStamp(iso: string): string {
  const epoch = Date.parse(iso);
  const local = new Date(epoch - new Date(epoch).getTimezoneOffset() * 60_000);
  const p2 = (value: number) => String(value).padStart(2, '0');
  return `${local.getUTCFullYear()}-${p2(local.getUTCMonth() + 1)}-${p2(local.getUTCDate())} ${p2(local.getUTCHours())}:${p2(local.getUTCMinutes())}`;
}

describe('formatLocalDateTime', () => {
  it('UTC ISO 串转本地时区分钟级（getTimezoneOffset 独立算术对照，机器时区无关）', () => {
    expect(formatLocalDateTime(RAW_ISO)).toBe(expectedLocalStamp(RAW_ISO));
    expect(formatLocalDateTime(RAW_ISO)).not.toContain('T');
    expect(formatLocalDateTime(RAW_ISO)).not.toContain('Z');
  });

  it('null/undefined/空串 → —（同表格缺省口径）', () => {
    expect(formatLocalDateTime(null)).toBe('—');
    expect(formatLocalDateTime(undefined)).toBe('—');
    expect(formatLocalDateTime('')).toBe('—');
  });

  it('纯日期串不做时区转换（避免 UTC 午夜平移出新时刻）', () => {
    expect(formatLocalDateTime('2026-12-01')).toBe('2026-12-01');
  });

  it('无法解析的串原样返回（表格原文语义不变）', () => {
    expect(formatLocalDateTime('2026-12-01（补录）')).toBe('2026-12-01（补录）');
  });
});

describe('shortId', () => {
  it('超长复合 id 取头 8 + 尾 4（ULID 头段同批相同，尾 4 保行间可分辨）', () => {
    expect(shortId('wo-014a7b3c-739a-7e55-b3d8-9bc01a251420b')).toBe('wo-014a7…420b');
  });

  it('≤20 字符的业务短码/用户 id 原样返回', () => {
    expect(shortId('item-rp42388')).toBe('item-rp42388');
    expect(shortId('user-seed-admin-a')).toBe('user-seed-admin-a');
  });

  it('null/undefined → —；数字等非串值转字符串', () => {
    expect(shortId(null)).toBe('—');
    expect(shortId(undefined)).toBe('—');
    expect(shortId(42)).toBe('42');
  });
});

describe('formatCell', () => {
  it('按列格式分发（datetime/shortId）', () => {
    expect(formatCell(RAW_ISO, 'datetime')).toBe(expectedLocalStamp(RAW_ISO));
    expect(formatCell('wo-014a7b3c-739a-7e55-b3d8-9bc01a251420b', 'shortId')).toBe('wo-014a7…420b');
  });
});
