/**
 * 外协计价测试：纯函数（单价解析/整数取价 half-up/选规）+ 端口（dispatch 实时取价）
 * + 版本化（规则修订后取价随之换代）。对账锚点：price = unit × (1 + margin)。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BaselineInputError, BaselineNotFoundError } from '../../src/baseline/baseline-errors.js';
import { BASELINE_COMMAND_KINDS } from '../../src/baseline/baseline-input.js';
import {
  computeOutsourcingPriceMinor,
  decimalToMinor,
  minorToDecimal,
  pickActiveRuleForProcess,
} from '../../src/baseline/outsourcing-price.js';
import { committedEvents, envelope, newService, t1 } from './helpers.js';

describe('计价纯函数', () => {
  it('decimalToMinor：合法金额串 → 分；非法形状/取值拒绝', () => {
    expect(decimalToMinor('12.50', 'unitPrice')).toBe(1250);
    expect(decimalToMinor('12.5', 'unitPrice')).toBe(1250);
    expect(decimalToMinor('9999999.99', 'unitPrice')).toBe(999999999); // 量纲上界（分）恰好允许
    expect(() => decimalToMinor('10000000.01', 'unitPrice')).toThrow(BaselineInputError); // 越上界拒绝
    expect(() => decimalToMinor('12.505', 'unitPrice')).toThrow(BaselineInputError); // 高于分拒绝
    expect(() => decimalToMinor('-1', 'unitPrice')).toThrow(BaselineInputError);
    expect(() => decimalToMinor('0', 'unitPrice')).toThrow(BaselineInputError); // 单价须为正
    expect(() => decimalToMinor('abc', 'unitPrice')).toThrow(BaselineInputError);
  });

  it('minorToDecimal：分 → 十进制串（纯整数换算）', () => {
    expect(minorToDecimal(1438)).toBe('14.38');
    expect(minorToDecimal(5)).toBe('0.05');
    expect(minorToDecimal(100)).toBe('1.00');
  });

  it('取价 = 单价 × (1+利润率)，half-up 到分（整数精确）', () => {
    expect(computeOutsourcingPriceMinor(1250, 1500)).toBe(1438); // 14.375 → 14.38
    expect(computeOutsourcingPriceMinor(1250, 500)).toBe(1313); // 13.125 → 13.13
    expect(computeOutsourcingPriceMinor(100, 0)).toBe(100); // 零利润率
    expect(computeOutsourcingPriceMinor(1, 5000)).toBe(2); // 0.015 元 → 0.02（半位向上）
    expect(() => computeOutsourcingPriceMinor(0, 100)).toThrow(BaselineInputError);
    expect(() => computeOutsourcingPriceMinor(1250, -1)).toThrow(BaselineInputError);
  });
});

describe('外协计价规则命令与取价端口', () => {
  it('set/revise 命令 + resolve 实时取价（修订后取价换代）', async () => {
    const service = newService();
    const set = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-01', processCode: 'OP-10', unitPrice: '10.00', marginPermyriad: 0 }),
    );
    expect(set).toMatchObject({ status: 'committed', newRevision: 1 });
    expect(await service.resolve(t1, 'OP-10')).toMatchObject({
      ruleCode: 'OPR-01',
      unitPriceMinor: 1000,
      marginPermyriad: 0,
      priceMinor: 1000,
      price: '10.00',
    });

    await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleRevise, { code: 'OPR-01', unitPrice: '12.50', marginPermyriad: 1500 }, { expectedRevision: 1 }),
    );
    expect(await service.resolve(t1, 'OP-10')).toMatchObject({
      unitPriceMinor: 1250,
      marginPermyriad: 1500,
      priceMinor: 1438,
      price: '14.38', // 12.50 × 1.15
    });
  });

  it('resolve 只认 active 当前版：draft 规则、superseded 规则、未知工序 → 404', async () => {
    const service = newService();
    await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-D1', processCode: 'OP-20', unitPrice: '5.00', marginPermyriad: 100, status: 'draft' }),
    );
    await expect(service.resolve(t1, 'OP-20')).rejects.toThrow(BaselineNotFoundError);

    await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-A', processCode: 'OP-30', unitPrice: '8.00', marginPermyriad: 1000 }),
    );
    await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleRevise, { code: 'OPR-A', status: 'draft' }, { expectedRevision: 1 }),
    );
    await expect(service.resolve(t1, 'OP-30')).rejects.toThrow(BaselineNotFoundError); // 最新版转 draft 后无生效规则
    await expect(service.resolve(t1, 'OP-40')).rejects.toThrow(BaselineNotFoundError);
  });

  it('同工序多条 active 规则：确定性选版本号最大者', async () => {
    const service = newService();
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-B1', processCode: 'OP-50', unitPrice: '1.00', marginPermyriad: 0 }));
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-B2', processCode: 'OP-50', unitPrice: '2.00', marginPermyriad: 0 }));
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.outsourcingRuleRevise, { code: 'OPR-B1', unitPrice: '9.00' }, { expectedRevision: 1 }));
    expect(await service.resolve(t1, 'OP-50')).toMatchObject({ ruleCode: 'OPR-B1', price: '9.00' }); // v2 > v1
  });

  it('选规纯函数：零依赖直测（无 store）', () => {
    const rules = [
      { id: 'a', code: 'R1', processCode: 'P', unitPriceMinor: 100, marginPermyriad: 0, objectVersion: 2, supersedes: 'old', status: 'active' as const },
      { id: 'b', code: 'R2', processCode: 'P', unitPriceMinor: 200, marginPermyriad: 0, objectVersion: 1, supersedes: null, status: 'active' as const },
      { id: 'old', code: 'R1', processCode: 'P', unitPriceMinor: 50, marginPermyriad: 0, objectVersion: 1, supersedes: null, status: 'active' as const },
    ];
    const picked = pickActiveRuleForProcess(rules, 'P', (entry, chain) => chain.some((row) => row.supersedes === entry.id));
    expect(picked).toMatchObject({ code: 'R1', objectVersion: 2 }); // superseded 的 v1 不参与
    expect(pickActiveRuleForProcess(rules, 'X', (entry, chain) => chain.some((row) => row.supersedes === entry.id))).toBeNull();
  });

  it('载荷校验：unitPrice 非串 / 利润率越界 / 缺 processCode 拒绝', async () => {
    const service = newService();
    const badPrice = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-X', processCode: 'OP-10', unitPrice: 12.5, marginPermyriad: 100 }),
    );
    expect(badPrice).toMatchObject({ status: 'rejected' });
    const badMargin = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-X', processCode: 'OP-10', unitPrice: '12.50', marginPermyriad: 999999 }),
    );
    expect(badMargin).toMatchObject({ status: 'rejected' });
    const missing = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.outsourcingRuleSet, { code: 'OPR-X', unitPrice: '12.50', marginPermyriad: 100 }),
    );
    expect(missing).toMatchObject({ status: 'rejected' });
  });
});
