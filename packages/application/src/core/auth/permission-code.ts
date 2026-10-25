/**
 * 权限码（ADR-0010 通用词汇纪律的机器形态）。
 *
 * 形状 = `<环节>:<动作>`：两个小写段（字母开头，后接小写字母/数字/连字符），
 * 不含行业词、不支持通配。模型匹配层（authorization-model.ts）同样零通配，
 * "精确权限码匹配不放宽"由类型入口与 matcher 两端共同保证。
 */
import type { Brand } from '@smes/business-core';

/** 权限码品牌类型：普通 string 不能直接进 authorize 判定入口。 */
export type PermissionCode = Brand<string, 'PermissionCode'>;

/** 单段词汇形状（环节名/动作名/角色名共用）：小写字母开头 + 小写字母/数字/连字符。 */
export const PERMISSION_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export class PermissionCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionCodeError';
  }
}

export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CODE_PATTERN.test(value);
}

/** 构造并校验权限码；形状不符即抛错（装饰器处在类定义期触发 = 启动 fail-fast）。 */
export function permissionCode(value: string): PermissionCode {
  if (!PERMISSION_CODE_PATTERN.test(value)) {
    throw new PermissionCodeError(
      `非法权限码 '${value}'：必须是 <环节>:<动作> 两段小写形状（段内仅小写字母/数字/连字符），无行业词、无通配`,
    );
  }
  return value as PermissionCode;
}

/** 拆出 casbin 请求元组用的 (resource, action) 两段。入参已是品牌类型，不再重复校验。 */
export function splitPermissionCode(code: PermissionCode): {
  readonly resource: string;
  readonly action: string;
} {
  const separator = code.indexOf(':');
  return { resource: code.slice(0, separator), action: code.slice(separator + 1) };
}
