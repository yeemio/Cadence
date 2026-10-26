/**
 * 移动库存查询页（M5 首波，stock:read；功能拆解 128~133 移动仓储的查询
 * 呈现面）：扫码/输码 → GET /inventory/stock?itemId= 实时库存可用量读回
 * （availableQty = qtyOnHand − qtyReserved，服务端机器计算口径）。移动端
 * 与桌面逻辑面同径（后端不设镜像端点，呈现归 M5 PWA——控制器注释口径）。
 *
 * 查询语义：进页加载全量（itemId 过滤缺省 = 全部物料行）；扫码自动填入
 * itemId 并即时按码过滤（车间查料主路径）；"查全部"一键清过滤。
 *
 * fix-wave-2 D-12/D-6 移动收尾：查询按 session 权限投影门禁（stock:read，
 * 与后端 GET /inventory/stock 同码）——无权限不发起请求，显式无权限终态。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, ScanLine, SearchX } from 'lucide-react';
import { STOCK_READ } from '@smes/product-ui';
import { useMobileDataAccess, MobileNoAccessHint } from './pageAccess';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchStockLevels } from '@/data/inventoryApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { SCAN_TIER_LABELS, SCAN_VIDEO_ELEMENT_ID, useScanSession } from '@/pages/scan/useScanSession';

export function MobileStockPage() {
  const { model, session, wedgeHint } = useScanSession();

  /** 输入框值（扫码自动填入）；查询项（null = 全量）在按钮/扫码时提交。 */
  const [itemIdInput, setItemIdInput] = useState('');
  const [queryItemId, setQueryItemId] = useState<string | null>(null);

  // D-12：进页自动查询按 session 权限投影（stock:read，与后端 GET /inventory/stock 同码）。
  const accessible = useMobileDataAccess(STOCK_READ);
  const stockQuery = useQuery({
    queryKey: ['inventory', 'stock', queryItemId],
    queryFn: () => fetchStockLevels(queryItemId ?? undefined),
    enabled: accessible,
  });

  // 最新扫码结果自动填入并按码查询（车间查料主路径：扫完即出数）
  const lastScanRef = useRef<string | null>(null);
  const recentResults = session?.recentResults ?? [];
  useEffect(() => {
    const latest = recentResults[recentResults.length - 1];
    if (latest !== undefined && latest.code !== lastScanRef.current) {
      lastScanRef.current = latest.code;
      setItemIdInput(latest.code);
      setQueryItemId(latest.code);
    }
  }, [recentResults]);

  const active = session?.status === 'active';
  const currentTier = session?.currentTier ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>库存查询</CardTitle>
          <CardDescription>扫物料条码或手填物料 id，读回各仓库实时可用量。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
              value={itemIdInput}
              placeholder="物料 id（扫码或手填）"
              inputMode="text"
              onChange={(event) => setItemIdInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setQueryItemId(itemIdInput);
              }}
            />
            <Button className="h-11 shrink-0" onClick={() => setQueryItemId(itemIdInput)}>
              查询
            </Button>
          </div>
          {queryItemId !== null && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                当前过滤：<span className="font-mono">{queryItemId}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => {
                  setQueryItemId(null);
                  setItemIdInput('');
                }}
              >
                查全部
              </Button>
            </div>
          )}

          {model !== null && session !== null && (
            <div className="flex flex-col gap-3 border-t pt-3">
              <div className="flex flex-wrap items-center gap-3">
                {active ? (
                  <Button variant="outline" size="sm" onClick={() => model.stop()}>
                    停止扫码
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => model.start()}>
                    {session.status === 'exhausted' ? '重新开始' : '开始扫码'}
                  </Button>
                )}
                {active && currentTier !== null && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ScanLine className="size-3.5" />
                    正在使用「{SCAN_TIER_LABELS[currentTier]}」…
                  </span>
                )}
              </div>

              {currentTier === 'tier1-camera' && (
                <div className="relative overflow-hidden rounded-lg border bg-muted/60" style={{ aspectRatio: '4 / 3' }}>
                  <div id={SCAN_VIDEO_ELEMENT_ID} className="h-full w-full [&>video]:h-full [&>video]:w-full [&>video]:object-cover" />
                  {!active && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                      摄像头未启动
                    </div>
                  )}
                </div>
              )}
              {currentTier === 'tier3-device-wedge' && (
                <div
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground',
                    active ? 'border-primary/50 bg-primary/5 text-primary' : 'bg-muted/60',
                  )}
                >
                  {active ? '扫码枪就绪：保持本页面焦点，扫描后自动查询' : '扫码枪模式未启动'}
                </div>
              )}
              {wedgeHint !== null && <p className="text-xs text-muted-foreground">{wedgeHint}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>实时库存</CardTitle>
          <CardDescription>可用量 = 总量 − 预占（服务端机器计算，实时口径）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!accessible ? (
            <MobileNoAccessHint code={STOCK_READ} />
          ) : (
            <>
              {stockQuery.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> 正在加载…
                </p>
              )}
              {stockQuery.isError && <ApiErrorHint error={stockQuery.error} />}
            </>
          )}
          {stockQuery.data !== undefined && stockQuery.data.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <SearchX className="size-4 shrink-0" />
              没有匹配的库存记录。
            </p>
          )}
          {stockQuery.data?.map((level) => (
            <div
              key={`${level.itemId}@${level.warehouseId}`}
              className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-mono text-xs">{level.itemId}</span>
                <span className="truncate text-xs text-muted-foreground">
                  仓库 <span className="font-mono">{level.warehouseId}</span>
                </span>
              </div>
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="text-xl font-semibold tabular-nums">{level.availableQty}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  可用 / 共 {level.qtyOnHand}
                  {level.qtyReserved > 0 ? `（预占 ${level.qtyReserved}）` : ''}
                </span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
