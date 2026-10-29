import { PgManufacturingStore } from '@smes/business-store/manufacturing';
import { ManufacturingService, ManufacturingQualityService, ManufacturingCommandGuard, InventoryService, DispatchService, ListingService, InspectionService } from '@smes/application';
import { makeCommandEnvelope, OperationId, UserId } from '@smes/business-core';
/**
 * NestJS 组合根入口（ADR-0001/0004/0008）。
 * reflect-metadata 全仓唯一 import 点，必须先于一切装饰器类执行。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TenantContext, reportSourceProviderOf, type ReportSourceProvider, LocalFileSystemObjectStorage, InMemoryObjectStorage } from '@smes/application';
import {
  DEFAULT_PASSWORD_MIN_LENGTH,
  InMemoryLoginAttemptStore,
  LOGIN_LOCK_MS_DEFAULT,
  LOGIN_MAX_FAILURES_DEFAULT,
  LOGIN_WINDOW_MS_DEFAULT,
  PASSWORD_MAX_LENGTH,
  type LoginAttemptStoreParams,
  type PasswordPolicy,
} from '@smes/application';
import { connectApprovalStore } from '@smes/business-store/approval';
import { connectBaselineStore } from '@smes/business-store/baseline';
import { connectCostingStore, connectProjectCostStore } from '@smes/business-store/costing';
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
import { connectAuditStore } from '@smes/business-store/audit';
import { connectStandardReportsSources } from '@smes/business-store/standardreports';
import { connectMenuConfigStore } from '@smes/business-store/menu-config';
import { connectNotificationStore } from '@smes/business-store/notifications';
import { connectApprovalConfigStore } from '@smes/business-store/approval-config';
import { connectIssueStore } from '@smes/business-store/issue';
import { connectAttachmentStore, connectAttachmentObjectStorage } from '@smes/business-store/attachment';
import { DrawingReadReferenceSigner } from '@smes/drawing';
import { connectColumnPreferenceStore } from '@smes/business-store/column-preferences';
import { connectMachiningDailyStore } from '@smes/business-store/standardreports';
import { metricSourceSetOf } from '@smes/metric-pack';
import { hostBasedTenantResolver, TenantResolutionError, type TenantId } from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from './app-registry.js';
import { bindCrossModuleWiring } from './cross-module-wiring.js';
import { createIntegrationEdgeSinks } from './integration-edge-adapters.js';
import { parseKnownTenants } from './healthcheck-probe.js';
import { tenantResolutionErrorHandler } from './tenant-resolution-error.handler.js';
import { ApprovalErrorFilter } from './approval-error.filter.js';
import { AuthErrorFilter } from './auth-error.filter.js';
import { NavigationErrorFilter } from './navigation-error.filter.js';
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
import { BackfillErrorFilter } from './backfill-error.filter.js';
import { CapabilityErrorFilter } from './capability-error.filter.js';
import { UWaveErrorFilter } from './u-wave-error.filter.js';
import { ColumnPreferenceErrorFilter } from './column-preference-error.filter.js';
import { AiQueryErrorFilter } from './ai-query-error.filter.js';

const DEFAULT_PORT = 3000;

// ---------------------------------------------------------------------------
// M2 安全前置批 CM-1（波 b，SP-6 评估落地）：安全响应头。本中间件是
// **server 直连拓扑**（SaaS 子域 / IP:3000 直连——deploy compose 的 saas
// proxy 形态，浏览器请求不经 web nginx）的权威层；web nginx 形态下与
// apps/web/nginx.conf 同值叠加（两处同值——重复头浏览器取交集，同值无害）。
//
// CSP 与 apps/web 实际加载实态逐一对应（不机械复制示例；依据清单见
// nginx.conf 头注，两处同值、同注释口径维护）：
//   - script-src 'self' + sha256(vite-plugin-pwa injectRegister:'inline' 注入的
//     SW 注册内联脚本，index.html/login.html 同串——插件版本不变即稳定)；
//   - style-src 'self' + sha256(offline.html 内联 <style>，纯静态壳页)；
//   - img-src data:(内置位图/SVG)data URI + blob:(html5-qrcode 扫描帧)；
//   - worker-src blob:(papaparse Web Worker 由 Blob URL 构造)；
//   - connect-src 'self'（VITE_API_BASE_URL 缺省 ''=同源，SSE 同源）。
// 不放开 'unsafe-inline'/'unsafe-eval'——dist 实测无 eval/无游离内联。
// ---------------------------------------------------------------------------

/** CM-1：CSP 策略（与 apps/web/nginx.conf 同值单份口径，改动须两处同步）。 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'sha256-l0IHPvf8eV52c9mPJymShDKYQmoP/YyzUHeE31FDYIs='",
  "style-src 'self' 'sha256-YtOWrAqaz/Nyg+osXB9QQeza3DEx372rEodcEB9gJ5o='",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** CM-1：安全响应头集（CSP/nosniff/Referrer-Policy/frame 限制）。 */
