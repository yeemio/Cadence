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
  // 模块建表迁移占计划槽位 070000（早于已落库的 drawing 080000——按波次
  // 计划错峰，不影响全新库按名序应用；重放快照须取最新序守恒）
  tenantTable('maintenance_plans'),
  tenantTable('maintenance_tasks'),
  tenantTable('maintenance_activities'),
  tenantTable('maintenance_operations'),
  // S1 backfill 线（2026-10-26 落库：0920 #3/#7/#8/#9/#100/#103 六表；
  // 守恒测试触发补登 + 全量重放迁移 20261026121000）
  tenantTable('departments'),
  tenantTable('positions'),
  tenantTable('customers'),
  tenantTable('suppliers'),
  tenantTable('units'),
  tenantTable('audit_logs'),
  // T 波 S5 能力子集线（2026-10-26 落库：#98/99 菜单管理 / #102 审批配置 /
  // #101 通知中心 三表；守恒测试触发补登 + 全量重放迁移 20261026131000）
  tenantTable('menu_configs'),
  tenantTable('approval_flow_configs'),
  tenantTable('notifications'),
  // U1 issue 发料链路线（2026-10-26 落库：A11 增量 发料任务/发料记录 五表；
  // 守恒测试触发补登 + 全量重放迁移 20261026140100）
  tenantTable('issue_tasks'),
  tenantTable('issue_task_lines'),
  tenantTable('issue_records'),
  tenantTable('issue_expresses'),
  tenantTable('issue_operations'),
  // U3 attachment 附件中心线（2026-10-26 落库：A13 统一附件元数据单表；
  // 守恒测试触发补登 + 全量重放迁移 20261026150100）
  tenantTable('attachments'),
  // U4 listing 工序×原材料关联线（2026-10-26 落库：S10 数据面单表；
  // 守恒测试触发补登 + 全量重放迁移 20261026160100）
  tenantTable('process_material_links'),
  // U5 aftercare claim 售后报销线（2026-10-26 落库：A12 售后报销两表——报销单
  // 投影 + 明细行；守恒测试触发补登 + 全量重放迁移 20261026161000——晚于 U4
  // 兄弟线 160100 重放，快照含全量表集）
  tenantTable('aftercare_claims'),
  tenantTable('aftercare_claim_lines'),
  // U7 项目成本六块线（2026-10-26 落库：A5 段事实/六块快照/录入价格三表；
  // 守恒测试触发补登 + 全量重放迁移 20261026170100——101 表快照）
  tenantTable('cost_project_entries'),
  tenantTable('cost_project_snapshots'),
  tenantTable('cost_price_entries'),
  // fix-wave-4 W4-2 线（2026-10-26 落库：D-3 附件对象字节表，ObjectStoragePort
  // PG 适配器持久化通道；守恒测试触发补登 + 全量重放迁移 20261026180100——102 表快照）
  tenantTable('attachment_objects'),
  // A8/A10 首波（2026-10-26 落库：RREQ-RP-027 每日机加工进度统计日表，报表域
  // 自持统计快照；守恒测试触发补登 + 全量重放迁移 20261026190100——103 表快照）
  tenantTable('machining_daily_stats'),
  // fix-wave-6 6b-3 线（2026-10-26 落库：A14 / RREQ-INT-032 用户表格列显隐
  // 偏好单表；守恒测试触发补登 + 全量重放迁移 20261026200100——104 表快照）
  tenantTable('column_preferences'),
];
