/**
 * RLS 表清单（ADR-0005：M1 起全表带 tenant_id，M4 RLS 全量覆盖）。
 *
 * 取舍（写明）：显式清单而非运行时解析 schema.prisma——生成器保持纯函数，
 * 不耦合 schema 文本；清单与 schema 事实的双向一致由
 * tests/rls-conformance.test.ts 机器守恒（模式同 schema-conformance.test.ts）：
 * 新增带 tenant_id 的表而漏登本清单，测试变红；修复 = 补一行 + 重放生成器
 * 同步迁移快照。M4 正式线可把"生成 → 写迁移"做成 CI 步骤。
 */
import type { RlsTableSpec } from './generate-rls-sql.js';

function tenantTable(name: string): RlsTableSpec {
  return { name, tenantColumn: 'tenant_id' };
}

/** 全部带 tenant_id 的物理表（= schema.prisma 全部 @@map 表名，无例外）。 */
export const RLS_TABLES: readonly RlsTableSpec[] = [
  tenantTable('work_order_records'),
  tenantTable('event_records'),
  tenantTable('outbox_records'),
  tenantTable('users'),
  tenantTable('sessions'),
  tenantTable('roles'),
  tenantTable('policies'),
  tenantTable('items'),
  tenantTable('resources'),
  tenantTable('todos'),
  tenantTable('approval_cases'),
  tenantTable('approval_records'),
  tenantTable('approval_events'),
  tenantTable('process_defs'),
  tenantTable('equipment_records'),
  tenantTable('outsourcing_price_rules'),
  tenantTable('material_validation_runs'),
  tenantTable('baseline_command_operations'),
  tenantTable('work_orders'),
  tenantTable('parts_requests'),
  tenantTable('workorder_events'),
  tenantTable('work_order_attachments'),
  tenantTable('kit_checks'),
  tenantTable('workorder_operations'),
  // M2 inspection 线（2026-10-25 落库；清单守恒测试触发补登）
  tenantTable('inspections'),
  tenantTable('nonconformities'),
  tenantTable('inspection_events'),
  tenantTable('inspection_operations'),
  // M2 listing 线（2026-10-25 落库；守恒测试再次触发补登 + 全量重放迁移 20261025210000）
  tenantTable('listing_sheets'),
  tenantTable('listing_lines'),
  tenantTable('gap_checks'),
  tenantTable('purchase_requests'),
  tenantTable('purchase_orders'),
  tenantTable('purchase_returns'),
  tenantTable('listing_events'),
  tenantTable('listing_operations'),
  // M2 dispatch 线（2026-10-25 落库；守恒测试触发补登；重放收敛于 20261025230000（20010 冗余中间态已由总控删除））
  tenantTable('dispatch_orders'),
  tenantTable('outsourcing_lines'),
  tenantTable('dispatch_events'),
  tenantTable('dispatch_operations'),
  // M2 inventory 线（2026-10-25 落库；守恒测试触发补登 + 全量重放迁移 20261025230000）
  tenantTable('warehouses'),
  tenantTable('warehouse_locations'),
  tenantTable('stock_accounts'),
  tenantTable('stock_location_balances'),
  tenantTable('stock_movements'),
  tenantTable('stock_reservations'),
  tenantTable('stocktakes'),
  tenantTable('shipping_orders'),
  tenantTable('inventory_events'),
  tenantTable('inventory_operations'),
  tenantTable('release_facts'),
  // M2 reporting 线（2026-10-26 落库；守恒测试触发补登 + 全量重放迁移 20261026010400）
  tenantTable('work_reports'),
  tenantTable('report_audits'),
  tenantTable('reporting_events'),
  tenantTable('reporting_operations'),
  // M2 baseline P2/P3 线（2026-10-26 落库；守恒测试触发补登 + 全量重放迁移 20261026041000）
  tenantTable('routings'),
  tenantTable('standard_times'),
  tenantTable('fault_reports'),
  tenantTable('fault_events'),
  // M2 hours/costing 线（2026-10-26 落库；实施线漏登，总控合流补登 + 终版重放 20261026050000）
  tenantTable('labor_entries'),
  tenantTable('labor_ledger_months'),
  tenantTable('hours_operations'),
  tenantTable('cost_entries'),
  tenantTable('costing_models'),
  tenantTable('cost_snapshots'),
  tenantTable('costing_operations'),
  // M3 payroll 线（2026-10-26 落库；守恒测试触发补登 + 全量重放迁移 20261026061000）
  tenantTable('payroll_rules'),
  tenantTable('pay_runs'),
  tenantTable('earnings_records'),
  tenantTable('payroll_operations'),
  // M3 metric-pack 线（2026-10-26 落库；守恒测试触发补登 + 全量重放迁移 20261026091000）
  tenantTable('metric_pack_activations'),
  tenantTable('metric_pack_operations'),
  // M3 drawing 线（2026-10-26 落库；守恒测试触发补登 + 全量重放迁移 20261026100000；
  // 模块建表迁移占计划槽位 080000（早于已落库的 metric-pack 090000——按波次
  // 计划错峰，不影响全新库按名序应用；重放快照须取最新序守恒）
  tenantTable('drawing_revisions'),
  tenantTable('drawing_change_notices'),
  tenantTable('drawing_view_trails'),
  tenantTable('drawing_operations'),
  // M3 maintenance 线（2026-10-26 落库；守恒测试触发补登 + 全量重放迁移 20261026110000；
  // 模块建表迁移占计划槽位 070000（早于已落库的 drawing 080000——同波次计划
  // 错峰口径，不影响全新库按名序应用；重放快照须取最新序守恒）
  tenantTable('maintenance_plans'),
  tenantTable('maintenance_tasks'),
  tenantTable('maintenance_activities'),
  tenantTable('maintenance_operations'),
];
