/**
 * 模块页面占位：不做业务内容（非目标），Card 化视觉重排。
 * 唯一活逻辑是路由级权限守卫——hideInMenu 的"只留路由"项就是靠这里按 permission 码拦。
 */
import { usePermissions } from '@refinedev/core';
import { sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import type { MenuRoute } from '@smes/product-ui';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function CodeChip({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]">
      {children}
    </code>
  );
}

export function ModulePagePlaceholder({ route }: { route: MenuRoute }) {
  const { data: permissionData } = usePermissions({});
  const permissions = toPermissionCodes(permissionData);

  const allowed =
    route.permission === undefined || sessionHasPermission(permissions, route.permission);

  if (!allowed) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>无访问权限</CardTitle>
          <CardDescription>
            模块 <CodeChip>{route.code}</CodeChip> 需要权限码{' '}
            <CodeChip>{route.permission}</CodeChip>。
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>{route.code} · 模块占位页</CardTitle>
        <CardDescription>业务页面内容为后续增量（M2 九循环环节模块落地）。</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          路由 <CodeChip>{route.routePath}</CodeChip>
          {route.permission !== undefined && (
            <>，权限码 <CodeChip>{route.permission}</CodeChip></>
          )}
          。
        </p>
      </CardContent>
    </Card>
  );
}
