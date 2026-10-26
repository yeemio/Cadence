/**
 * 移动我的工时页（M5 首波，hours:read；功能拆解 137 我的工时统计(移) 的
 * 呈现面）：GET /hours/my?month=YYYY-MM 按月读回本人已审核净额（按日 +
 * 合计）。"本人"是服务端合同（workerId 只取会话身份）；月份输入用原生
 * type=month（移动浏览器自带滚轮选择器）；未选月（清空）= 全量口径。
 *
 * fix-wave-2 D-12/D-6 移动收尾：查询按 session 权限投影门禁（hours:read，
 * 与后端 GET /hours/my 同码）——无权限不发起请求，显式无权限终态。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { HOURS_READ } from '@smes/product-ui';
import { useMobileDataAccess, MobileNoAccessHint } from './pageAccess';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchMyHours } from '@/data/hoursApi';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** 当前月（本地时区 'YYYY-MM'——后端 requireMonth 同格式校验）。 */
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function MobileHoursPage() {
  const [month, setMonth] = useState<string>(currentMonth);
  // D-12：进页自动查询按 session 权限投影（hours:read，与后端 GET /hours/my 同码）。
  const accessible = useMobileDataAccess(HOURS_READ);
  const hoursQuery = useQuery({
    queryKey: ['hours', 'my', month],
    queryFn: () => fetchMyHours(month.length > 0 ? month : undefined),
    enabled: accessible,
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>我的工时</CardTitle>
          <CardDescription>本人已审核净额（按月读回；清空月份 = 全量口径）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            月份
            <input
              type="month"
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </label>

          {!accessible ? (
            <MobileNoAccessHint code={HOURS_READ} />
          ) : (
            <>
              {hoursQuery.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> 正在加载…
                </p>
              )}
              {hoursQuery.isError && <ApiErrorHint error={hoursQuery.error} />}
            </>
          )}

          {hoursQuery.data !== undefined && (
            <>
              <div className="flex items-baseline justify-between rounded-lg border bg-background px-3 py-2.5">
                <span className="text-sm text-muted-foreground">
                  {hoursQuery.data.month ?? '全部月份'} 合计
                </span>
                <span className="text-2xl font-semibold tabular-nums">
                  {hoursQuery.data.totalHours}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">小时</span>
                </span>
              </div>

              {hoursQuery.data.days.length === 0 ? (
                <p className="text-sm text-muted-foreground">该月暂无已审核工时。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {hoursQuery.data.days.map((day) => (
                    <li
                      key={day.workDate}
                      className="flex items-center justify-between rounded-lg border bg-background px-3 py-2.5 text-sm"
                    >
                      <span className="tabular-nums">{day.workDate}</span>
                      <span className="font-medium tabular-nums">{day.totalHours} 小时</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