const SECURITY_RESPONSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', CONTENT_SECURITY_POLICY],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['X-Frame-Options', 'DENY'],
];

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

// ---------------------------------------------------------------------------
// M2 安全前置批线 A env 解析（SP-1 登录限流 / SP-4 口令策略）——集中在本
// 组合根入口，配置非法 fail-fast 拒启动（沿 SMES_TENANT_MODE 拼写错误不
// 静默语义，main.ts L373 先例）；空串 = 未设（compose ${VAR:-} 空串透传形态）。
// ---------------------------------------------------------------------------

/** 正整数 env：非空时须为 ≥1 的整数，否则 fail-fast。 */
function parsePositiveIntEnv(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  const message = max === undefined
    ? `环境变量 ${name} 须为正整数（当前：'${raw}'）——拒绝启动（fail-fast）`
    : `环境变量 ${name} 须为 1~${max} 的整数（当前：'${raw}'）——拒绝启动（fail-fast）`;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(message);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new Error(message);
  }
  return value;
}

/**
 * SP-1 登录限流参数（缺省 5 次失败 / 15 分钟计数窗 / 锁定 15 分钟；秒值
 * 转 ms）。e2e 与演示需要短窗时经 env 覆写。
 */
function parseLoginRateLimitEnv(): LoginAttemptStoreParams {
  const maxFailures = parsePositiveIntEnv('SMES_LOGIN_MAX_FAILURES', LOGIN_MAX_FAILURES_DEFAULT);
  const windowSeconds = parsePositiveIntEnv('SMES_LOGIN_WINDOW_SECONDS', LOGIN_WINDOW_MS_DEFAULT / 1000);
  const lockSeconds = parsePositiveIntEnv('SMES_LOGIN_LOCK_SECONDS', LOGIN_LOCK_MS_DEFAULT / 1000);
  return {
    maxFailures,
    windowMs: windowSeconds * 1000,
    lockMs: lockSeconds * 1000,
  };
}

/**
 * SP-4 口令强度策略：最小长度缺省 8（1~128，越界 fail-fast）；字符类要求
 * 开关缺省关（on|off，其他取值 fail-fast——渐进收紧不破既有使用习惯）。
 */
function parsePasswordPolicyEnv(): PasswordPolicy {
  const minLength = parsePositiveIntEnv(
    'SMES_PASSWORD_MIN_LENGTH',
    DEFAULT_PASSWORD_MIN_LENGTH,
    PASSWORD_MAX_LENGTH,
  );
  const classesRaw = process.env['SMES_PASSWORD_REQUIRE_CLASSES'];
  let requireClasses = false;
  if (classesRaw !== undefined && classesRaw.trim() !== '') {
    const trimmed = classesRaw.trim();
    if (trimmed === 'on') {
      requireClasses = true;
    } else if (trimmed !== 'off') {
      throw new Error(
        `环境变量 SMES_PASSWORD_REQUIRE_CLASSES 须为 on|off（当前：'${classesRaw}'）——拒绝启动（fail-fast）`,
      );
    }
  }
  return { minLength, requireClasses };
}

// ---------------------------------------------------------------------------
// M2 安全前置批 SP-3（波 b）：附件/图纸两域签名密钥 env 解析。两键
// （SMES_ATTACHMENT_REF_SECRET / SMES_DRAWING_REF_SECRET）值 = base64 或 hex
// 编码、解码后恰 32 字节，直接作 HMAC-SHA256 key（不做 KDF 派生）。格式非法
// fail-fast 拒启动（沿上方线 A env 同语义）；未设/空串（compose ${VAR:-} 空串
// 透传形态）→ undefined = 实例内随机 + bootstrap 段 warn 一行（单实例
// dev/demo 行为不变；多实例部署必须设——deploy/.env.example 与 deploy/README
// 同批登记）。env 固化只改跨重启/跨实例可用性：TTL（附件 60s 级/图纸 ≤600s）
// 与「token 即唯一凭证」语义不动；真实对象存储接入后由 SDK 预签名取代。
// ---------------------------------------------------------------------------

