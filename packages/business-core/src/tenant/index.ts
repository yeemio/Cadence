/**
 * 租户解析出口（ADR-0005 M4 预研）。
 *
 * 出口取舍：未挂进包根 index.ts / package.json exports——本预研在 core 宪法域
 * 只加新文件；application 侧接线（core.module useResolver）是 M4 正式线，
 * 届时在包出口补一行即可。
 */
export {
  SINGLE_NODE_TENANT,
  TenantResolutionError,
  normalizeHost,
  extractHostFromRequest,
  resolveTenantFromHost,
  singleTenantResolver,
  hostBasedTenantResolver,
} from './tenant-resolution.js';
export type { HostBasedTenantResolverOptions, TenantResolutionReason } from './tenant-resolution.js';
