/**
 * 版本化主数据机制（M2-W2 P1；合同 01-baseline.md §2：baseline 四对象均为
 * 版本化主数据 draft → active → superseded，新版本 supersedes 旧版，非状态机流转）。
 *
 * 机制与词汇分开（ADR-0010 条 2 的同款纪律）：
 *  - 存储 status 只落 'draft' | 'active'（写入时声明）；
 *  - 'superseded' 是**推导态**：某行被任一新行 supersedes 即视为 superseded——
 *    append-only 纪律下旧行不改行（evidence-columns.v1 #1：修正走 supersedes 链），
 *    因此读模型经 effectiveStatus 推导，不落库、不可手写。
 *
 * 链不变量（由存储实现方唯一约束背书，见 baseline-stores.ts 端口合同）：
 *  - (tenant, code, objectVersion) 唯一：同码并发插入同版本必拒其一；
 *  - (tenant, supersedes) 唯一：一行至多被取代一次——链线性、无分叉；
 *  - 当前版 = max(objectVersion)（链线性前提下两者等价）。
 */
import { TenantId } from '@smes/business-core';

/** 写入态（落库值）；'superseded' 不落库，见文件头。 */
export type StoredMasterStatus = 'draft' | 'active';

/** 读模型有效态（合同词汇：draft → active → superseded）。 */
export type EffectiveMasterStatus = StoredMasterStatus | 'superseded';

/** P1 审核状态：baseline 版本化主数据无审批环节（审批走 approval 模块另案），统一 unaudited。 */
export const BASELINE_AUDIT_STATUS_UNAUDITED = 'unaudited';

/** 版本化主数据公共字段（evidence-columns.v1 公共列 + 业务键 code）。 */
export interface VersionedMasterFields {
  /** 行 id（uuid 口径，由存储实现方生成：PG=uuidv7，内存=唯一串；创建后稳定）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 租户内唯一业务键（人读稳定码）。 */
  readonly code: string;
  /** 版本号 = 链上第 N 版（初始 1，修订 +1）；expectedRevision 乐观锁锚点。 */
  readonly objectVersion: number;
  /** 写入态（draft/active）；superseded 为推导态。 */
  readonly status: StoredMasterStatus;
  /** 审核状态（P1 恒 unaudited，合法值集由领域规格升级时定义）。 */
  readonly auditStatus: string;
  /** JSONB 溯源（operationId、命令信封摘要、操作者——由服务层写入）。 */
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** 本行取代的前任行 id（v1 为 null）。 */
  readonly supersedes: string | null;
  /** 业务时间（可补录口径，ISO 8601；缺省 = 命令签发时刻）。 */
  readonly businessTime?: string;
  readonly createdAt: string;
}

/** 版本链推导的最小形状（行子集即可参与推导）。 */
export interface VersionChainEntry {
  readonly id: string;
  readonly objectVersion: number;
  readonly supersedes: string | null;
}

/** 是否被任何行取代（推导 superseded 态的唯一依据）。 */
export function isSuperseded(entry: VersionChainEntry, chain: readonly VersionChainEntry[]): boolean {
  return chain.some((row) => row.supersedes === entry.id);
}

/** 有效态：被取代 → 'superseded'；否则取落库 status。 */
export function effectiveStatus(
  entry: VersionChainEntry & { readonly status: StoredMasterStatus },
  chain: readonly VersionChainEntry[],
): EffectiveMasterStatus {
  return isSuperseded(entry, chain) ? 'superseded' : entry.status;
}

/** 当前版 = 版本号最大者（链线性不变量下与"未被取代者"等价；空链返回 null）。 */
export function currentVersion<T extends VersionChainEntry>(chain: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of chain) {
    if (best === null || row.objectVersion > best.objectVersion) best = row;
  }
  return best;
}

/** 按版本号升序返回链副本（历史读口径）。 */
export function sortByVersion<T extends VersionChainEntry>(chain: readonly T[]): readonly T[] {
  return [...chain].sort((a, b) => a.objectVersion - b.objectVersion);
}
