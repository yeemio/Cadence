/**
 * ColumnPreferenceService —— 列显隐偏好用例（fix-wave-6 6b-3，A14 /
 * RREQ-INT-032）。零框架业务类（不 import @nestjs/*）：输入解析 + 端口委托。
 *
 * 两用例即可覆盖 PRD 面：按页读取（进页一次拉取整页全部表格配置——"一次
 * HTTP"语义我方由按页聚合端点承载，替代源文档 detailByPage 的 Redis Hash
 * 回填形态）与保存（防抖后的幂等 upsert）。userId 由 controller 传入（会话
 * 身份），本层不接触请求体 userId——忽略语义在控制器收口。
 */
import type { TenantId, UserId } from '@smes/business-core';
import { parsePageQuery, parseSavePayload } from './column-preferences-input.js';
import type { ColumnPreferenceRecord, ColumnPreferenceStore } from './column-preferences-stores.js';

/**
 * 按页读取结果：tableKey → 隐藏列集合。已保存（含空数组 = 显式全显示）才有
 * 键；从未保存的 tableKey 缺位——两态必须可区分（跨设备同步"全显示"依赖）。
 */
export type PageColumnPreferences = Readonly<Record<string, readonly string[]>>;

export class ColumnPreferenceService {
  constructor(private readonly store: ColumnPreferenceStore) {}

  /** GET /column-preferences?page=…：当前用户本页全部表格偏好。 */
  async listForPage(
    tenant: TenantId,
    user: UserId,
    searchParams: URLSearchParams,
  ): Promise<{ tables: PageColumnPreferences }> {
    const pageKey = parsePageQuery(searchParams);
    const records = await this.store.listForPage(tenant, user, pageKey);
    const tables: Record<string, readonly string[]> = {};
    for (const record of records) {
      tables[record.tableKey] = record.hiddenProps;
    }
    return { tables };
  }

  /** PUT /column-preferences：幂等 upsert（空数组 = 显式全显示）。 */
  async save(
    tenant: TenantId,
    user: UserId,
    input: unknown,
  ): Promise<ColumnPreferenceRecord> {
    const payload = parseSavePayload(input);
    return this.store.upsert(
      tenant,
      user,
      payload.pageKey,
      payload.tableKey,
      payload.hiddenProps,
    );
  }
}
