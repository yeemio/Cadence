/**
 * D-8 transaction propagation for existing PG adapters.
 * With no outer business transaction, session=off delegates directly to Prisma;
 * session=on keeps one SET LOCAL + transaction per operation. A controlled command
 * can open a tenant transaction: model/raw operations from every wrapped adapter
 * then use that exact connection, including nested interactive transactions.
 * Cross-tenant reuse throws. The caller decides which commands acquire a lock;
 * this adapter never serializes all project reads or writes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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
  readonly query?: (args: unknown) => Promise<unknown>;
}

/**
 * 底层客户端 `$transaction` 的最小结构面（交互式 / 数组两种形态）。
 * 真实 PrismaClient 为其超集；交互式回调入参为无扩展链的底层 tx 句柄。
 */
interface RlsSessionBaseTransaction {
  $transaction(
    fn: (tx: RlsSessionTx & Record<string, unknown>) => Promise<unknown>,
    options?: unknown,
  ): Promise<unknown>;
  $transaction(promises: readonly unknown[], options?: unknown): Promise<unknown>;
}

/** 被接管的交互式事务句柄登记项（rlsTxStorage 的 store 形状）。 */
interface RlsSessionTxScope {
  readonly tx: RlsSessionTx & Record<string, unknown>;
  readonly tenant: string;
  failed?: unknown;
}

/**
 * 当前交互式事务句柄（模块级 ALS；与 tenantSessionContext 同为实例私有——
 * 本模块单例自持，钩子与 $transaction 接管在同模块内读写，无跨实例可见性需求）。
 */
const rlsTxStorage = new AsyncLocalStorage<RlsSessionTxScope>();

/** 在指定事务句柄上做事务级 SET（true：随 COMMIT/ROLLBACK 自动还原，池化连接零租户残留）。 */
async function setTenantOn(tx: RlsSessionTx, tenant: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config(${TENANT_SESSION_VAR}, ${tenant}, true)`;
}

/**
 * 在交互式事务句柄上做事务级租户 SET——裸 raw 写路径的复用入口（D-14 收口）：
 * raw 不经 $allOperations 钩子（头注"已知边界"），raw 写用法的固定形态 =
 * `$transaction(async (tx) => { await setRlsTenantOn(tx); return tx.$executeRaw\`…\`; })`
 * ——SET 与 raw 落同一事务连接，RLS WITH CHECK 放行。事务级 true 随
 * COMMIT/ROLLBACK 还原，池化连接零残留；经接管的 $transaction 进入时与接管层
 * SET 幂等重设（同租户同值，无语义差），未接管（缺省/superuser 形态）时 SET
 * 亦无害。
 */
export async function setRlsTenantOn(tx: RlsSessionTx): Promise<void> {
  await setTenantOn(tx, String(currentRlsTenant()));
}

/** 在指定 tx 句柄上重派模型操作（不经扩展链——不递归、不再嵌套）。 */
function redispatchOn(
  tx: RlsSessionTx & Record<string, unknown>,
  params: RlsSessionOperationParams,
): Promise<unknown> {
  const delegateName = params.model.charAt(0).toLowerCase() + params.model.slice(1);
  const delegate = tx[delegateName] as Record<string, ((a: unknown) => Promise<unknown>) | undefined>;
  const operation = delegate[params.operation];
  if (typeof operation !== 'function') {
    throw new Error(`rls session: tx delegate missing ${params.model}.${params.operation}`);
  }
  return operation(params.args);
}

/** $allOperations 钩子（导出供单测直接驱动；签名与官方扩展协议一致）。 */
export async function rlsSessionOperation(
  tx: RlsSessionTx & Record<string, unknown>,
  params: RlsSessionOperationParams,
): Promise<unknown> {
  await setTenantOn(tx, String(currentRlsTenant()));
  return redispatchOn(tx, params);
}

/** Model and raw calls join an active tenant transaction. Outside it, raw calls
 * preserve Prisma's original semantics (callers needing RLS use an explicit tx).
 * Native array transactions outside a scope retain the previous documented limit;
 * project adapters use interactive transactions. Nested errors must propagate to
 * the owning command so it can roll back projections, events and outbox together.
 */
export function withRlsTenantSession(prisma: PrismaClient, options: { readonly session?: boolean } = {}): PrismaClient {
  const sessionEnabled = options.session ?? true;
  function scopeNow() {
    const scope = rlsTxStorage.getStore();
    if (scope && scope.tenant !== String(currentRlsTenant())) throw new Error('跨租户不能沿用业务事务连接');
    return scope;
  }
  function raw(method: string, args: unknown[]) {
    const target = (scopeNow()?.tx ?? prisma) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return Reflect.apply(target[method]!, target, args);
  }
  const client = prisma as unknown as RlsSessionBaseTransaction;
  const extended = prisma.$extends({
    name: 'rlsTenantSession',
    query: {
      $allModels: {
        async $allOperations(params: RlsSessionOperationParams): Promise<unknown> {
          const scope = scopeNow();
          if (scope !== undefined) {
            // 被接管的交互式事务内：同句柄重派（事务级 SET 已在回调前完成），
            // 不再新开事务——外层事务原子性由此成立（D-8 修复核心）。
            return redispatchOn(scope.tx, params);
          }
          if (!sessionEnabled) return params.query!(params.args);
          return client.$transaction((tx) => rlsSessionOperation(tx, params));
        },
      },
    },
    client: {
      $queryRaw: (...args: unknown[]) => raw('$queryRaw', args),
      $executeRaw: (...args: unknown[]) => raw('$executeRaw', args),
      $queryRawUnsafe: (...args: unknown[]) => raw('$queryRawUnsafe', args),
      $executeRawUnsafe: (...args: unknown[]) => raw('$executeRawUnsafe', args),
      // $transaction 接管（client 组件属性在扩展客户端上直接遮蔽内建实现；
      // 6.19 运行时 br/Er 属性层序与类型层均已核实支持）。数组形态不接管
      // （边界见头注）。
      $transaction: (
        arg:
          | ((tx: RlsSessionTx & Record<string, unknown>) => Promise<unknown>)
          | readonly unknown[],
        options?: unknown,
      ): Promise<unknown> => {
        const active = scopeNow();
        if (active) return Promise.resolve().then(() => typeof arg === 'function' ? arg(active.tx) : Promise.all(arg)).catch(error => { active.failed ??= error; throw error; });
        if (typeof arg !== 'function') {
          return client.$transaction(arg, options);
        }
        return client.$transaction(async (tx) => {
          if (sessionEnabled) await setTenantOn(tx, String(currentRlsTenant()));
          const scope: RlsSessionTxScope = { tx, tenant: String(currentRlsTenant()) };
          return rlsTxStorage.run(scope, async () => { const result = await arg(tx); if (scope.failed) throw scope.failed; return result; });
        }, options);
      },
    },
  });
  return extended as unknown as PrismaClient;
}
