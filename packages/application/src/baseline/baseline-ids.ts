/**
 * baseline 品牌化 ID（M2-W2 P1 + M2-W7 P2/P3 件；合同 01-baseline.md §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本模块内增补（ids.ts 头注："M1/M2 各领域
 * 按需用 defineId 增补——增补不改机制"）；不回改 business-core（清洁室：本模块
 * 写入面不含 business-core）。
 *
 * P1 落地三个：ProcessId / EquipmentId / OutsourcingPriceRuleId。
 * P2/P3 件（M2-W7）补齐三个：RoutingId / StandardTimeId / FaultReportId。
 */
import { defineId } from '@smes/business-core';

/** 工序（ProcessDef）行 id——机加工序库条目的版本行主键。 */
export const ProcessId = defineId('ProcessId');
export type ProcessId = ReturnType<typeof ProcessId.create>;

/** 设备台账（EquipmentRecord）行 id。 */
export const EquipmentId = defineId('EquipmentId');
export type EquipmentId = ReturnType<typeof EquipmentId.create>;

/** 外协计价规则（OutsourcingPriceRule）行 id。 */
export const OutsourcingPriceRuleId = defineId('OutsourcingPriceRuleId');
export type OutsourcingPriceRuleId = ReturnType<typeof OutsourcingPriceRuleId.create>;

/** 工艺路线（Routing）版本行 id（业务键 = 图号，见 baseline-stores.ts）。 */
export const RoutingId = defineId('RoutingId');
export type RoutingId = ReturnType<typeof RoutingId.create>;

/** 额定工时（StandardTime）版本行 id。 */
export const StandardTimeId = defineId('StandardTimeId');
export type StandardTimeId = ReturnType<typeof StandardTimeId.create>;

/** 故障单（FaultReport）投影行 id（fr-<uuidv7> 前缀，见 service 侧生成器）。 */
export const FaultReportId = defineId('FaultReportId');
export type FaultReportId = ReturnType<typeof FaultReportId.create>;

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 inspection-ids 同款取舍——复制小工具而非
 * 跨模块 import（模块间只经端口互调，通用合同纪律 6）。同毫秒不保证严格单调
 * （毫秒级时间序已满足本模块排序口径）。
 */
export function baselineUuidv7(): string {
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

/** 故障单 id：fr-<uuidv7>。 */
export function newFaultReportId(): string {
  return `fr-${baselineUuidv7()}`;
}
