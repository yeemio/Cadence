/**
 * 版本化主数据生命周期测试（工序/设备/外协计价规则三对象同机制）：
 * define/register/set → revise（新版本 supersedes 旧版）→ 推导态 superseded、
 * 乐观锁（expectedRevision）、幂等（operationId）、事件（append-only 词汇面）、
 * 查询（当前版视图/历史/状态过滤/租户隔离）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BASELINE_COMMAND_KINDS } from '../../src/baseline/baseline-input.js';
import { BASELINE_EVENT_TYPES } from '../../src/baseline/baseline-events.js';
import { BaselineNotFoundError } from '../../src/baseline/baseline-errors.js';
import { committedEvents, newService, envelope, t1, t2 } from './helpers.js';

describe('工序库（process.define / process.revise）', () => {
  it('定义→提交事件→查询当前版；修订产生 v2 且 v1 推导 superseded', async () => {
    const service = newService();
    const defined = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-10', name: '粗车' }));
    expect(defined).toMatchObject({ status: 'committed', newRevision: 1 });
    const event = committedEvents(defined)[0]!;
    expect(event.eventType).toBe(BASELINE_EVENT_TYPES.processDefined);
    expect(event.aggregate).toEqual({ id: 'OP-10', type: 'baseline-process', revision: 1 });

    const revised = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.processRevise, { code: 'OP-10', name: '粗车外圆' }, { expectedRevision: 1 }),
    );
    expect(revised).toMatchObject({ status: 'committed', newRevision: 2 });

    const detail = await service.getProcess(t1, 'OP-10');
    expect(detail.current).toMatchObject({ code: 'OP-10', name: '粗车外圆', objectVersion: 2, status: 'active', supersedes: expect.any(String) });
    expect(detail.versions).toHaveLength(2);
    expect(detail.versions[0]).toMatchObject({ objectVersion: 1, status: 'superseded' }); // 推导态，不改旧行
    expect(detail.versions[1]).toMatchObject({ objectVersion: 2, status: 'active' });

    const events = await service.listEvents(t1);
    expect(events.map((row) => row.eventType)).toEqual([BASELINE_EVENT_TYPES.processDefined, BASELINE_EVENT_TYPES.processDefined]);
    expect(events[1]!.payload).toMatchObject({ action: 'revise', code: 'OP-10', objectVersion: 2 });
  });

  it('修订为字段级期望态：未提供的键沿用当前版', async () => {
    const service = newService();
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-20', name: '精铣', category: 'milling', description: '两轴' }));
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processRevise, { code: 'OP-20', description: '三轴' }, { expectedRevision: 1 }));
    const detail = await service.getProcess(t1, 'OP-20');
    expect(detail.current).toMatchObject({ name: '精铣', category: 'milling', description: '三轴' });
  });

  it('乐观锁：过期 expectedRevision / define 带数字 / revise 带 initial 均拒绝且不落账', async () => {
    const service = newService();
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-30', name: '钻孔' }));
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processRevise, { code: 'OP-30', name: '钻孔扩' }, { expectedRevision: 1 }));

    const stale = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processRevise, { code: 'OP-30', name: '第三次' }, { expectedRevision: 1 }));
    expect(stale).toMatchObject({ status: 'rejected' });
    expect((stale as { reason: string }).reason).toContain('乐观锁冲突');

    const dup = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-30', name: '重定义' }));
    expect(dup).toMatchObject({ status: 'rejected' });
    expect((dup as { reason: string }).reason).toContain('已存在');

    const wrongVerb = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-40', name: '新件' }, { expectedRevision: 3 }),
    );
    expect(wrongVerb).toMatchObject({ status: 'rejected' });
    expect((wrongVerb as { reason: string }).reason).toContain("'initial'");

    const missing = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processRevise, { code: 'OP-99', name: '幽灵' }, { expectedRevision: 1 }));
    expect(missing).toMatchObject({ status: 'rejected' });
    expect((missing as { reason: string }).reason).toContain('不存在');

    expect((await service.listProcesses(t1)).map((row) => row.code)).toEqual(['OP-30']); // 拒绝零落账
    expect((await service.listEvents(t1))).toHaveLength(2);
  });

  it('幂等：同一 operationId 重放（不同命令）拒绝重复执行', async () => {
    const service = newService();
    const first = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-50', name: '磨削' }, { operationId: 'op-fixed-1' }));
    expect(first).toMatchObject({ status: 'committed' });
    const replay = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-51', name: '另一工序' }, { operationId: 'op-fixed-1' }));
    expect(replay).toMatchObject({ status: 'rejected' });
    expect((replay as { reason: string }).reason).toContain('幂等');
    expect((await service.listProcesses(t1)).map((row) => row.code)).toEqual(['OP-50']);
  });

  it('被拒不占用 operationId（口径统一：先解析校验后记账）：重复定义被拒后换码，同 id 重发 → committed', async () => {
    const service = newService();
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-55', name: '珩磨' }));

    // 重复首发（initial）→ 已存在拒：发生在 claim 之前，不占用 operationId
    const refused = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-55', name: '珩磨改' }, { operationId: 'op-reuse-1' }),
    );
    expect(refused).toMatchObject({ status: 'rejected' });
    expect((refused as { reason: string }).reason).toContain('已存在');

    // 同 id 换新码重发 → committed（旧口径 claim 先行：此处会撞"已落账"，修复须换新 id）
    const reused = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-56', name: '研磨' }, { operationId: 'op-reuse-1' }),
    );
    expect(reused).toMatchObject({ status: 'committed' });

    // committed 后同 id 再发 → 不变量 3 拒（幂等冲突终态）
    const dup = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-57', name: '抛光' }, { operationId: 'op-reuse-1' }),
    );
    expect(dup).toMatchObject({ status: 'rejected' });
    expect((dup as { reason: string }).reason).toContain('幂等');
  });

  it('draft 态：显式 status=draft 落库；状态过滤与租户隔离', async () => {
    const service = newService();
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-60', name: '电镀外协', status: 'draft' }));
    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-61', name: '热处理' }));
    expect((await service.listProcesses(t1, 'draft')).map((row) => row.code)).toEqual(['OP-60']);
    expect((await service.listProcesses(t1, 'active')).map((row) => row.code)).toEqual(['OP-61']);
    await expect(service.getProcess(t1, 'OP-99')).rejects.toThrow(BaselineNotFoundError);
    expect(await service.listProcesses(t2)).toEqual([]); // 跨租户不可见
    await service.execute(t2, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-60', name: '他租户同码' })); // 他租户同码不冲突
  });

  it('载荷校验：非法 code / 未知 status 拒绝', async () => {
    const service = newService();
    const badCode = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: '非法 码', name: 'x' }));
    expect(badCode).toMatchObject({ status: 'rejected' });
    const badStatus = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.processDefine, { code: 'OP-70', name: 'x', status: 'frozen' }));
    expect(badStatus).toMatchObject({ status: 'rejected' });
  });
});

describe('设备台账（equipment.register / equipment.revise）', () => {
  it('注册→修订→推导 superseded；事件 EquipmentRegistered', async () => {
    const service = newService();
    const done = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.equipmentRegister, { code: 'CNC-01', name: '一号立加', type: 'machining', location: 'A 区' }));
    expect(done).toMatchObject({ status: 'committed', newRevision: 1 });
    expect(committedEvents(done)[0]!.eventType).toBe(BASELINE_EVENT_TYPES.equipmentRegistered);

    await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.equipmentRevise, { code: 'CNC-01', location: 'B 区' }, { expectedRevision: 1 }));
    const detail = await service.getEquipment(t1, 'CNC-01');
    expect(detail.current).toMatchObject({ location: 'B 区', type: 'machining', objectVersion: 2, status: 'active' });
    expect(detail.versions[0]).toMatchObject({ status: 'superseded' });
    expect((await service.listEquipment(t1))).toHaveLength(1);
  });
});
