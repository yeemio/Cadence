/**
 * maintenance 模块品牌化 ID（M3，m3-drafts/02-maintenance.md v1.0 §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本包内增补（与 payroll/hours/costing 同一
 * 机制，business-core 零污染）。差异表 #3：草案的 kebab/uuid 裸字符串升级为品牌化
 * MaintenancePlanId / MaintenanceTaskId / CheckpointRecordId / UpkeepRecordId /
 * RepairRecordId（Brand<T,Name>，m2 通用纪律 5）。
 *
 * 语义分工（对齐 payroll 版本化主数据体例）：
 *  - MaintenancePlanId = 维保计划的**业务身份**（跨版本稳定，人读 kebab 码，
 *    如 'lathe-daily-check'）；每个版本是一行（行 id 为 mpl-<uuidv7>），
 *    (tenant, planId, objectVersion) 唯一；
 *  - MaintenanceTaskId = 维保任务执行单行 id（mtk-<uuidv7>；状态机投影行）；
 *  - CheckpointRecordId / UpkeepRecordId / RepairRecordId = 三态记录
 *    append-only 行 id（ckr-/upr-/rpr-<uuidv7>；kind 判别三态，合同 §2）。
 */
import { defineId } from '@smes/business-core';

/** 维保计划业务身份（planId：跨版本稳定的 kebab 码；版本化主数据的 code 位）。 */
export const MaintenancePlanId = defineId('MaintenancePlanId');
export type MaintenancePlanId = ReturnType<typeof MaintenancePlanId.create>;

/** 维保任务（MaintenanceTask）执行单行 id——状态机投影行（scheduled@v1 起步）。 */
export const MaintenanceTaskId = defineId('MaintenanceTaskId');
export type MaintenanceTaskId = ReturnType<typeof MaintenanceTaskId.create>;

/** 点检记录行 id（三态记录之一：判据比对结果 pass/fail）。 */
export const CheckpointRecordId = defineId('CheckpointRecordId');
export type CheckpointRecordId = ReturnType<typeof CheckpointRecordId.create>;

/** 保养记录行 id（三态记录之一：保养动作完成留痕）。 */
export const UpkeepRecordId = defineId('UpkeepRecordId');
export type UpkeepRecordId = ReturnType<typeof UpkeepRecordId.create>;

/** 维修记录行 id（三态记录之一：faultRef 引用 + 是否恢复）。 */
export const RepairRecordId = defineId('RepairRecordId');
export type RepairRecordId = ReturnType<typeof RepairRecordId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 payroll-ids/hours-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 payroll-ids 同实现口径——business-store 的
 * uuid 工具不可用（依赖方向），事实表 id 需时间有序（evidence-columns.v1），
 * 毫秒级时间序已满足本模块排序口径。
 */
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 计划版本行 id：mpl-<uuidv7>。 */
export function newMaintenancePlanRowId(): string {
  return `mpl-${uuidv7()}`;
}

/** 维保任务行 id：mtk-<uuidv7>。 */
export function newMaintenanceTaskId(): MaintenanceTaskId {
  return MaintenanceTaskId.create(`mtk-${uuidv7()}`);
}

/** 点检记录行 id：ckr-<uuidv7>。 */
export function newCheckpointRecordId(): CheckpointRecordId {
  return CheckpointRecordId.create(`ckr-${uuidv7()}`);
}

/** 保养记录行 id：upr-<uuidv7>。 */
export function newUpkeepRecordId(): UpkeepRecordId {
  return UpkeepRecordId.create(`upr-${uuidv7()}`);
}

/** 维修记录行 id：rpr-<uuidv7>。 */
export function newRepairRecordId(): RepairRecordId {
  return RepairRecordId.create(`rpr-${uuidv7()}`);
}

/** 域事件 id：evt-<uuidv7>（与既有模块域事件同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
