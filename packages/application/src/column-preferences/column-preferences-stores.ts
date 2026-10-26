/**
 * ColumnPreferenceStore —— 用户表格列显隐存储端口（fix-wave-6 6b-3，A14 /
 * RREQ-INT-032）。与 MenuConfigStore 同一模式：端口在本包定义，内存实现先行，
 * PG adapter 由 business-store 按 `./column-preferences` 子路径接入。
 *
 * 语义合同（PRD 22 册 RREQ-INT-032，源《用户表格列显隐配置》我方架构重述——
 * 不搬 avue mixin / Redis 页级缓存形态）：
 *  - 三元组（用户 × pageKey × tableKey）一条有效记录，只存隐藏列 prop 集合；
 *  - 空数组 = 用户显式选择全部显示（与"从未保存"必须区分——跨设备同步
 *    "全显示"依赖该区分；listForPage 不返回的 tableKey 即从未保存）；
 *  - upsert 幂等：同三元组重复提交覆盖 hiddenProps（PG 形态库级 UNIQUE +
 *    upsert；源文档"库上不建 UNIQUE、Service 先查再插/更"在并发下会双行，
 *    我方收口为库级约束——差异登记，非语义变更）；
 *  - userId 只取会话身份（controller 层收口，请求体 userId 一律忽略）；
 *  - 本期只管隐藏列，不存冻结/筛选/排序；后端不校验列 prop 是否真实存在
 *    （前端页面约定，与源文档一致）。
 *
 * 表取舍：偏好数据非业务事实——不套证据公共列、不套 append-only/supersedes
 * （同 menu_configs 体例）。无 delete：偏好只覆盖不删（清空隐藏列 = 提交空数组）。
 */
import type { TenantId, UserId } from '@smes/business-core';

/** 单条列显隐偏好（三元组 + 隐藏列集合）。updatedAt 为 ISO-8601 字符串。 */
export interface ColumnPreferenceRecord {
  readonly tenant: TenantId;
  /** 偏好归属用户（三元组第一维；读写均限本人）。 */
  readonly userId: UserId;
  /** 页面标识（一般 = 前端路由 path，去首尾空格 ≤128 字符）。 */
  readonly pageKey: string;
  /** 表格标识（一页多表用不同 key 区分，≤128 字符）。 */
  readonly tableKey: string;
  /** 隐藏列 prop 集合（去空/去重/保序；空数组 = 显式全显示）。 */
  readonly hiddenProps: readonly string[];
  readonly updatedAt: string;
}

/**
 * 列显隐偏好存储端口。实现方保证：
 *  - listForPage 只返回该用户本租户本页已保存的记录（从未保存的 tableKey
 *    不出现——"无记录"语义由缺位表达）；
 *  - upsert 幂等：同三元组覆盖 hiddenProps 并推进 updatedAt；
 *  - 租户 + 用户双键收口：跨租户/跨用户互不可见（controller 只传会话身份，
 *    store 侧仍按双键过滤——纵深防御）。
 */
export interface ColumnPreferenceStore {
  listForPage(
    tenant: TenantId,
    userId: UserId,
    pageKey: string,
  ): Promise<readonly ColumnPreferenceRecord[]>;
  upsert(
    tenant: TenantId,
    userId: UserId,
    pageKey: string,
    tableKey: string,
    hiddenProps: readonly string[],
  ): Promise<ColumnPreferenceRecord>;
}
