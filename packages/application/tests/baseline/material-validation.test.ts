/**
 * 物料校验测试：确定性引擎（归一化/Dice 相似度/三分判定/阈值注入）+
 * 命令执行（事件、运行落账、查询、幂等）。比对基准 = masterdata 物品库端口。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { InMemoryItemStore } from '../../src/masterdata/in-memory-masterdata-stores.js';
import { BASELINE_COMMAND_KINDS } from '../../src/baseline/baseline-input.js';
import { BASELINE_EVENT_TYPES, type MaterialValidatedEventPayload } from '../../src/baseline/baseline-events.js';
import {
  bigramDiceSimilarity,
  judgeMaterialLine,
  normalizeName,
  normalizeSpec,
  validateMaterialLines,
} from '../../src/baseline/material-validation.js';
import { committedEvents, envelope, newService, t1, t2 } from './helpers.js';

/** 预置物品库：P-1001 轴承 / P-1002 同名不同规格 / P-1003 无规格垫片。 */
function seededLibrary(): InMemoryItemStore {
  const items = new InMemoryItemStore();
  void items.create({ tenant: t1, code: 'P-1001', name: '轴承', spec: '6204-2RS', unit: '个', category: 'part' });
  void items.create({ tenant: t1, code: 'P-1002', name: '轴承', spec: '6204-ZZ', unit: '个', category: 'part' });
  void items.create({ tenant: t1, code: 'P-1003', name: '垫片', spec: null, unit: '个', category: 'part' });
  return items;
}

describe('归一化与相似度（确定性）', () => {
  it('normalizeSpec：全角/大小写/乘号/空白 归一', () => {
    expect(normalizeSpec(' 45＊50×60 ')).toBe('45x50x60');
    expect(normalizeSpec('45*50x60')).toBe('45x50x60');
    expect(normalizeSpec('6204-2rs')).toBe('6204-2rs');
  });

  it('normalizeName：NFKC + 小写 + 压缩空白', () => {
    expect(normalizeName(' 轴　承 ')).toBe('轴 承'); // 全角空格 NFKC → 半角
    expect(normalizeName('AB')).toBe('ab');
  });

  it('Dice 相似度：等值=1、无公共=0、确定值', () => {
    expect(bigramDiceSimilarity('6204-2rs', '6204-2rs')).toBe(1);
    expect(bigramDiceSimilarity('abc', 'xyz')).toBe(0);
    expect(bigramDiceSimilarity('', '')).toBe(1);
    expect(bigramDiceSimilarity('', 'a')).toBe(0);
    expect(bigramDiceSimilarity('6204-2rs', '6204-2z')).toBeCloseTo(2 * 5 / 13, 10); // 5/7 与 5/6 公共二元组
  });
});

describe('单行判定（三分）', () => {
  const library = seededLibrary();
  const views = () => library.list(t1); // Promise——judgeMaterialLine 需要同步数组，测试里先取

  it('编码精确 + 规格归一化等值 → matched', async () => {
    const items = await views();
    expect(judgeMaterialLine({ code: 'P-1001', name: '轴承', spec: ' 6204-2rs ' }, items)).toMatchObject({
      judgment: 'matched',
      basis: 'code-exact',
      candidateItemCode: 'P-1001',
      similarity: 1,
    });
  });

  it('编码精确 + 规格相似度低于匹配阈 → suspected（候选=该物品）', async () => {
    const items = await views();
    expect(judgeMaterialLine({ code: 'P-1001', name: null, spec: '6204-2Z' }, items)).toMatchObject({
      judgment: 'suspected',
      basis: 'code-exact',
      candidateItemCode: 'P-1001',
    });
  });

  it('编码未命中 + 名称等值 + 规格达疑似阈 → suspected（name-and-spec）', async () => {
    const items = await views();
    const judged = judgeMaterialLine({ code: 'P-9999', name: '轴承', spec: '6204-2RS' }, items);
    expect(judged.judgment).toBe('suspected');
    expect(judged.basis).toBe('name-and-spec');
    expect(['P-1001', 'P-1002']).toContain(judged.candidateItemCode);
    expect(judged.similarity).toBe(1); // 与 P-1001 规格完全一致，取最优
  });

  it('编码未命中且名称无候选 → unmatched；名称有候选但规格差异大 → unmatched', async () => {
    const items = await views();
    expect(judgeMaterialLine({ code: 'P-7777', name: '异形件', spec: 'ZZ-01' }, items)).toMatchObject({
      judgment: 'unmatched',
      basis: 'none',
      similarity: 0,
    });
    expect(judgeMaterialLine({ code: 'P-7777', name: '轴承', spec: 'ZZZZZZ' }, items)).toMatchObject({
      judgment: 'unmatched',
    });
  });

  it('规格单侧缺失 → suspected（保守转人工）；双侧缺失 → matched', async () => {
    const items = await views();
    expect(judgeMaterialLine({ code: 'P-1003', name: '垫片', spec: 'φ10' }, items)).toMatchObject({
      judgment: 'suspected',
      similarity: 0,
    });
    expect(judgeMaterialLine({ code: 'P-1003', name: '垫片', spec: null }, items)).toMatchObject({
      judgment: 'matched',
      similarity: 1,
    });
  });

  it('阈值注入改变判定边界（对账阶段校准入口）', async () => {
    const items = await views();
    const line = { code: 'P-1001', name: null, spec: '6204-2Z' };
    expect(judgeMaterialLine(line, items).judgment).toBe('suspected'); // 缺省 0.9：0.769 不达
    expect(judgeMaterialLine(line, items, { specMatchThreshold: 0.7, suspectThreshold: 0.5 }).judgment).toBe('matched');
  });

  it('整单执行：行号回填 + 汇总计数', async () => {
    const items = await views();
    const { judgments, summary } = validateMaterialLines(
      [
        { code: 'P-1001', name: '轴承', spec: '6204-2RS' },
        { code: 'P-1001', name: null, spec: '6204-2Z' },
        { code: 'P-7777', name: '异形件', spec: null },
      ],
      items,
    );
    expect(judgments.map((row) => row.lineNo)).toEqual([1, 2, 3]);
    expect(summary).toEqual({ total: 3, matched: 1, suspected: 1, unmatched: 1 });
  });
});

