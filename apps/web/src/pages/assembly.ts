/**
 * 页面装配注册表（S2 批次从 main.tsx 抽提）：模块代码 → 页面组件的映射在此
 * 单点维护，main.tsx 只消费；装配测试（tests/module-pages.test.ts）直接对
 * 本注册表断言，防"菜单有路由、装配表漏页"漂移。
 */
import type { ComponentType } from 'react';
import { ItemsPage } from './masterdata/ItemsPage';
import { ResourcesPage } from './masterdata/ResourcesPage';
import { CustomersPage } from './masterdata/CustomersPage';
import { SuppliersPage } from './masterdata/SuppliersPage';
import { UnitsPage } from './masterdata/UnitsPage';
import { WorkbenchPage } from './workbench/WorkbenchPage';
import { OrgRolesPage } from './org/OrgRolesPage';
import { OrgUsersPage } from './org/OrgUsersPage';
import { DepartmentsPage } from './org/DepartmentsPage';
import { PositionsPage } from './org/PositionsPage';
import { AuditLogsPage } from './audit/AuditLogsPage';
import { StandardReportsPage } from './reporting/StandardReportsPage';
// ---- T1 能力子集（#1 运营总览 / #98+99 菜单管理 / #101 通知中心 / #102 审批配置） ----
import { OverviewIndexPage } from './overview/IndexPage';
import { MenuConfigsPage } from './system/MenuConfigsPage';
import { ApprovalConfigPage } from './system/ApprovalConfigPage';
import { NotificationsPage } from './notifications/NotificationsPage';
import { ScanPage } from './scan/ScanPage';
import { WorkOrdersPage } from './workorder/WorkOrdersPage';
import { PartsRequestsPage } from './workorder/PartsRequestsPage';
import { ListingSheetsPage } from './listing/ListingSheetsPage';
import { GapChecksPage } from './listing/GapChecksPage';
import { PurchaseRequestsPage } from './listing/PurchaseRequestsPage';
import { PurchaseOrdersPage } from './listing/PurchaseOrdersPage';
import { PurchaseReturnsPage } from './listing/PurchaseReturnsPage';
import { PurchaseDetailsPage } from './listing/PurchaseDetailsPage';
import { DispatchOrdersPage } from './dispatch/DispatchOrdersPage';
import { OutsourcingLinesPage } from './dispatch/OutsourcingLinesPage';
import { ReportsPage } from './reporting/ReportsPage';
import { ReportVerifyPage } from './reporting/ReportVerifyPage';
import { InspectionOrdersPage } from './inspection/InspectionOrdersPage';
import { NonconformitiesPage } from './inspection/NonconformitiesPage';
import { WarehousesPage } from './inventory/WarehousesPage';
import { StockLevelsPage } from './inventory/StockLevelsPage';
import { StockOperationsPage } from './inventory/StockOperationsPage';
import { StocktakesPage } from './inventory/StocktakesPage';
import { ShippingOrdersPage } from './inventory/ShippingOrdersPage';
import { HoursStatsPage } from './hours/HoursStatsPage';
import { CostingPage } from './costing/CostingPage';
import { ProcessesPage } from './baseline/ProcessesPage';
import { EquipmentPage } from './baseline/EquipmentPage';
import { RoutingsPage } from './baseline/RoutingsPage';
import { StandardTimesPage } from './baseline/StandardTimesPage';
import { OutsourcingRulesPage } from './baseline/OutsourcingRulesPage';
import { FaultReportsPage } from './baseline/FaultReportsPage';
import { MaterialValidationsPage } from './baseline/MaterialValidationsPage';
// ---- D-WO-05：图纸文档组两页（drawing 域桌面呈现面） ----
import { DrawingLibraryPage } from './drawing/DrawingLibraryPage';
import { DrawingAuditPage } from './drawing/DrawingAuditPage';
import { MobileWorkbenchPage } from './m/WorkbenchPage';
import { MobileReportPage } from './m/ReportPage';
import { MobileHoursPage } from './m/HoursPage';
import { MobileStockPage } from './m/StockPage';
// ---- S3-d：移动呈现 11 子页（覆盖矩阵 §3.2 19 项 + §3.4 #116） ----
import { MobileVerifyPage } from './m/VerifyPage';
import { MobilePartsPage } from './m/PartsPage';
import { MobilePartsApprovalPage } from './m/PartsApprovalPage';
import { MobileInspectionPage } from './m/InspectionPage';
import { MobileFaultPage } from './m/FaultPage';
import { MobileReceiptPage } from './m/ReceiptPage';
import { MobileTransferPage } from './m/TransferPage';
import { MobileStocktakePage } from './m/StocktakePage';
import { MobileProgressPage } from './m/ProgressPage';
import { MobileOpProgressPage } from './m/OpProgressPage';
import { MobileMinePage } from './m/MinePage';

