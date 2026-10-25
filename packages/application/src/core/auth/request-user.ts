/**
 * 请求身份传递（M1 增量 2-B）：AuthGuard（apps/server）解析出用户身份后，
 * 以固定请求属性名写入请求对象；受保护 handler 经 @Req() 读回。
 *
 * 这是"ALS 之外的最小传递机制"：TenantContext（ALS）只承载租户（ADR-0005），
 * 不为用户身份另开存储域。身份来源见 apps/server/src/auth.guard.ts
 * （Bearer 会话解析为主；SMES_DEV_AUTH=on 时 x-smes-user 为 dev/test 回落）。
 */
import type { UserId } from '@smes/business-core';

export const REQUEST_USER_KEY = 'smesUser';

/** 受保护路由 handler 侧的请求视图（@Req() 参数类型）。 */
export type AuthenticatedRequest = {
  readonly [REQUEST_USER_KEY]: UserId;
};
