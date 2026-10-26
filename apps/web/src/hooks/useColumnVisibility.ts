/**
 * useColumnVisibility —— 列表页列显隐记忆 hook（fix-wave-6 6b-3，A14 /
 * RREQ-INT-032，我方架构重述：不搬源文档 avue mixin 形态）。
 *
 * 语义合同：
 *  - 初始：进页一次拉取整页偏好（GET ?page=），本表 hiddenProps 恢复隐藏；
 *    从未保存（tables 缺本表键）= 全显；
 *  - 变更：本地立即生效 + 300ms 防抖幂等提交（PUT；空数组 = 显式全显示，
 *    与"从未保存"区分——服务端行缺位/空数组两态承载）；
 *  - fail-open：拉取/提交失败列全显/保留本地态（偏好面故障不阻塞业务页，
 *    同 useMenuConfig 静态树先例）；401 由 apiClient 统一清会话跳登录。
 *
 * 纯逻辑（toggleHiddenProps / visibleColumnsOf）独立导出——node 接缝测试锚定
 * （体例先例 = shell/useMenuConfig.test.ts）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchColumnPreferences, saveColumnPreferences } from '../data/columnPreferencesApi';

/** 防抖窗口（源文档 §2.1.5：勾选后 300ms 提交）。 */
export const SUBMIT_DEBOUNCE_MS = 300;

/** 勾选切换：key 已隐藏则移除（恢复显示），否则追加（保序去重）。 */
export function toggleHiddenProps(
  hidden: readonly string[],
  key: string,
): readonly string[] {
  return hidden.includes(key) ? hidden.filter((prop) => prop !== key) : [...hidden, key];
}

/** 可见列过滤（hidden 中无 key 的列保留原序）。 */
export function visibleColumnsOf<T extends { readonly key: string }>(
  columns: readonly T[],
  hidden: readonly string[],
): T[] {
  return columns.filter((column) => !hidden.includes(column.key));
}

/**
 * 列显隐记忆。columns 为页面列定义（key 唯一——同 ModuleTable TableColumn）；
 * 返回可见列、当前隐藏集与切换函数（本地即时生效 + 防抖提交）。
 */
export function useColumnVisibility<T extends { readonly key: string }>(options: {
  /** 页面标识（= 路由 path，如 '/masterdata/items'）。 */
  readonly pageKey: string;
  /** 表格标识（一页多表用不同 key，如 'main'）。 */
  readonly tableKey: string;
  readonly columns: readonly T[];
}): {
  readonly visibleColumns: T[];
  readonly hidden: readonly string[];
  readonly isColumnHidden: (key: string) => boolean;
  readonly toggleColumn: (key: string) => void;
} {
  const { pageKey, tableKey, columns } = options;
  const queryClient = useQueryClient();

  // fail-open：拉取失败（retry=false）data 保持 undefined → 本地表初始空集 → 全显
  const preferencesQuery = useQuery({
    queryKey: ['column-preferences', pageKey],
    queryFn: () => fetchColumnPreferences(pageKey),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // 本地隐藏集：null = 服务端态未回（全显兜底）；回包后按本表键水合（缺键 =
  // 从未保存 = 空集）。render 期条件 setState 是 React 官方 derived-state 模式
  //（仅 null→值单向一次，无循环；比 useEffect 水合少一帧全显闪烁）。
  const [hidden, setHidden] = useState<readonly string[] | null>(null);
  const serverHidden = preferencesQuery.data?.[tableKey];
  if (hidden === null && serverHidden !== undefined) {
    setHidden(serverHidden);
  }

  // 防抖提交：同一 table 只保留最后一个待提交态（覆盖式，勾选连点合并）
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const timer = timerRef.current;
    return () => {
      if (timer !== null) clearTimeout(timer);
      // 卸载时未落账的待提交态 fire-and-forget 落库（fetch 不 await——浏览器
      // 会完成已在途请求；丢这一发则下次进页回退到旧态，属可接受边界）
      const pending = pendingRef.current;
      if (pending !== null) {
        void saveColumnPreferences({ page: pageKey, table: tableKey, hiddenProps: pending });
      }
    };
  }, [pageKey, tableKey]);

  const toggleColumn = useCallback(
    (key: string) => {
      // 基线：本地已水合用本地态，否则从空集起（从未保存 = 全显）
      const base = hidden ?? [];
      const next = toggleHiddenProps(base, key);
      setHidden(next);
      pendingRef.current = next;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending === null) return;
        // 失败静默（fail-open）：保留本地态，不重试轰炸；下次进页读回服务端态
        void saveColumnPreferences({ page: pageKey, table: tableKey, hiddenProps: pending })
          .then(() => queryClient.invalidateQueries({ queryKey: ['column-preferences', pageKey] }))
          .catch(() => undefined);
      }, SUBMIT_DEBOUNCE_MS);
    },
    [hidden, pageKey, tableKey, queryClient],
  );

  const effectiveHidden = hidden ?? [];
  const visibleColumns = useMemo(
    () => visibleColumnsOf(columns, effectiveHidden),
    [columns, effectiveHidden],
  );

  const hiddenSet = useMemo(() => new Set(effectiveHidden), [effectiveHidden]);
  const isColumnHidden = useCallback((key: string) => hiddenSet.has(key), [hiddenSet]);

  return { visibleColumns, hidden: effectiveHidden, isColumnHidden, toggleColumn };
}