/** 桌面模块代码 -> 页面装配（占位页之外的已实现页面在此挂接）。 */
export const PAGE_BY_CODE: Record<string, ComponentType> = {
  workbench: WorkbenchPage,
  'masterdata-item': ItemsPage,
  'masterdata-resource': ResourcesPage,
  scan: ScanPage,
  'system-user': OrgUsersPage,
  'system-role': OrgRolesPage,
  // ---- S2 批次：九循环模块桌面管理页（覆盖矩阵 §3.3 的 61 项） ----
  workorder: WorkOrdersPage,
  'workorder-parts': PartsRequestsPage,
  'listing-sheets': ListingSheetsPage,
  'listing-gap-checks': GapChecksPage,
  dispatch: DispatchOrdersPage,
  'outsourcing-lines': OutsourcingLinesPage,
  reports: ReportsPage,
  'report-verification': ReportVerifyPage,
  'purchase-requests': PurchaseRequestsPage,
  'purchase-orders': PurchaseOrdersPage,
  'purchase-returns': PurchaseReturnsPage,
  'purchase-details': PurchaseDetailsPage,
  inspections: InspectionOrdersPage,
  nonconformities: NonconformitiesPage,
  warehouses: WarehousesPage,
  'stock-levels': StockLevelsPage,
  'stock-operations': StockOperationsPage,
  stocktakes: StocktakesPage,
  'shipping-orders': ShippingOrdersPage,
  'hours-stats': HoursStatsPage,
  costing: CostingPage,
  'baseline-processes': ProcessesPage,
  'baseline-equipment': EquipmentPage,
  'baseline-routings': RoutingsPage,
  'baseline-standard-times': StandardTimesPage,
  'baseline-outsourcing-rules': OutsourcingRulesPage,
  'baseline-fault-reports': FaultReportsPage,
  'baseline-material-validations': MaterialValidationsPage,
  // ---- D-WO-05：图纸文档组两页挂接（菜单码 drawing-library/drawing-audit） ----
  'drawing-library': DrawingLibraryPage,
  'drawing-audit': DrawingAuditPage,
  // ---- S3-a：主数据/审计/标准报表七页（S1 backfill 端点接页面） ----
  'masterdata-customer': CustomersPage,
  'masterdata-supplier': SuppliersPage,
  'masterdata-unit': UnitsPage,
  'system-department': DepartmentsPage,
  'system-position': PositionsPage,
  'system-audit': AuditLogsPage,
  'standard-reports': StandardReportsPage,
  // ---- T1 能力子集（覆盖矩阵 §3.4 #1/98/99/101/102） ----
  overview: OverviewIndexPage,
  'system-menus': MenuConfigsPage,
  'system-approval-config': ApprovalConfigPage,
  notifications: NotificationsPage,
};

/** 移动页面码 -> 页面装配（注册表见 mobile.ts；预研 scan-report 已升级为 m.report）。 */
export const MOBILE_PAGE_BY_CODE: Record<string, ComponentType> = {
  'm.workbench': MobileWorkbenchPage,
  'm.report': MobileReportPage,
  'm.hours': MobileHoursPage,
  'm.stock': MobileStockPage,
  // ---- S3-d：11 子页挂接（码/路径/权限单一事实源在 mobile.ts MOBILE_SUBPAGES）----
  'm.verify': MobileVerifyPage,
  'm.parts': MobilePartsPage,
  'm.parts-approval': MobilePartsApprovalPage,
  'm.inspection': MobileInspectionPage,
  'm.fault': MobileFaultPage,
  'm.receipt': MobileReceiptPage,
  'm.transfer': MobileTransferPage,
  'm.stocktake': MobileStocktakePage,
  'm.progress': MobileProgressPage,
  'm.op-progress': MobileOpProgressPage,
  'm.mine': MobileMinePage,
};
