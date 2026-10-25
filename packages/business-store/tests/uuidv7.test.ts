import { describe, expect, it } from 'vitest';
import { isUuid, isUuidv7, uuidv7 } from '../src/index.js';

describe('uuidv7 生成', () => {
  it('生成的 id 均为合法 uuidv7（版本位 7）', () => {
    const ids = Array.from({ length: 200 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuidv7(id)).toBe(true);
      expect(isUuid(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('时间戳前缀单调不降（48bit 毫秒时间序）', () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    for (let i = 1; i < ids.length; i += 1) {
      const prevTs = ids[i - 1]!.slice(0, 12);
      const currTs = ids[i]!.slice(0, 12);
      expect(currTs >= prevTs).toBe(true);
    }
  });

  it('isUuidv7 拒绝非 uuid 与其他版本', () => {
    expect(isUuidv7('not-a-uuid')).toBe(false);
    expect(isUuidv7('')).toBe(false);
    // 版本位 4（第三组首位 4、变体位 8）的合法 uuid，但不是 v7
    expect(isUuidv7('12345678-1234-4234-8234-123456789abc')).toBe(false);
    // 版本位 7 的合法形状应被识别
    expect(isUuidv7('018f3a1b-7c2d-7e4f-9a8b-cdef01234567')).toBe(true);
  });

  it('isUuid 接受任意版本（supersedes 引用列口径）', () => {
    expect(isUuid('12345678-1234-4234-8234-123456789abc')).toBe(true);
    expect(isUuid('018f3a1b-7c2d-7e4f-9a8b-cdef01234567')).toBe(true);
    expect(isUuid('12345678123442348234123456789abc')).toBe(false);
  });
});
