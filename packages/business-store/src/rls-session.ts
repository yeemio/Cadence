/**
 * RLS session 变量接线（ADR-0005 M4 正式线：租户贯通到数据库连接）。
 *
 * 物理位置（M4 正式线定案）：src/ 包顶层——本模块是跨环节通用基础设施
 * （ADR-0010 词汇：领域中立，不绑定单一环节域），非 org 域私有；M4 收尾波
 * （ESCALATION-2）起由**全部 18 个 connect\* 连接工厂**共用（先例四家
 * org / masterdata / workbench / approval + 其余十四家各领域 pg-*-stores）；
 * ./org 子路径经 re-export 保持公共 API 不变（消费方零改动）。
 *
 * 机制（官方 API，零新运行时依赖）：
 *   `PrismaClient.$extends({ query: { $allModels: { $allOperations } } })`——
 *   每个模型操作被包进一个交互式事务：先在同一连接上
 *   `SELECT set_config('app.current_tenant', <tenant>, true)`（事务级），再在
 *   **同一 tx 句柄**上重派原操作。对现有各 PgXxxStore 零改动：工厂返回的扩展
 *   客户端仍是 PrismaClient 形状（模型委托面不变），store 构造函数原样接收。
 *
 * set_config 第三参取舍（true = 事务级，写明）：
 *   - true：SET 随事务结束自动还原——连接归还池后不携带任何租户痕迹。池化连接
 *     被下一个（可能不同租户的）请求复用时不会串租户，这是安全正确性的前提。
 *   - false（会话级，不取）：理论上"每连接一次 SET"更省（deploy/README 单机形态
 *     曾按此口径描述），但 Prisma 官方 API 无"连接建立钩子"，无法保证 SET 与后续
 *     查询落在同一池化连接上；会话级 SET + 连接复用 = 陈旧租户跨请求泄漏。故本
 *     接线恒用事务级，代价 = 每次存储操作多一个交互式事务（BEGIN/SET/COMMIT，
 *     本地 socket 上三段小往返，见 deploy/README 性能口径）。
 *
 * 租户来源（取舍，写明）：
 *   本模块自持一个 `TenantContext`（@smes/application 的 ALS 基座，import 方式与
 *   pg-org-stores 现有依赖一致；store→application 为 dep-cruiser 允许边）。
 *   `current()` 在无 ALS store 时回落固定默认租户 'default'——
 *   - 单机形态（唯一在用 app_user 的已发布形态）：恒 'default' 即恒正确
 *     （与 server 侧 fixedDefaultTenant 解析结果一致）；
 *   - server 中间件的 TenantContext 是 Nest DI 实例，其 ALS 为实例私有——
 *     AsyncLocalStorage 跨实例不可见（Node 语义，已实测），store 侧无法读到
 *     server 侧 run() 进入的请求租户。**SaaS 形态的桥接已接线（M4 正式线，
 *     实际形态）**：apps/server/src/main.ts 租户中间件在 saas 形态把每请求解析
 *     出的租户经下方 `runWithRlsTenant` 包进下游处理链（与 server 侧
 *     tenantContext.run 复合同点）——钩子事务内 SET 读到的即请求租户。
 *     后台任务/种子脚本不经 HTTP 中间件，仍需显式用 runWithRlsTenant 包裹。
 *   无租户上下文时（启动期/队列任务）的行为：不"跳过 SET"（合同建议项），
 *   而是按 TenantContext 公开 API 语义回落 'default'——application 的
 *   TenantContext 公开面无"区分有无 ALS store"的入口（current() 恒有值），
 *   不触碰其私有字段。安全论证：app_user 形态下后台查询落 'default' 是
 *   fail-visible 而非泄漏——其他租户行读 0 行、写被 WITH CHECK 拒（RLS 谓词
 *   收口），最坏是"该查询看不到数据"的功能性失败，不构成跨租户越权；
 *   superuser 形态下 SET 与否均无影响（superuser 恒绕过 RLS）。
 *
 * 门控（取舍，写明）：SMES_RLS_SESSION=on 才启用扩展，缺省不启用——
 *   superuser 连接（全部既有 e2e / 本地开发）上 SET 是纯开销且语义空转
 *   （superuser 绕过 RLS），缺省关闭保证既有测试与 e2e 零行为变化；
 *   app_user 部署（deploy/compose）显式开启。
 */
import type { PrismaClient } from '@prisma/client';
import { TenantContext } from '@smes/application';
import type { TenantId } from '@smes/business-core';

/** RLS 谓词消费的会话变量名（与 prisma/migrations rls_tenant_isolation 一致）。 */
export const TENANT_SESSION_VAR = 'app.current_tenant';

