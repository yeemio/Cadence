/**
 * 健康探针共享面单测（M4 部署期收尾波·双写去重）：
 * parseKnownTenants / probeHostFor 是 Dockerfile HEALTHCHECK、compose 继承的
 * 镜像级探针与 main.ts bootstrap 三处共用的单份逻辑——此处锚定其纯函数语义
 * （探针执行路径是镜像内进程，属容器实证面，不在 vitest）。
 */
import { describe, expect, it } from 'vitest';
import { parseKnownTenants, probeHostFor } from '../src/healthcheck-probe.js';

describe('parseKnownTenants（SMES_TENANTS 逗号清单解析）', () => {
  it('常规：逗号分隔去空白', () => {
    expect(parseKnownTenants('tenant-a, tenant-b ,tenant-c')).toEqual([
      'tenant-a',
      'tenant-b',
      'tenant-c',
    ]);
  });

  it('空值路径：undefined / 空串 / 纯空白 / 空项 → 空数组（saas 由 main.ts fail-fast 拒启）', () => {
    expect(parseKnownTenants(undefined)).toEqual([]);
    expect(parseKnownTenants('')).toEqual([]);
    expect(parseKnownTenants('  ')).toEqual([]);
    expect(parseKnownTenants(', ,')).toEqual([]);
  });

  it('保留非空余项（部分空项不吞掉有效租户）', () => {
    expect(parseKnownTenants(',tenant-a,')).toEqual(['tenant-a']);
  });
});

describe('probeHostFor（探针 Host 推导）', () => {
  it('已知租户非空：首个租户 + 基域（saas 形态——探针不落域外 Host）', () => {
    expect(probeHostFor(['tenant-a', 'tenant-b'], 'smes.example.com')).toBe(
      'tenant-a.smes.example.com',
    );
  });

  it('空清单：回落 127.0.0.1（单机形态，与既有行为相同）', () => {
    expect(probeHostFor([], 'smes.example.com')).toBe('127.0.0.1');
    expect(probeHostFor([], '')).toBe('127.0.0.1');
  });
});
