/**
 * NestJS 组合根入口（ADR-0001/0004/0008）。
 * reflect-metadata 全仓唯一 import 点，必须先于一切装饰器类执行。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { TenantContext } from '@smes/application';
import { connectApprovalStore } from '@smes/business-store/approval';
import { connectBaselineStore } from '@smes/business-store/baseline';
import { connectCostingStore } from '@smes/business-store/costing';
import { connectDispatchStore } from '@smes/business-store/dispatch';
import { connectHoursStore } from '@smes/business-store/hours';
import { connectReportingStore } from '@smes/business-store/reporting';
import { connectInspectionStore } from '@smes/business-store/inspection';
import { connectInventoryStore } from '@smes/business-store/inventory';
import { connectListingStore } from '@smes/business-store/listing';
import { connectBusinessStore, runWithRlsTenant } from '@smes/business-store/org';
import { connectMasterdataStore } from '@smes/business-store/masterdata';
import { connectWorkbenchStore } from '@smes/business-store/workbench';
import { connectWorkOrderStore } from '@smes/business-store/workorder';
import { connectPayrollStore } from '@smes/business-store/payroll';
import { connectMaintenanceStore } from '@smes/business-store/maintenance';
import { connectDrawingStore } from '@smes/business-store/drawing';
import { connectMetricPackStore, connectMetricSourceBundle, type MetricSourceBundleHandle } from '@smes/business-store/metric-pack';
import { metricSourceSetOf } from '@smes/metric-pack';
import { hostBasedTenantResolver, TenantResolutionError, type TenantId } from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from './app-registry.js';
import { bindCrossModuleWiring } from './cross-module-wiring.js';
import { createIntegrationEdgeSinks } from './integration-edge-adapters.js';
import { parseKnownTenants } from './healthcheck-probe.js';
import { tenantResolutionErrorHandler } from './tenant-resolution-error.handler.js';
import { ApprovalErrorFilter } from './approval-error.filter.js';
import { AuthErrorFilter } from './auth-error.filter.js';
import { BaselineErrorFilter } from './baseline-error.filter.js';
import { DispatchErrorFilter } from './dispatch-error.filter.js';
import { CostingErrorFilter } from './costing-error.filter.js';
import { DomainErrorFilter } from './domain-error.filter.js';
import { HoursErrorFilter } from './hours-error.filter.js';
import { ReportErrorFilter } from './report-error.filter.js';
import { InspectionErrorFilter } from './inspection-error.filter.js';
import { InventoryErrorFilter } from './inventory-error.filter.js';
import { ListingErrorFilter } from './listing-error.filter.js';
import { OrgErrorFilter } from './org-error.filter.js';
import { WorkOrderErrorFilter } from './workorder-error.filter.js';
import { PayrollErrorFilter } from './payroll-error.filter.js';
import { MaintenanceErrorFilter } from './maintenance-error.filter.js';
import { DrawingErrorFilter } from './drawing-error.filter.js';
import { MetricPackErrorFilter } from './metric-pack-error.filter.js';

const DEFAULT_PORT = 3000;

/**
 * 租户中间件响应的结构子集（Express Response 的最小面）。组合根不直接依赖
 * express 类型（Nest 底座可换 platform-fastify）——结构 typing 与中间件
 * request: unknown 的既有取舍同向。
 */
interface TenantMiddlewareResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