describe('material.validate 命令执行', () => {
  it('执行→落账→事件→查询（运行明细 + 列表 + 幂等）', async () => {
    const service = newService(seededLibrary());
    const outcome = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.materialValidate, {
        lines: [
          { code: 'P-1001', name: '轴承', spec: '6204-2RS' },
          { code: 'P-1001', name: null, spec: '6204-2Z' },
          { code: 'P-7777', name: '异形件', spec: null },
          { code: null, name: '垫片', spec: null },
        ],
      }),
    );
    expect(outcome).toMatchObject({ status: 'committed', newRevision: 1 });
    const event = committedEvents(outcome)[0]!;
    expect(event.eventType).toBe(BASELINE_EVENT_TYPES.materialValidated);
    expect(event.aggregate.type).toBe('baseline-material-validation');
    const payload = event.payload as MaterialValidatedEventPayload;
    expect(payload.summary).toEqual({ total: 4, matched: 1, suspected: 2, unmatched: 1 });

    const runs = await service.listValidationRuns(t1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty('lines'); // 列表视图不含逐行载荷
    const run = await service.getValidationRun(t1, runs[0]!.id);
    // 行 4（无编码、名称+双侧缺规格）走名称路径：无编码不判 matched，保守 suspected
    expect(run.lines.map((row) => row.judgment)).toEqual(['matched', 'suspected', 'unmatched', 'suspected']);
    expect(run.lines[1]).toMatchObject({ code: 'P-1001', candidateItemCode: 'P-1001' });
    expect(run).toMatchObject({ issuedBy: 'u-tech-01', objectVersion: 1 });

    const replay = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [{ code: 'P-1001', name: '轴承', spec: '6204-2RS' }] }, { operationId: 'op-material-replay' }),
    );
    void replay;
    const replay2 = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [{ code: 'P-1001', name: '轴承', spec: '6204-2RS' }] }, { operationId: 'op-material-replay' }),
    );
    expect(replay2).toMatchObject({ status: 'rejected' }); // operationId 幂等
    expect(await service.listValidationRuns(t1)).toHaveLength(2);
  });

  it('空物品库：全部 unmatched（诚实语义）；跨租户库不可见', async () => {
    const service = newService(seededLibrary());
    const otherTenantRun = await service.execute(
      t2,
      envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [{ code: 'P-1001', name: '轴承', spec: '6204-2RS' }] }),
    );
    expect(otherTenantRun).toMatchObject({ status: 'committed' });
    const t2Runs = await service.listValidationRuns(t2);
    const t2Run = await service.getValidationRun(t2, t2Runs[0]!.id);
    expect(t2Run.lines[0]).toMatchObject({ judgment: 'unmatched', candidateItemCode: null }); // t2 无物品库数据
  });

  it('载荷校验：空行数组 / 全空行 / 超上限 / expectedRevision 数字 均拒绝', async () => {
    const service = newService(seededLibrary());
    const empty = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [] }));
    expect(empty).toMatchObject({ status: 'rejected' });
    const blank = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [{ code: null, name: null, spec: null }] }));
    expect(blank).toMatchObject({ status: 'rejected' });
    const tooMany = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: Array.from({ length: 201 }, () => ({ code: 'P-1001' })) }),
    );
    expect(tooMany).toMatchObject({ status: 'rejected' });
    const wrongRevision = await service.execute(
      t1,
      envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [{ code: 'P-1001' }] }, { expectedRevision: 1 }),
    );
    expect(wrongRevision).toMatchObject({ status: 'rejected' });
    expect((wrongRevision as { reason: string }).reason).toContain("'initial'");
  });

  it('阈值注入经模块服务生效（同一判定在低匹配阈下转 matched）', async () => {
    const relaxed = newService(seededLibrary(), { thresholds: { specMatchThreshold: 0.7, suspectThreshold: 0.5 } });
    await relaxed.execute(t1, envelope(BASELINE_COMMAND_KINDS.materialValidate, { lines: [{ code: 'P-1001', spec: '6204-2Z' }] }));
    const runs = await relaxed.listValidationRuns(t1);
    const run = await relaxed.getValidationRun(t1, runs[0]!.id);
    expect(run.lines[0]).toMatchObject({ judgment: 'matched' });
  });
});
