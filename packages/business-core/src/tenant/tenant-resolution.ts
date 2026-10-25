/**
 * 租户解析 SaaS 形状（ADR-0005 双形态多租户：M4 预研）。
 *
 * 纯函数 + 零依赖（core 宪法域：不 import 任何仓内其他包）。与
 * application/src/core/tenant-context.ts 的 TenantResolver
 * `(request: unknown) => TenantId` 结构兼容——本文件不 import application
 * （依赖方向 application -> core，反向即循环；结构兼容由
 * tests/tenant-resolution.test.ts 的类型锚点守恒）。
 *
 * 形态分工（ADR-0005）：
 *   单机买断 = singleTenantResolver()：恒固定默认租户，零可感知开销
 *   （对齐 application 的 fixedDefaultTenant / DEFAULT_TENANT_ID='default'）。
 *   SaaS 订阅 = hostBasedTenantResolver({domain, lookup})：子域名 → 租户，
 *   未知租户 fail-closed 抛错（SaaS 形态没有回落默认租户——回落即串租户）。
 *
 * 同步取舍（写明）：lookup 是同步 () => 租户清单。异步查库解析
 * （TenantResolver 接口本身是同步的）是 M4 正式线 adapter 的职责：
 * 进程内租户缓存 + 启动预热，core 不引入 Promise 形状。
 */
import { TenantId } from '../ids.js';

/** 单机形态固定默认租户标识。镜像 application 的 DEFAULT_TENANT_ID（= 'default'）。 */
export const SINGLE_NODE_TENANT = 'default';

/**
 * 租户解析失败原因（结构化，供 HTTP 层映射状态码，不靠 message 文本匹配）：
 * - 'missing-host'：请求不携带 Host（HTTP/1.1 必有，HTTP/2 :authority 丢失等）
 * - 'off-domain'：Host 在 SaaS 基础域之外（连错了服务——421 语义）
 * - 'invalid-subdomain'：裸基础域 / 多级子域 / 无子域标签
 * - 'unknown-tenant'：域内但租户不在已知清单（404 语义）
 * - 'invalid-entry' / 'invalid-config'：清单或配置自身非法（构造期 fail-fast 路径）
 */
export type TenantResolutionReason =
  | 'missing-host'
  | 'off-domain'
  | 'invalid-subdomain'
  | 'unknown-tenant'
  | 'invalid-entry'
  | 'invalid-config';

/** 租户解析失败（未知租户 / 缺 Host）——SaaS 形态 fail-closed，不回落默认租户。 */
export class TenantResolutionError extends Error {
  /** 结构化失败原因（HTTP 状态码映射依据，见类型注释）。 */
  readonly reason: TenantResolutionReason;
  constructor(message: string, reason: TenantResolutionReason) {
    super(message);
    this.name = 'TenantResolutionError';
    this.reason = reason;
  }
}

/** 规整 Host：去空白、小写、剥端口、去尾点（FQDN 尾点）。IPv6 字面量不支持（含多冒号 → 原样返回，随后续匹配失败关闭）。 */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  // 仅当形如 name:port（单冒号且非 [IPv6] 字面量）时剥端口
  const colonCount = trimmed.split(':').length - 1;
  if (colonCount === 1 && !trimmed.startsWith('[')) {
    return trimmed.replace(/:\d+$/, '');
  }
  return trimmed;
}

/** 从请求对象提取 Host：字符串请求 → 自身；带 headers.host（大小写不敏感）→ 头值；否则 null。 */
export function extractHostFromRequest(request: unknown): string | null {
  if (typeof request === 'string') return request;
  if (request !== null && typeof request === 'object') {
    const headers = (request as { headers?: unknown }).headers;
    if (headers !== null && typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === 'host' && typeof value === 'string') return value;
      }
    }
  }
  return null;
}

function toLowerSet(tenants: readonly string[] | ReadonlySet<string>): Set<string> {
  return new Set(
    [...tenants].map((tenant) => {
      if (typeof tenant !== 'string' || tenant.length === 0) {
        throw new TenantResolutionError(`invalid known tenant entry: ${String(tenant)}`, 'invalid-entry');
      }
      return tenant.toLowerCase();
    }),
  );
}

/**
 * 子域名 → 租户标识（域名无关版）：Host 首标签命中已知租户即该租户。
 * 不匹配 / 空 Host / 非字符串 → TenantResolutionError（fail-closed）。
 * 大小写不敏感、剥端口（'ACME.Example.com:3000' 首标签 'acme'）。
 */
export function resolveTenantFromHost(host: string, knownTenants: readonly string[] | ReadonlySet<string>): TenantId {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) throw new TenantResolutionError(`empty host: ${JSON.stringify(host)}`, 'missing-host');
  const firstLabel = normalized.split('.')[0]!;
  if (!firstLabel) throw new TenantResolutionError(`host has no subdomain label: ${JSON.stringify(host)}`, 'invalid-subdomain');
  if (!toLowerSet(knownTenants).has(firstLabel)) {
    throw new TenantResolutionError(`unknown tenant "${firstLabel}" (host=${JSON.stringify(host)})`, 'unknown-tenant');
  }
  return TenantId.create(firstLabel);
}

/**
 * 单机形态解析器：恒 'default'，与请求无关。
 * 结构兼容 application TenantResolver（(request: unknown) => TenantId）。
 */
export function singleTenantResolver(): (request: unknown) => TenantId {
  return () => TenantId.create(SINGLE_NODE_TENANT);
}

export interface HostBasedTenantResolverOptions {
  /** SaaS 基础域（如 'smes.example.com'），子域名 = 租户标识 */
  domain: string;
  /** 已知租户清单（同步；缓存/预热是 M4 正式线 adapter 职责） */
  lookup: () => readonly string[] | ReadonlySet<string>;
}

/**
 * SaaS 形态解析器工厂：`{tenant}.{domain}` → 租户。
 * 取舍：必须后缀匹配基础域（比首标签匹配更严，防同域外的同名租户）；
 * 缺 Host / 域外 Host / 未知子域 / 多级子域（含点）→ TenantResolutionError。
 * 结构兼容 application TenantResolver——useResolver(resolver) 可直接接收。
 */
export function hostBasedTenantResolver(options: HostBasedTenantResolverOptions): (request: unknown) => TenantId {
  const domain = normalizeHost(options.domain);
  if (domain.length === 0) throw new TenantResolutionError('empty domain', 'invalid-config');
  return (request: unknown): TenantId => {
    const rawHost = extractHostFromRequest(request);
    if (rawHost === null) throw new TenantResolutionError('request carries no host (string or headers.host)', 'missing-host');
    const host = normalizeHost(rawHost);
    if (host.length === 0) throw new TenantResolutionError(`empty host: ${JSON.stringify(rawHost)}`, 'missing-host');
    if (!host.endsWith(`.${domain}`)) {
      throw new TenantResolutionError(`host ${JSON.stringify(host)} outside domain ${JSON.stringify(domain)}`, 'off-domain');
    }
    const label = host.slice(0, -domain.length - 1);
    if (label.length === 0 || label.includes('.')) {
      throw new TenantResolutionError(`host ${JSON.stringify(host)} is not a single subdomain of ${JSON.stringify(domain)}`, 'invalid-subdomain');
    }
    if (!toLowerSet(options.lookup()).has(label)) {
      throw new TenantResolutionError(`unknown tenant "${label}" (host=${JSON.stringify(host)})`, 'unknown-tenant');
    }
    return TenantId.create(label);
  };
}
