/**
 * 用户目录轻查询（UX-PLAN-R2-04）：工作令项目经理/销售候选与配件审批人等
 * 技术用户 id 处的 displayName 解析。数据缺（无 user:read 等）时静默回退——
 * 候选池空 = 纯手填（W9 派工页 datalist 同口径，不阻断业务）；displayName
 * 解析不到 = 原样回退 id，不虚构人名。queryKey 与派工页共享（同缓存面）。
 */
import { useQuery } from '@tanstack/react-query';
import { listOrgUsers } from '../../data/orgApi';

/** 用户 id → 展示名（displayName 空回落 username）只读映射。 */
export function useUserDirectory(): ReadonlyMap<string, string> {
  const usersQuery = useQuery({
    queryKey: ['org', 'users', 'options'],
    queryFn: () => listOrgUsers().catch(() => []),
    staleTime: 60_000,
  });
  return new Map(
    (usersQuery.data ?? []).map((user) => [user.id, user.displayName || user.username]),
  );
}

/** id → 展示名（目录未命中回退原 id；空值统一「—」，同详情缺省口径）。 */
export function displayUserName(directory: ReadonlyMap<string, string>, id: unknown): string {
  if (id === null || id === undefined || id === '') return '—';
  const key = String(id);
  return directory.get(key) ?? key;
}
