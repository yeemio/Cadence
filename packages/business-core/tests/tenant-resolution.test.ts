/**
 * 租户解析 SaaS 形状单测 + 结构兼容类型锚点（ADR-0005 M4 预研）。
 */
import { describe, expect, it } from 'vitest';
import {
  SINGLE_NODE_TENANT,
  TenantResolutionError,
  hostBasedTenantResolver,
  normalizeHost,
  resolveTenantFromHost,
  singleTenantResolver,
} from '../src/tenant/index.js';
import type { TenantId } from '../src/ids.js';

// ---- 结构兼容类型锚点（编译期，零运行时） ----
// 镜像 application/src/core/tenant-context.ts 的
//   `export type TenantResolver = (request: unknown) => TenantId;`
// core 不 import application（依赖方向反向即循环，depcruise core-no-internal-deps
// 也禁止）。本文件以局部镜像形状断言两个 resolver 工厂产物可赋值给它，
// 即 TenantContext.useResolver(resolver) 可直接接收——结构兼容不靠转述。
type TenantResolverShape = (request: unknown) => TenantId;
const _singleFitsShape: TenantResolverShape = singleTenantResolver();
const _hostBasedFitsShape: TenantResolverShape = hostBasedTenantResolver({ domain: 'smes.example.com', lookup: () => ['acme'] });
void _singleFitsShape;
void _hostBasedFitsShape;

describe('normalizeHost：大小写 / 端口 / 尾点', () => {
  it('小写化 + 剥端口 + 去尾点', () => {
    expect(normalizeHost('  ACME.smes.Example.com:3000 ')).toBe('acme.smes.example.com');
    expect(normalizeHost('acme.smes.example.com.')).toBe('acme.smes.example.com');
    expect(normalizeHost('acme.smes.example.com:443')).toBe('acme.smes.example.com');
  });

  it('IPv6 字面量不剥端口（多冒号原样保留，随后的匹配失败关闭）', () => {
    expect(normalizeHost('[::1]:8080')).toBe('[::1]:8080');
  });
});

describe('resolveTenantFromHost：子域 → 租户（域名无关版）', () => {
  const known = ['acme', 'beta-co'];

  it('首标签命中已知租户（大小写 / 端口不敏感）', () => {
    expect(resolveTenantFromHost('acme.smes.example.com', known)).toBe('acme' as TenantId);
    expect(resolveTenantFromHost('ACME.smes.example.com:3000', known)).toBe('acme' as TenantId);
    expect(resolveTenantFromHost('beta-co.other.example.com', known)).toBe('beta-co' as TenantId);
  });

  it('未知租户 fail-closed 抛错', () => {
    expect(() => resolveTenantFromHost('ghost.smes.example.com', known)).toThrow(TenantResolutionError);
  });

  it('空 host / 无子域标签抛错', () => {
    expect(() => resolveTenantFromHost('', known)).toThrow(TenantResolutionError);
    expect(() => resolveTenantFromHost('.example.com', known)).toThrow(TenantResolutionError);
  });

  it('Set 与数组清单等价；清单项大写也能命中（双侧小写化）', () => {
    expect(resolveTenantFromHost('acme.example.com', new Set(['ACME']))).toBe('acme' as TenantId);
  });

  it('清单含空串/非字符串抛错（防静默脏清单）', () => {
    expect(() => resolveTenantFromHost('acme.example.com', [''])).toThrow(TenantResolutionError);
  });
});

describe('singleTenantResolver：单机形态恒等', () => {
  it('任意请求（含 undefined / 对象）恒返回固定默认租户', () => {
    const resolver = singleTenantResolver();
    expect(resolver(undefined)).toBe(SINGLE_NODE_TENANT as TenantId);
    expect(resolver({ headers: { host: 'anything.example.com' } })).toBe(SINGLE_NODE_TENANT as TenantId);
    expect(SINGLE_NODE_TENANT).toBe('default'); // 镜像 application DEFAULT_TENANT_ID
  });
});

describe('hostBasedTenantResolver：SaaS 形态（基础域严格后缀匹配）', () => {
  const resolver = hostBasedTenantResolver({ domain: 'Smes.Example.com', lookup: () => ['acme', 'beta-co'] });
  const request = (host: string) => ({ headers: { Host: host } });

  it('子域命中：headers.host 大小写不敏感、剥端口', () => {
    expect(resolver(request('acme.smes.example.com'))).toBe('acme' as TenantId);
    expect(resolver(request('ACME.smes.example.com:443'))).toBe('acme' as TenantId);
  });

  it('字符串请求也接受（测试便利形状）', () => {
    expect(resolver('beta-co.smes.example.com')).toBe('beta-co' as TenantId);
  });

  it('域外 host fail-closed（同名租户在别的域不算数）', () => {
    expect(() => resolver(request('acme.evil.example.com'))).toThrow(TenantResolutionError);
    expect(() => resolver(request('smes.example.com'))).toThrow(TenantResolutionError); // 裸基础域无子域
  });

  it('多级子域拒绝（M4 预研口径：仅单标签租户）', () => {
    expect(() => resolver(request('a.b.smes.example.com'))).toThrow(TenantResolutionError);
  });

  it('未知租户 / 缺 Host fail-closed', () => {
    expect(() => resolver(request('ghost.smes.example.com'))).toThrow(TenantResolutionError);
    expect(() => resolver({ headers: {} })).toThrow(TenantResolutionError);
    expect(() => resolver(42)).toThrow(TenantResolutionError);
  });

  it('空 domain 构造即抛错（工厂级防线）', () => {
    expect(() => hostBasedTenantResolver({ domain: '  ', lookup: () => [] })).toThrow(TenantResolutionError);
  });
});