/**
 * SP-3 签名密钥 env：未设/空串 → undefined；hex 须恰 64 字符（→32 字节，
 * 先判——64 hex 字符按 base64 解得 48 字节，hex 是唯一满足 32 字节的解读，
 * 无真歧义）；base64 须严格字符集且解码恰 32 字节（43 无填充/44 含 '='）。
 * 其余一律 fail-fast（不静默截断/回退——密钥弱化即令牌伪造面）。
 */
function parseSigningKeyEnv(name: string): Uint8Array | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  const failFast = (): never => {
    throw new Error(
      `环境变量 ${name} 须为 base64 或 hex 编码、解码后恰 32 字节的 HMAC 签名密钥（当前：'${trimmed}'，${trimmed.length} 字符）——拒绝启动（fail-fast）`,
    );
  };
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    if (trimmed.length !== 64) failFast();
    return new Uint8Array(Buffer.from(trimmed, 'hex'));
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length < 43 || trimmed.length > 44) {
    failFast();
  }
  const key = new Uint8Array(Buffer.from(trimmed, 'base64'));
  if (key.length !== 32) failFast();
  return key;
}

/** SP-3 未设 env 的启动 warn（一行；只提示可用性语义，不含任何凭据）。 */
function warnSigningKeyEnvUnset(name: string, domain: string): void {
  console.warn(
    `[smes] ${name} 未设置——${domain}签名密钥实例内随机生成，重启后既有只读引用失效（单实例演示可用；多实例/跨重启固化必须设置，见 deploy/README）`,
  );
}

