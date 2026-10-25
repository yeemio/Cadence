/**
 * 身份绑定（Done-when #2）：IM 用户 ↔ 系统 UserId / TenantId（品牌化 ID 复用 business-core）。
 *
 * 目录是端口（ImIdentityDirectory）；InMemory 实现供单测与开发期装配，
 * 生产持久化由宿主提供实现（ADR-0003 #5 账本化绑定属后续）。
 */
import { TenantId, UserId } from '@smes/business-core';
import type { TenantIdType, UserIdType } from '@smes/business-core';
import { assertImPlatform } from './config.js';
import type { ImPlatform } from './config.js';
import { deepFreeze } from './internal/freeze.js';
import { requireNonEmptyString } from './internal/guards.js';

export interface ImIdentityBinding {
  readonly platform: ImPlatform;
  readonly imUserId: string;
  readonly tenantId: TenantIdType;
  readonly userId: UserIdType;
  readonly displayName: string | undefined;
}

/** tenantId/userId 以明文字符串传入，经 business-core 品牌化工厂校验后入结构。 */
export function imIdentityBinding(input: {
  platform: ImPlatform;
  imUserId: string;
  tenantId: string;
  userId: string;
  displayName?: string;
}): ImIdentityBinding {
  assertImPlatform(input.platform);
  requireNonEmptyString(input.imUserId, 'ImIdentityBinding.imUserId');
  const tenantId = TenantId.create(input.tenantId);
  const userId = UserId.create(input.userId);
  if (input.displayName !== undefined) {
    requireNonEmptyString(input.displayName, 'ImIdentityBinding.displayName');
  }
  return deepFreeze({
    platform: input.platform,
    imUserId: input.imUserId,
    tenantId,
    userId,
    displayName: input.displayName,
  });
}

export interface ImIdentityDirectory {
  /** 同键（platform|tenantId|imUserId）再绑 = 换绑，覆盖旧记录。 */
  bind(binding: ImIdentityBinding): void;
  resolve(platform: ImPlatform, tenantId: TenantIdType, imUserId: string): ImIdentityBinding | undefined;
  list(): readonly ImIdentityBinding[];
}

export function createInMemoryImIdentityDirectory(): ImIdentityDirectory {
  const byKey = new Map<string, ImIdentityBinding>();
  const key = (platform: ImPlatform, tenantId: string, imUserId: string): string =>
    `${platform}|${tenantId}|${imUserId}`;
  return {
    bind(binding) {
      byKey.set(key(binding.platform, binding.tenantId, binding.imUserId), binding);
    },
    resolve(platform, tenantId, imUserId) {
      return byKey.get(key(platform, tenantId, imUserId));
    },
    list() {
      return Object.freeze([...byKey.values()]);
    },
  };
}
