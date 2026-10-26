/**
 * InMemoryColumnPreferenceStore —— 列显隐偏好端口先行实现（fix-wave-6 6b-3）。
 *
 * 重启即失；PG 实现在 business-store（`./column-preferences` 子路径）。与
 * InMemoryMenuConfigStore 同一形态：无 DATABASE_URL / 未注入存储时组合根回落
 * 到这里，保证零 DB boot 语义完整。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { ColumnPreferenceRecord, ColumnPreferenceStore } from './column-preferences-stores.js';

interface Row extends ColumnPreferenceRecord {
  // 行内可变面：upsert 覆盖 hiddenProps / updatedAt（三元组与 userId 键不可变）
  hiddenProps: readonly string[];
  updatedAt: string;
}

/** 三元组行键（租户 + 用户 + 页 + 表——同键即同一条有效记录）。 */
function rowKey(tenant: TenantId, userId: UserId, pageKey: string, tableKey: string): string {
  return `${tenant}|${userId}|${pageKey}|${tableKey}`;
}

export class InMemoryColumnPreferenceStore implements ColumnPreferenceStore {
  private readonly rows = new Map<string, Row>();

  async listForPage(
    tenant: TenantId,
    userId: UserId,
    pageKey: string,
  ): Promise<readonly ColumnPreferenceRecord[]> {
    const prefix = `${tenant}|${userId}|${pageKey}|`;
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => ({ ...row }));
  }

  async upsert(
    tenant: TenantId,
    userId: UserId,
    pageKey: string,
    tableKey: string,
    hiddenProps: readonly string[],
  ): Promise<ColumnPreferenceRecord> {
    const key = rowKey(tenant, userId, pageKey, tableKey);
    const existing = this.rows.get(key);
    const now = new Date().toISOString();
    const row: Row = {
      tenant,
      userId,
      pageKey,
      tableKey,
      hiddenProps: [...hiddenProps],
      // 首次保存 createdAt 语义并入 updatedAt（端口面只暴露 updatedAt——偏好
      // 只覆盖不删，创建时间无消费面）
      updatedAt: now,
    };
    this.rows.set(key, existing === undefined ? row : { ...existing, ...row });
    return { ...row };
  }
}
