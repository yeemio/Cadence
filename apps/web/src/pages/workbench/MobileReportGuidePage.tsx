/**
 * 移动报工桌面引导页（UX-PRD-01，e1a8bd）：移动报工页（/m/report）挂在移动
 * 导航面（MobileLayout 底部标签，见 mobile.ts / main.tsx 路由分流），桌面
 * 注册表不能复制同路径——mobile.test 钉死「桌面与移动注册表路径不重叠」，
 * 且 main.tsx 桌面分支先于移动分支装配，同名路径会被桌面壳劫持（移动端
 * 直开 /m/report 回归）。故桌面入口 = 本引导页：说明移动报工的打开方式并
 * 提供直达链接（SPA 内跳转 /m/report 渲染移动导航面，桌面浏览器同样可用）。
 *
 * 纯入口接线：不承载报工业务（提交通道仍在移动页与 reporting API）。
 */
import { usePermissions } from '@refinedev/core';
import { Link } from 'react-router';
import { Smartphone } from 'lucide-react';
import { sessionHasPermission, toPermissionCodes, permissionCode } from '@smes/product-ui';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** 与 mobile.ts m.report 同码（report:submit）——本页是它的桌面引导面。 */
const REPORT_SUBMIT = permissionCode('report:submit');

export function MobileReportGuidePage() {
  const { data: permissionData } = usePermissions({});
  const allowed = sessionHasPermission(toPermissionCodes(permissionData), REPORT_SUBMIT);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-5" />
          移动报工
        </CardTitle>
        <CardDescription>
          报工在车间用手机或平板完成：打开浏览器访问 /m/report，或从移动工作台底部「报工」标签进入。扫码、提交产出都在移动页操作。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {allowed && (
          <Button asChild className="w-fit">
            <Link to="/m/report">打开移动报工</Link>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          在这台电脑上打开会进入移动版页面（无侧栏）；报工单与核查仍在桌面「报工单」「报工核查」页查看。
        </p>
      </CardContent>
    </Card>
  );
}
