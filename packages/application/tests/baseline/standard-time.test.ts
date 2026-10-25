/**
 * 额定工时（StandardTimeId，P3）行为测试：standardtime.define 版本化落账、
 * hours 对标端口（resolveStandardTime：active 当前版命中 / 404 语义）、查询过滤。
 */
import { describe, expect, it } from 'vitest';
import { BaselineNotFoundError } from '../../src/baseline/baseline-errors.js';
import { BASELINE_COMMAND_KINDS } from '../../src/baseline/baseline-input.js';
import { BASELINE_EVENT_TYPES } from '../../src/baseline/baseline-events.js';
import { committedEvents, envelope, newService, t1 } from './helpers.js';

const defineStandardTime = (payload: Record<string, unknown>) =>
  envelope(BASELINE_COMMAND_KINDS.standardtimeDefine, payload);

describe('standardtime.define（版本化主数据）', () => {
  it('按工序定义落账 v1 active；事件 standard-time-defined(action=define)', async () => {
    const service = newService();
    const outcome = await service.execute(
      t1,
      defineStandardTime({ code: 'ST-100', scope: 'process', targetCode: 'OP-10', standardSeconds: 720, preparationSeconds: 900 }),
    );
    expect(outcome.status).toBe('committed');
    const event = committedEvents(outcome)[0]!;
    expect(event.eventType).toBe(BASELINE_EVENT_TYPES.standardTimeDefined);
    expect(event.payload).toMatchObject({ action: 'define', code: 'ST-100', objectVersion: 1 });

    const detail = await service.getStandardTime(t1, 'ST-100');
    expect(detail.current).toMatchObject({
      scope: 'process',
      targetCode: 'OP-10',
      standardSeconds: 720,
      preparationSeconds: 900,
      status: 'active',
    });
  });

  it('按产品维度（图号）定义合法；preparationSeconds 缺省 0', async () => {
    const service = newService();
    const outcome = await service.execute(
      t1,
      defineStandardTime({ code: 'ST-200', scope: 'product', targetCode: 'DW-9001', standardSeconds: 3600 }),
    );
    expect(outcome.status).toBe('committed');
    const detail = await service.getStandardTime(t1, 'ST-200');
    expect(detail.current).toMatchObject({ scope: 'product', targetCode: 'DW-9001', preparationSeconds: 0 });
  });

  it('载荷守门：scope 白名单 / 秒整数取值域 / 重复定义 → rejected', async () => {
    const service = newService();
    const badScope = await service.execute(
      t1,
      defineStandardTime({ code: 'ST-300', scope: 'equipment', targetCode: 'EQ-1', standardSeconds: 60 }),
    );
    expect(badScope).toMatchObject({ status: 'rejected' });
    expect((badScope as { reason: string }).reason).toContain('scope');

    const fractional = await service.execute(
      t1,
      defineStandardTime({ code: 'ST-301', scope: 'process', targetCode: 'OP-10', standardSeconds: 12.5 }),
    );
    expect(fractional).toMatchObject({ status: 'rejected' });

    const zero = await service.execute(
      t1,
      defineStandardTime({ code: 'ST-302', scope: 'process', targetCode: 'OP-10', standardSeconds: 0 }),
    );
    expect(zero).toMatchObject({ status: 'rejected' });

    // 重复定义同 code → rejected（define 守门：已存在）
    expect((await service.execute(t1, defineStandardTime({ code: 'ST-303', scope: 'process', targetCode: 'OP-10', standardSeconds: 60 }))).status).toBe('committed');
    const dup = await service.execute(t1, defineStandardTime({ code: 'ST-303', scope: 'process', targetCode: 'OP-10', standardSeconds: 90 }));
    expect(dup).toMatchObject({ status: 'rejected' });
    expect((dup as { reason: string }).reason).toContain('已存在');
  });
});

describe('StandardTimeLookup（hours 对标端口）', () => {
  it('active 当前版命中 → 对标快照', async () => {
    const service = newService();
    await service.execute(t1, defineStandardTime({ code: 'ST-400', scope: 'process', targetCode: 'OP-40', standardSeconds: 600 }));
    const benchmark = await service.resolveStandardTime(t1, 'process', 'OP-40');
    expect(benchmark).toMatchObject({
      standardTimeCode: 'ST-400',
      scope: 'process',
      targetCode: 'OP-40',
      standardSeconds: 600,
      preparationSeconds: 0,
    });
  });

  it('无可用行（未定义/跨租户）→ BaselineNotFoundError（404 语义）', async () => {
    const service = newService();
    await service.execute(t1, defineStandardTime({ code: 'ST-500', scope: 'process', targetCode: 'OP-50', standardSeconds: 60 }));
    await expect(service.resolveStandardTime(t1, 'process', 'OP-NONE')).rejects.toThrow(BaselineNotFoundError);
    await expect(service.resolveStandardTime(t1, 'product', 'OP-50')).rejects.toThrow(BaselineNotFoundError);
  });

  it('列表按 scope/targetCode 过滤（合同 §3：额定工时按工序/产品）', async () => {
    const service = newService();
    await service.execute(t1, defineStandardTime({ code: 'ST-600', scope: 'process', targetCode: 'OP-60', standardSeconds: 60 }));
    await service.execute(t1, defineStandardTime({ code: 'ST-601', scope: 'product', targetCode: 'DW-6060', standardSeconds: 90 }));

    expect((await service.listStandardTimes(t1, undefined, 'process')).map((row) => row.code)).toEqual(['ST-600']);
    expect((await service.listStandardTimes(t1, undefined, 'product', 'DW-6060')).map((row) => row.code)).toEqual(['ST-601']);
    expect((await service.listStandardTimes(t1)).map((row) => row.code).sort()).toEqual(['ST-600', 'ST-601']);
  });
});
