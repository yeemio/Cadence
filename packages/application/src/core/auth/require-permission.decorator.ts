/**
 * @RequirePermission(code) —— 路由权限码声明装饰器（装配元数据，M1 增量 2-B）。
 *
 * 例外纪律定位（apps/server/README.md）：与 @Get 同类——只做元数据声明，零逻辑；
 * SetMetadata 是 @nestjs/common 的装配元数据件。权限码在类定义期即校验
 * （形状错 = 启动 fail-fast，不带病运行）。判定逻辑一律在 AuthGuard
 * （apps/server）+ PermissionService（本包，零框架）。
 *
 * 用法：方法级或控制器级；未声明的路由 = 公开路由（/health、/modules 等）。
 */
import { SetMetadata } from '@nestjs/common';
import { permissionCode, type PermissionCode } from './permission-code.js';

/** 守卫读取路由所需权限码的元数据键（symbol 防碰撞）。 */
export const PERMISSION_METADATA_KEY = Symbol('smes.requiredPermission');

export const RequirePermission = (code: string): MethodDecorator => {
  const validated = permissionCode(code); // 类定义期校验：形状错即抛，启动失败
  return SetMetadata(PERMISSION_METADATA_KEY, validated satisfies PermissionCode);
};
