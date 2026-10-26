/**
 * @RequireLogin() —— 路由"仅登录"声明装饰器（fix-wave-6 6b-3，A14 先例首用）。
 *
 * 填补 AuthGuard 的中间档位：既有两档是"未声明 @RequirePermission = 公开"与
 * "声明权限码 = 登录 + 权限判定"；本装饰器声明第三档——登录即可（身份有效
 * 即放行，不做权限码判定，请求体/响应仍租户收口）。语义来源：PRD 22 册
 * RREQ-INT-032"无独立菜单、不鉴权到权限码（登录即可用）"——本人本人的
 * 偏好数据，登录即有权（裁量：与源文档"不鉴权"一致，非我方放松）。
 *
 * 与 @RequirePermission 同一体例：零逻辑，只做元数据声明；判定在 AuthGuard
 * （apps/server）——守卫读取本键后仍解析身份并写入 REQUEST_USER_KEY，401/403
 * 语义不变（缺凭据 401；本档不会因权限码 403）。
 */
import { SetMetadata } from '@nestjs/common';

/** 守卫读取"仅登录"声明的元数据键（symbol 防碰撞）。 */
export const REQUIRE_LOGIN_METADATA_KEY = Symbol('smes.requireLogin');

/** 声明路由仅需登录身份（无权限码判定）。方法级声明（与 @RequirePermission 同体例）。 */
export const RequireLogin = (): MethodDecorator =>
  SetMetadata(REQUIRE_LOGIN_METADATA_KEY, true);