async function bootstrap(): Promise<void> {
  const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
  // 策略注入测试钩子（POST /dev/policies）：默认关；显式 on 才装配（生产形态不开）。
  const devPolicyEndpoint = process.env['SMES_DEV_POLICY_ENDPOINT'] === 'on';

  // M2 安全前置批线 A：SP-1 登录限流参数 + SP-4 口令策略（env 非法 fail-fast
  // 在此先行——起服前拒绝，不进 NestFactory）。
  const loginRateLimit = parseLoginRateLimitEnv();
  const passwordPolicy = parsePasswordPolicyEnv();

  // M2 安全前置批 SP-3（波 b）：附件/图纸两域签名密钥——env 单点读取。设了
  // → 三附件适配器（local-fs/pg/in-memory）与图纸签发器统一注入同 key（跨
  // 重启/跨实例引用可用）；未设 → 实例内随机 + warn 一行（零回归）。
  const attachmentRefSigningKey = parseSigningKeyEnv('SMES_ATTACHMENT_REF_SECRET');
  if (attachmentRefSigningKey === undefined) {
    warnSigningKeyEnvUnset('SMES_ATTACHMENT_REF_SECRET', '附件');
  }
  const drawingRefSigningKey = parseSigningKeyEnv('SMES_DRAWING_REF_SECRET');
  if (drawingRefSigningKey === undefined) {
    warnSigningKeyEnvUnset('SMES_DRAWING_REF_SECRET', '图纸');
  }

  // 启动零 DB 依赖（硬合同）：无 DATABASE_URL 时不构造任何 PrismaClient
  // （组织/策略/基础数据/待办/审批存储回落内存实现，模块仍可装配）；设了也只
  // 构造客户端——PrismaClient 惰性连接，bootstrap 阶段零查询、零握手，
  // 首条业务请求才真正连库。四个装配工厂各持一个惰性客户端（按模块子路径
  // 分面，组合根不合并——连接在首查询时才发生，常态单租户部署无感）。
  const businessStore = process.env['DATABASE_URL']
    ? connectBusinessStore({ loginAttempt: loginRateLimit })
    : undefined;
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
  // U7 项目成本三存储（段事实/六块快照/录入价格）：同上惰性连接；零 DB 不注入
  // = buildAppModule 回落模块内存实现（六块归集零接线形态语义完整）。
  const projectCostStoreHandle = process.env['DATABASE_URL'] ? connectProjectCostStore() : undefined;
  const maintenanceStoreHandle = process.env['DATABASE_URL'] ? connectMaintenanceStore() : undefined;
  const drawingStoreHandle = process.env['DATABASE_URL'] ? connectDrawingStore() : undefined;
  const metricPackStoreHandle = process.env['DATABASE_URL'] ? connectMetricPackStore() : undefined;
  // S1 backfill（0920 #103 操作日志 / #89/91/92/96 标准报表四源）：同上惰性连接；
  // 四源租户收口=构造注入（引擎 MetricSource 端口不带租户参数）——组合根按请求
  // 租户惰性构造并缓存（每租户一个 PrismaClient 惰性连接，同 metric 六源先例）。
  // 零 DB = 不注入 = 未绑定源（求值显式 503——口径装载完整，数据面诚实缺失）。
  const auditStoreHandle = process.env['DATABASE_URL'] ? connectAuditStore() : undefined;
  // T1 能力子集三存储（0920 #98/99/#101/#102）：同上惰性连接；零 DB = 不注入
  // （buildAppModule 在模块装配时回落内存实现并裁决共享实例——通知桥/审批
  // 解析器与模块端点同源）。
  const menuConfigStoreHandle = process.env['DATABASE_URL'] ? connectMenuConfigStore() : undefined;
  const notificationStoreHandle = process.env['DATABASE_URL'] ? connectNotificationStore() : undefined;
  const approvalConfigStoreHandle = process.env['DATABASE_URL'] ? connectApprovalConfigStore() : undefined;
  // U6 接线波两存储（issue 六存储 / attachment 元数据）：同上惰性连接；零 DB
  // 不注入 = buildAppModule 回落模块内存实现（零 DB boot 语义完整）。
  const issueStoreHandle = process.env['DATABASE_URL'] ? connectIssueStore() : undefined;
  const attachmentStoreHandle = process.env['DATABASE_URL'] ? connectAttachmentStore() : undefined;
  // fix-wave-6 6b-3（A14）：列显隐偏好存储——同上惰性连接；零 DB 不注入 =
  // buildAppModule 装配时回落模块内存实现（零 DB boot 语义完整）。
  const columnPreferenceStoreHandle = process.env['DATABASE_URL']
    ? connectColumnPreferenceStore()
    : undefined;
  // A10 机加日统计存储（A8/A10 首波，6a-3 裁决 1 修复项）：PG 形态经
  // connectMachiningDailyStore 注入（此前该工厂零消费——screen 的
  // machiningDailyStatsStore 在零 DB/PG 两形态下均落空，端点 500）；零 DB
  // 不注入 = buildAppModule 工厂调用处回落内存实例（零 DB boot 语义完整）。
  const machiningDailyStoreHandle = process.env['DATABASE_URL']
    ? connectMachiningDailyStore()
    : undefined;
  // fix-wave-4 W4-2（D-3）：attachment 对象字节 PG 适配器——同上惰性连接；有
  // DATABASE_URL 的部署形态附件字节入库 attachment_objects（bytea），重启随
  // pg-data 卷存活（修复内存适配器重启即丢、download-reference 502）。
  const attachmentObjectStorageHandle = process.env['DATABASE_URL']
    ? connectAttachmentObjectStorage({ signingKey: attachmentRefSigningKey })
    : undefined;
  // 对象存储（U6；W4-2 装配切换）：SMES_ATTACHMENT_DIR 显式存在 → 本地文件
  // 适配器（运维显式覆盖，字节落盘跨重启存活——既有行为保留）；否则
  // DATABASE_URL 存在 → PG bytea 适配器（部署形态即此形态）；否则不注入 =
  // 模块内存适配器（零 DB 演示回落，重启即失——语义诚实，MinIO/S3 部署期
  // 换装经同端口替换，不动业务面）。DIR 与 PG 并存时 DIR 优先（显式覆盖
  // 语义优先，预研 §4-1 缺省建议；最终取舍归 Owner 裁定）。
  const attachmentObjectStorage = process.env['SMES_ATTACHMENT_DIR']
    ? new LocalFileSystemObjectStorage({
        rootDirectory: process.env['SMES_ATTACHMENT_DIR'],
        // SP-3：env 固化密钥注入（未设 = undefined 同缺省随机，行为不变）
        signingKey: attachmentRefSigningKey,
      })
    : (attachmentObjectStorageHandle?.objectStorage ??
      // SP-3：零 DB 兜底形态也统一注入（三适配器一致）；未设 env 不构造 =
      // 模块内随机实例（字节本就重启即失，零回归）。
      (attachmentRefSigningKey === undefined
        ? undefined
        : new InMemoryObjectStorage({ signingKey: attachmentRefSigningKey })));
  const standardReportsProviderByTenant = new Map<string, ReportSourceProvider>();
  const standardReportsSourceProvider = process.env['DATABASE_URL']
    ? {
        forTenant: (
          tenant: TenantId,
        ): ReturnType<ReportSourceProvider['forTenant']> => {
          const key = String(tenant);
          let provider = standardReportsProviderByTenant.get(key);
          if (provider === undefined) {
            provider = reportSourceProviderOf(connectStandardReportsSources(tenant).sources);
            standardReportsProviderByTenant.set(key, provider);
          }
          return provider.forTenant(tenant);
        },
      }
    : undefined;

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

  const manufacturingStore = process.env['DATABASE_URL'] ? new PgManufacturingStore() : undefined;
  const manufacturingControl = manufacturingStore ? new ManufacturingService(manufacturingStore) : undefined;
  const manufacturingQuality = manufacturingStore && manufacturingControl ? new ManufacturingQualityService(manufacturingStore, manufacturingControl) : undefined;
  const manufacturing = manufacturingControl && manufacturingQuality ? {control: manufacturingControl, quality: manufacturingQuality, guard: new ManufacturingCommandGuard(manufacturingControl, manufacturingQuality)} : undefined;
  const app = await NestFactory.create(
    buildAppModule(enabled, {
      ...(manufacturing ? { manufacturing } : {}),
      devPolicyEndpoint,
      policyStore: businessStore?.policyStore,
      userStore: businessStore?.userStore,
      roleStore: businessStore?.roleStore,
      departmentStore: businessStore?.departmentStore,
      positionStore: businessStore?.positionStore,
      sessionStore: businessStore?.sessionStore,
      // M2 安全前置批线 A（SP-1/SP-4）：PG 形态限流存储（参数随构造）；
      // 零 DB 回落内存实例（同 sessionStore 透传先例）；口令策略恒 env 覆写形态。
      loginAttemptStore:
        businessStore?.loginAttemptStore ?? new InMemoryLoginAttemptStore(loginRateLimit),
      passwordPolicy,
      itemStore: masterdataStore?.itemStore,
      resourceStore: masterdataStore?.resourceStore,
      customerStore: masterdataStore?.customerStore,
      supplierStore: masterdataStore?.supplierStore,
      unitStore: masterdataStore?.unitStore,
      // S9 价格台账：PG 形态句柄透传（缺省内存恒空页，装配不断链）
      itemPriceLedgerStore: masterdataStore?.itemPriceLedgerStore,
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
      // SP-3（波 b）：图纸只读引用签发器——env 固化密钥构造注入（经
      // app-registry drawing 工厂透传 DrawingHttpModule.register）；未设 env
      // 不注入 = 模块随机密钥实例（重启失效设计内）。
      drawingReadReferenceSigner:
        drawingRefSigningKey === undefined
          ? undefined
          : new DrawingReadReferenceSigner({ signingKey: drawingRefSigningKey }),
      metricPackStores: metricPackStoreHandle?.stores,
      metricPackSourceSetFor,
      auditLogStore: auditStoreHandle?.logStore,
      standardReportsSourceProvider,
      // T1 能力子集三存储注入（0920 #98/99/#101/#102）
      menuConfigStore: menuConfigStoreHandle?.menuConfigStore,
      notificationStore: notificationStoreHandle?.notificationStore,
      approvalFlowConfigStore: approvalConfigStoreHandle?.flowConfigStore,
      // U6 接线波：issue 六存储 + attachment 元数据/对象存储注入
      issueTaskStore: issueStoreHandle?.taskStore,
      issueTaskLineStore: issueStoreHandle?.taskLineStore,
      issueRecordStore: issueStoreHandle?.recordStore,
      issueExpressStore: issueStoreHandle?.expressStore,
      issueOperationStore: issueStoreHandle?.operationStore,
      issueDomainEventStore: issueStoreHandle?.domainEventStore,
      aftercareClaimStore: dispatchStoreHandle?.aftercareClaimStore,
      attachmentStore: attachmentStoreHandle?.attachmentStore,
      objectStorage: attachmentObjectStorage,
      // fix-wave-6 6b-3（A14）：列显隐偏好存储注入
      columnPreferenceStore: columnPreferenceStoreHandle?.columnPreferenceStore,
      // A10 机加日统计存储注入（6a-3 裁决 1 修复项：PG 形态持久化日表）
      machiningDailyStatsStore: machiningDailyStoreHandle?.dailyStore,
      // U7 项目成本：三存储 + 六块源读面（issue 记录/清单行/工序原材料关联同源注入）
      costingProjectEntryStore: projectCostStoreHandle?.projectEntryStore,
      costingProjectSnapshotStore: projectCostStoreHandle?.projectSnapshotStore,
      costingPriceEntryStore: projectCostStoreHandle?.priceEntryStore,
      processMaterialLinkStore: listingStoreHandle?.processMaterialStore,
      workOrderStore: workOrderStoreHandle?.orderStore,
      workOrderEquipmentStore: workOrderStoreHandle?.equipmentStore,
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
      inventoryGoodsShelfStore: inventoryStoreHandle?.goodsShelfStore,
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
    // 关内建 body parser（U6 #⑥ attachment 上传 bodyLimit）：改由下方
    // useBodyParser 注册放大限额的 json/urlencoded——内建 100kb 默认会先于
    // 自定义解析器拒绝大载荷（Nest 文档体例：bodyParser:false + 重注册）。
    { bodyParser: false },
  );

  // 上传传输面护栏对齐（U6）：附件上传字节护栏 32MiB（attachment-input），base64
  // 传输膨胀 ×4/3 ≈ 43MiB + JSON 封装余量 → 45MiB 限额（业务上限仍由
  // attachment-input MAX_UPLOAD_BYTES 把关，此处只放大传输面不放大业务面）。
  // useBodyParser 是 platform-express 面方法（INestApplication 类型未声明——
  // 结构 typing 收口，不换 create 泛型）。
  const expressApp = app as NestExpressApplication;
  expressApp.useBodyParser('json', { limit: '45mb' });
  expressApp.useBodyParser('urlencoded', { extended: true, limit: '45mb' });

  // CM-1 安全响应头中间件：注册在一切会写响应的中间件之前（含下方租户解析
  // 失败直接 end 的路径），确保任何出口形态（JSON/SSE/附件字节流/4xx/500）
  // 浏览器都收到安全头——附件开门面回传任意 Content-Type 字节时 CSP/nosniff
  // 是纵深防御（上传的 SVG/HTML 内嵌脚本被 script-src 'self' 拦截）。
  app.use((_request: unknown, response: unknown, next: () => void) => {
    const res = response as { setHeader(name: string, value: string): unknown };
    for (const [name, value] of SECURITY_RESPONSE_HEADERS) {
      res.setHeader(name, value);
    }
    next();
  });

  // 域错误 -> HTTP 状态（400/401/404/409；域错误类在 application，映射在组合根）。
  // NavigationErrorFilter（UX 缺陷批）：浏览器文档导航的 401/404 中文可读呈现；
  // API 请求 Nest 默认体透传零回归（取舍与边界见该文件头）。
  app.useGlobalFilters(
    new OrgErrorFilter(),
    new AuthErrorFilter(),
    new NavigationErrorFilter(),
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
    new BackfillErrorFilter(),
    new CapabilityErrorFilter(),
    new UWaveErrorFilter(),
    new ColumnPreferenceErrorFilter(),
    new AiQueryErrorFilter(),
  );

  // 跨模块端口接线收口（M2 后第一增量）：buildAppModule 已把 store 级适配器随
  // register 注入；此处完成 service 级端口的"构造后注入"（迟到绑定回填真实
  // service 实例，见 cross-module-wiring.ts 文件头）。
  bindCrossModuleWiring(app);
  if (manufacturing) {
    if (enabled.includes('inventory')) app.get(InventoryService).bindQualityControl(manufacturing.quality);
    manufacturing.control.bindActions({execute: async (tenant, actor, module, kind, payload, id, revision) => {
      const service = module === 'listing' ? app.get(ListingService) : module === 'dispatch' ? app.get(DispatchService) : app.get(InspectionService);
      const envelope = makeCommandEnvelope({tenantId: tenant, issuedBy: UserId.create(actor),operationId: OperationId.create(`mfg-apply-${crypto.randomUUID()}`),expectedRevision: revision,issuedAt:new Date().toISOString(),command:{kind,payload}});
      return await service.execute(envelope as never,id) as unknown as Record<string,unknown>;
    }});
  }

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
    // 分叉复刻锚：apps/server/tests/tenant-resolution-status.e2e.test.ts——改此处分叉须同步复刻（低危回指，验收登记项顺手清偿）。
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