async function bootstrap(): Promise<void> {
  const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
  // 策略注入测试钩子（POST /dev/policies）：默认关；显式 on 才装配（生产形态不开）。
  const devPolicyEndpoint = process.env['SMES_DEV_POLICY_ENDPOINT'] === 'on';

  // 启动零 DB 依赖（硬合同）：无 DATABASE_URL 时不构造任何 PrismaClient
  // （组织/策略/基础数据/待办/审批存储回落内存实现，模块仍可装配）；设了也只
  // 构造客户端——PrismaClient 惰性连接，bootstrap 阶段零查询、零握手，
  // 首条业务请求才真正连库。四个装配工厂各持一个惰性客户端（按模块子路径
  // 分面，组合根不合并——连接在首查询时才发生，常态单租户部署无感）。
  const businessStore = process.env['DATABASE_URL'] ? connectBusinessStore() : undefined;
  const masterdataStore = process.env['DATABASE_URL'] ? connectMasterdataStore() : undefined;
  const workbenchStore = process.env['DATABASE_URL'] ? connectWorkbenchStore() : undefined;
  const approvalStore = process.env['DATABASE_URL'] ? connectApprovalStore() : undefined;
  const baselineStore = process.env['DATABASE_URL'] ? connectBaselineStore() : undefined;
  const workOrderStoreHandle = process.env['DATABASE_URL'] ? connectWorkOrderStore() : undefined;
  const listingStoreHandle = process.env['DATABASE_URL'] ? connectListingStore() : undefined;
  const inspectionStoreHandle = process.env['DATABASE_URL'] ? connectInspectionStore() : undefined;
  const inventoryStoreHandle = process.env['DATABASE_URL'] ? connectInventoryStore() : undefined;
  const dispatchStoreHandle = process.env['DATABASE_URL'] ? connectDispatchStore() : undefined;
  const payrollStoreHandle = process.env['DATABASE_URL'] ? connectPayrollStore() : undefined;
  const reportingStoreHandle = process.env['DATABASE_URL'] ? connectReportingStore() : undefined;
  const hoursStoreHandle = process.env['DATABASE_URL'] ? connectHoursStore() : undefined;
  const costingStoreHandle = process.env['DATABASE_URL'] ? connectCostingStore() : undefined;
  const maintenanceStoreHandle = process.env['DATABASE_URL'] ? connectMaintenanceStore() : undefined;
  const drawingStoreHandle = process.env['DATABASE_URL'] ? connectDrawingStore() : undefined;
  const metricPackStoreHandle = process.env['DATABASE_URL'] ? connectMetricPackStore() : undefined;

  // 六源适配器束（接线 #24，仅 PG 形态有值）：六源各读不同模块表，connectMetricSourceBundle
  // 租户收口=构造注入（引擎 MetricSource 端口不带租户参数）——组合根按请求租户
  // 惰性构造并缓存（每租户一个 PrismaClient 惰性连接，首查询才握手）。零 DB =
  // 不注入 = 空源集（装载/清单语义完整，求值显式报"源未绑定"——语义诚实）。
  const metricSourceBundleByTenant = new Map<string, MetricSourceBundleHandle>();
  const metricPackSourceSetFor = process.env['DATABASE_URL']
    ? (tenant: TenantId): ReturnType<typeof metricSourceSetOf> => {
        const key = String(tenant);
        let bundle = metricSourceBundleByTenant.get(key);
        if (bundle === undefined) {
          bundle = connectMetricSourceBundle(tenant);
          metricSourceBundleByTenant.set(key, bundle);
        }
        return metricSourceSetOf(bundle.sources);
      }
    : undefined;

  // 边缘 sink 装配（M2 后第一增量，接线清单 #10/#18）：print 恒受理面
  // （integration-print in-memory pdf 端口）；IM 按 SMES_IM_* 环境装渠道，
  // 无外部配置返回 undefined → wiring 回落结构化 console 日志（不炸 boot）。
  const edgeSinks = createIntegrationEdgeSinks(process.env);

  const app = await NestFactory.create(
    buildAppModule(enabled, {
      devPolicyEndpoint,
      policyStore: businessStore?.policyStore,
      userStore: businessStore?.userStore,
      roleStore: businessStore?.roleStore,
      sessionStore: businessStore?.sessionStore,
      itemStore: masterdataStore?.itemStore,
      resourceStore: masterdataStore?.resourceStore,
      todoStore: workbenchStore?.todoStore,
      approvalCaseStore: approvalStore?.caseStore,
      approvalRecordStore: approvalStore?.recordStore,
      approvalEventStore: approvalStore?.eventStore,
      baselineProcessStore: baselineStore?.processStore,
      baselineEquipmentStore: baselineStore?.equipmentStore,
      baselineOutsourcingRuleStore: baselineStore?.outsourcingRuleStore,
      baselineValidationRunStore: baselineStore?.validationRunStore,
      baselineEventStore: baselineStore?.eventStore,
      baselineOperationLedger: baselineStore?.operationLedger,
      baselineRoutingStore: baselineStore?.routingStore,
      baselineStandardTimeStore: baselineStore?.standardTimeStore,
      baselineFaultReportStore: baselineStore?.faultReportStore,
      baselineFaultEventStore: baselineStore?.faultEventStore,
      payrollStores: payrollStoreHandle?.stores,
      maintenanceStores: maintenanceStoreHandle?.stores,
      drawingStores: drawingStoreHandle?.stores,
      metricPackStores: metricPackStoreHandle?.stores,
      metricPackSourceSetFor,
      workOrderStore: workOrderStoreHandle?.orderStore,
      workOrderAttachmentStore: workOrderStoreHandle?.attachmentStore,
      workOrderPartsStore: workOrderStoreHandle?.partsStore,
      workOrderKitStore: workOrderStoreHandle?.kitStore,
      workOrderOperationStore: workOrderStoreHandle?.operationStore,
      workOrderDomainEventStore: workOrderStoreHandle?.domainEventStore,
      workOrderMachineEventStore: workOrderStoreHandle?.machineEventStore,
      listingSheetStore: listingStoreHandle?.sheetStore,
      listingLineStore: listingStoreHandle?.lineStore,
      listingGapStore: listingStoreHandle?.gapStore,
      listingRequestStore: listingStoreHandle?.requestStore,
      listingOrderStore: listingStoreHandle?.orderStore,
      listingReturnStore: listingStoreHandle?.returnStore,
      listingOperationStore: listingStoreHandle?.operationStore,
      listingDomainEventStore: listingStoreHandle?.domainEventStore,
      listingMachineEventStore: listingStoreHandle?.machineEventStore,
      inspectionOrderStore: inspectionStoreHandle?.orderStore,
      inspectionNonconformStore: inspectionStoreHandle?.nonconformStore,
      inspectionOperationStore: inspectionStoreHandle?.operationStore,
      inspectionDomainEventStore: inspectionStoreHandle?.domainEventStore,
      inspectionMachineEventStore: inspectionStoreHandle?.machineEventStore,
      inventoryWarehouseStore: inventoryStoreHandle?.warehouseStore,
      inventoryAccountStore: inventoryStoreHandle?.accountStore,
      inventoryLocationBalanceStore: inventoryStoreHandle?.locationBalanceStore,
      inventoryMovementStore: inventoryStoreHandle?.movementStore,
      inventoryReservationStore: inventoryStoreHandle?.reservationStore,
      inventoryStocktakeStore: inventoryStoreHandle?.stocktakeStore,
      inventoryShippingStore: inventoryStoreHandle?.shippingStore,
      inventoryReleaseFactStore: inventoryStoreHandle?.releaseFactStore,
      inventoryOperationStore: inventoryStoreHandle?.operationStore,
      inventoryDomainEventStore: inventoryStoreHandle?.domainEventStore,
      inventoryMachineEventStore: inventoryStoreHandle?.machineEventStore,
      dispatchOrderStore: dispatchStoreHandle?.orderStore,
      dispatchOutsourcingLineStore: dispatchStoreHandle?.outsourcingLineStore,
      dispatchOperationStore: dispatchStoreHandle?.operationStore,
      dispatchDomainEventStore: dispatchStoreHandle?.domainEventStore,
      dispatchMachineEventStore: dispatchStoreHandle?.machineEventStore,
      reportingReportStore: reportingStoreHandle?.reportStore,
      reportingAuditStore: reportingStoreHandle?.auditStore,
      reportingOperationStore: reportingStoreHandle?.operationStore,
      reportingDomainEventStore: reportingStoreHandle?.domainEventStore,
      reportingMachineEventStore: reportingStoreHandle?.machineEventStore,
      hoursEntryStore: hoursStoreHandle?.entryStore,
      hoursMonthStore: hoursStoreHandle?.monthStore,
      hoursEventStore: hoursStoreHandle?.eventStore,
      hoursOperationStore: hoursStoreHandle?.operationStore,
      costingEntryStore: costingStoreHandle?.entryStore,
      costingModelStore: costingStoreHandle?.modelStore,
      costingSnapshotStore: costingStoreHandle?.snapshotStore,
      costingEventStore: costingStoreHandle?.eventStore,
      costingOperationStore: costingStoreHandle?.operationStore,
      printSink: edgeSinks.printSink,
      imSink: edgeSinks.imSink,
    }),
  );

  // 域错误 -> HTTP 状态（400/401/404/409；域错误类在 application，映射在组合根）。
  app.useGlobalFilters(
    new OrgErrorFilter(),
    new AuthErrorFilter(),
    new DomainErrorFilter(),
    new ApprovalErrorFilter(),
    new BaselineErrorFilter(),
    new WorkOrderErrorFilter(),
    new ListingErrorFilter(),
    new InspectionErrorFilter(),
    new InventoryErrorFilter(),
    new DispatchErrorFilter(),
    new ReportErrorFilter(),
    new HoursErrorFilter(),
    new CostingErrorFilter(),
    new PayrollErrorFilter(),
    new MaintenanceErrorFilter(),
    new DrawingErrorFilter(),
    new MetricPackErrorFilter(),
  );

  // 跨模块端口接线收口（M2 后第一增量）：buildAppModule 已把 store 级适配器随
  // register 注入；此处完成 service 级端口的"构造后注入"（迟到绑定回填真实
  // service 实例，见 cross-module-wiring.ts 文件头）。
  bindCrossModuleWiring(app);

  // TenantContext 中间件（ADR-0005）：每请求解析租户，并在其上下文内执行下游处理链。
  // 单租户形态 resolve 恒返回 'default'，包装开销仅一次闭包调用。
  const tenantContext = app.get(TenantContext);

  // 租户解析形态开关（ADR-0005/D8 双形态，M4 正式线）：SMES_TENANT_MODE 环境注入。
  //   single-node（缺省）——不触碰解析器（fixedDefaultTenant 恒 'default'），
  //     与本接线前行为逐位相同（零回归合同）；未知取值 fail-fast 拒绝启动
  //     （对齐 parseModulesEnabled 的配置拼写错误不静默语义）。
  //   saas——hostBasedTenantResolver({domain, lookup})：`{tenant}.{SMES_DOMAIN}` →
  //     租户，域外/未知租户/缺 Host 抛 TenantResolutionError（fail-closed——SaaS
  //     形态没有回落默认租户，回落即串租户；下方中间件窄捕并映射 4xx，见其
  //     注释块——M5 收尾波前曾落 Express 默认 500）。
  //     已知租户清单 = SMES_TENANTS 逗号静态列表（租户管理流程与异步查库 adapter
  //     属 M4 后续波，取舍见 business-core tenant-resolution.ts 文件头）。
  //   注入取舍（写明）：经 DI 单例 useResolver 装配，与 CoreModule.register
  //   ({ tenantResolver }) 的 useValue 供给是同一实例同一接入点
  //   （tenant-context.ts 的 useResolver 注释即 M4 接入点），免改 app-registry 结构。
  const tenantMode = process.env['SMES_TENANT_MODE'] ?? 'single-node';
  let rlsTenantPropagation = false;
  if (tenantMode === 'saas') {
    const domain = process.env['SMES_DOMAIN'] ?? '';
    // 已知租户解析与镜像内健康探针同源（双写去重：healthcheck-probe.ts 单份）。
    const knownTenants = parseKnownTenants(process.env['SMES_TENANTS']);
    if (domain.length === 0) {
      throw new Error(
        'SMES_TENANT_MODE=saas 需要 SMES_DOMAIN（子域名解析基域）——缺省拒绝启动（fail-fast）',
      );
    }
    if (knownTenants.length === 0) {
      throw new Error(
        'SMES_TENANT_MODE=saas 需要 SMES_TENANTS（已知租户逗号清单）——缺省拒绝启动（fail-fast）',
      );
    }
    tenantContext.useResolver(
      hostBasedTenantResolver({ domain, lookup: () => knownTenants }),
    );
    rlsTenantPropagation = true;
  } else if (tenantMode !== 'single-node') {
    throw new Error(
      `未知 SMES_TENANT_MODE '${tenantMode}'（可用：single-node | saas）——拒绝启动（fail-fast）`,
    );
  }

  // 租户解析失败 → 4xx（M5 收尾波，替代 Express 默认 500；语义写明）：
  // - 域内未知租户（reason 'unknown-tenant'）→ 404 Not Found：Host 属本域但
  //   租户不存在——通配 DNS 下等价 NXDOMAIN，客户端/反代据此提示"租户不存在"。
  // - 其余解析失败（'off-domain' 域外 Host / 'missing-host' 缺 Host /
  //   'invalid-subdomain' 裸基础域或非单级子域）→ 421 Misdirected Request
  //   （RFC 9110 §15.5.20）：请求被发到了无法为该 Host 产出响应的服务——
  //   正是 vhost 走错的语义，客户端应改连正确的 origin。
  // fail-closed 语义不变：任何解析失败都不回落默认租户、不进入下游处理链；
  // 404/421 与 500 同样阻断请求，只是把"服务器配置错"与"客户端走错门"分开
  // （500 会被监控当作服务故障误报）。reason 是结构化字段（business-core
  // TenantResolutionError），不依赖 message 文本匹配。响应体仅含错误消息
  // （消息内只有客户端自带的 Host 与非密的域配置），不回显任何租户数据。
  const respondTenantResolutionFailure = (
    response: TenantMiddlewareResponse,
    error: TenantResolutionError,
  ): void => {
    const isUnknownTenant = error.reason === 'unknown-tenant';
    const statusCode = isUnknownTenant ? 404 : 421;
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(`${JSON.stringify({ statusCode, error: isUnknownTenant ? 'Not Found' : 'Misdirected Request', message: error.message })}\n`);
  };

  app.use((request: unknown, response: unknown, next: () => void) => {
    let tenant: TenantId;
    try {
      tenant = tenantContext.resolve(request);
    } catch (error) {
      // 仅窄捕租户解析错误（其余异常维持 Express 原生 500 路径，不吞意外错误）
      if (error instanceof TenantResolutionError) {
        respondTenantResolutionFailure(response as TenantMiddlewareResponse, error);
        return;
      }
      throw error;
    }
    // RLS 电流路径（saas 形态）：请求租户同步传入 business-store 侧 RLS 会话上下文
    // （rls-session 自持独立 TenantContext，ALS 跨实例不可见——不包裹则
    // withRlsTenantSession 读不到请求租户、回落 'default'，见 rls-session.ts 文件头
    // 取舍）。同一异步链上已接线的连接工厂（M4 收尾波 ESCALATION-2 起**全部
    // 18 家 connect\* 工厂**：先例四家 org / masterdata / workbench / approval +
    // 其余十四家）在操作事务内 SET app.current_tenant 生效；事务/raw 边界
    // （原子性取舍）见 rls-session.ts 已知边界节。缺省/单机形态不包裹
    // （零行为变化：回落值与解析值同为 'default'）。
    if (rlsTenantPropagation) {
      runWithRlsTenant(tenant, () => tenantContext.run(tenant, () => next()));
    } else {
      tenantContext.run(tenant, () => next());
    }
  });

  // 租户解析失败 → 421（Express 全局错误中间件形态：中间件层异常不进 Nest
  // 异常过滤器——机制与状态码取舍见 tenant-resolution-error.handler.ts 文件头）。
  app.use(tenantResolutionErrorHandler);

  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  await app.listen(port);
  const storage = businessStore === undefined ? 'memory' : 'postgres';
  console.log(
    `[smes] server ready on http://localhost:${port} (modules: ${enabled.join(',')}; stores: ${storage})`,
  );
}

void bootstrap();
