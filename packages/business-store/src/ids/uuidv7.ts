/**
 * uuidv7 生成（PG 无内建 uuidv7——id 生成权威在应用侧，见本包 README）。
 *
 * 复用 uuid 包（MIT，许可证白名单内，ADR-0007 复用优先）：v7 = 48bit 毫秒时间戳
 * 前缀 + 随机尾，字符串字典序即时间序（证据标准：主键时间有序）。
 */
import { v7 as uuidV7, validate as uuidValidate, version as uuidVersion } from 'uuid';

/** 生成一个 uuidv7（时间有序）。 */
export function uuidv7(): string {
  return uuidV7();
}

/** 是否为合法 UUID（任意版本）。用于 supersedes 等引用列的入参校验。 */
export function isUuid(value: string): boolean {
  return uuidValidate(value);
}

/** 是否为合法 uuidv7（版本位 = 7）。 */
export function isUuidv7(value: string): boolean {
  return uuidValidate(value) && uuidVersion(value) === 7;
}