/** 门控环境变量名。 */
export const SMES_RLS_SESSION_ENV = 'SMES_RLS_SESSION';

/** store 侧租户会话上下文（模块单例；server 请求级租户接入点见文件头取舍）。 */
const tenantSessionContext = new TenantContext();

/**
 * 当前 RLS 租户：ALS store 优先，无 store（启动期/队列任务）回落固定默认租户。
 * 返回 application 的 TenantContext 语义（'default' 恒可用）。
 */
export function currentRlsTenant(): TenantId {
  return tenantSessionContext.current();
}

/**
 * 在指定租户上下文内执行（ALS run）。后台任务/种子脚本/测试的显式租户入口：
 * SaaS 形态的队列任务必须经此包裹，否则按回落规则落 'default'（fail-visible）。
 */
export function runWithRlsTenant<T>(tenant: TenantId, fn: () => T): T {
  return tenantSessionContext.run(tenant, fn);
}

/** 读门控：SMES_RLS_SESSION === 'on'。 */
export function rlsSessionEnabled(
  env: { readonly [key: string]: string | undefined } = process.env,
): boolean {
  return env[SMES_RLS_SESSION_ENV] === 'on';
}

/** 事务句柄的最小结构面（实现与单测共用；真实 tx 为其超集）。 */
export interface RlsSessionTx {
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** $allOperations 钩子入参的最小结构面（官方扩展协议形状）。 */
export interface RlsSessionOperationParams {
  readonly model: string;
  readonly operation: string;
  readonly args: unknown;
}

/** $allOperations 钩子（导出供单测直接驱动；签名与官方扩展协议一致）。 */
export async function rlsSessionOperation(
  tx: RlsSessionTx & Record<string, unknown>,
  params: RlsSessionOperationParams,
): Promise<unknown> {
  const tenant = String(currentRlsTenant());
  await tx.$queryRaw`SELECT set_config(${TENANT_SESSION_VAR}, ${tenant}, true)`;
  const delegate = tx[params.model] as Record<string, ((a: unknown) => Promise<unknown>) | undefined>;
  const operation = delegate[params.operation];
  if (typeof operation !== 'function') {
    throw new Error(`rls session: tx delegate missing ${params.model}.${params.operation}`);
  }
  return operation(params.args);
}

/**
 * 给 PrismaClient 装 RLS session 接线扩展。
 *
 * 每个模型操作 → 交互式事务 { SET app.current_tenant; 原操作 }；原操作在 tx
 * 句柄上重派（不经扩展链——不递归、不再嵌套）。返回值仍是 PrismaClient 形状
 * （$extends 结果为超集，向下转型安全：store 只消费标准模型委托面）。
 *
 * 已知边界（写明；M4 收尾波 14 工厂接线时经容器实验实证标定）：
 *   - **raw 入口不经钩子**：`$queryRaw` / `$executeRaw` 等 client 级入口不被
 *     模型操作钩子拦截——无 SET。app_user 形态下读 0 行（fail-visible）、写被
 *     RLS 拒（42501）。inventory 三处 $executeRaw 即此边界。
 *   - **事务原子性丢失（=on 时）**：数组/交互式 `$transaction` 内的模型操作仍
 *     被本钩子拦截，但被重派进钩子自开的新交互式事务——外层事务原子性不成立。
 *     实验实证（app_user+RLS 容器）：交互式事务内 create 后抛错，该行已独立
 *     提交未回滚；数组事务第二操作失败，第一操作已落库。接线前（无 SET）这些
 *     操作在 app_user 形态下整个事务全拒——接线是净改善，但"失败整批回滚"的
 *     语义在 =on 时变为"每操作独立提交"，涉事务操作失败可能留部分状态。
 *     superuser 形态开 =on 同样丢原子性——门控只应在 app_user+RLS 形态开启。
 *   - org / masterdata / workbench / approval 四域 store 全部为普通模型操作
 *     （已核对，无上述边界）；其余 14 域存在 $transaction / $executeRaw 用法
 *     （诚实缺口登记：后续波可评估"事务感知扩展"——数组事务前splice set_config
 *     原语、交互式事务句柄上先 SET 同句柄重派——届时以容器实验复证原子性恢复）。
 */
export function withRlsTenantSession(prisma: PrismaClient): PrismaClient {
  const client = prisma as unknown as {
    $transaction(fn: (tx: RlsSessionTx & Record<string, unknown>) => Promise<unknown>): Promise<unknown>;
  };
  const extended = prisma.$extends({
    name: 'rlsTenantSession',
    query: {
      $allModels: {
        async $allOperations(params: RlsSessionOperationParams): Promise<unknown> {
          return client.$transaction((tx) => rlsSessionOperation(tx, params));
        },
      },
    },
  });
  return extended as unknown as PrismaClient;
}
