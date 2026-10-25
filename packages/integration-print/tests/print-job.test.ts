import { describe, expect, it } from 'vitest';
import {
  buildTablePdfDocument,
  buildQrLabelProgram,
  createPrinterId,
  createPrintJobId,
  isPrintJob,
  makePrintJob,
  MAX_PRINT_COPIES,
} from '../src/index.js';

const documentJob = makePrintJob({
  jobId: createPrintJobId('pj-001'),
  kind: 'document',
  payload: {
    family: 'pdf',
    definition: buildTablePdfDocument({
      title: 'Work Ticket',
      headerRow: ['No', 'Item'],
      rows: [['1', 'Flange']],
    }),
  },
  createdAt: '2026-10-25T10:00:00.000Z',
});

const labelJob = makePrintJob({
  jobId: createPrintJobId('pj-002'),
  kind: 'label',
  payload: {
    family: 'tspl',
    program: buildQrLabelProgram({
      size: { widthMm: 40, heightMm: 30 },
      qrcode: { content: 'WO-2026-0001', xDots: 16, yDots: 16 },
      lines: [{ text: 'WO-2026-0001' }],
      copies: 3,
    }),
  },
  copies: 3,
  targetPrinterId: createPrinterId('labeler-01'),
  createdAt: '2026-10-25T10:00:01.000Z',
});

describe('PrintJob 统一形状（类型/载荷/份数/目标打印机可空）', () => {
  it('文档族与标签族两形态齐备', () => {
    expect(documentJob.kind).toBe('document');
    expect(documentJob.payload.family).toBe('pdf');
    expect(documentJob.copies).toBe(1);
    expect('targetPrinterId' in documentJob).toBe(false);

    expect(labelJob.kind).toBe('label');
    expect(labelJob.payload.family).toBe('tspl');
    expect(labelJob.copies).toBe(3);
    expect(labelJob.targetPrinterId).toBe('labeler-01');
  });

  it('构造即冻结 + isPrintJob 守卫', () => {
    expect(Object.isFrozen(documentJob)).toBe(true);
    expect(isPrintJob(documentJob)).toBe(true);
    expect(isPrintJob(labelJob)).toBe(true);
    expect(isPrintJob({ jobId: 'x' })).toBe(false);
  });

  it('品牌化 id 校验', () => {
    expect(() => createPrintJobId('')).toThrow(/print job id/);
    expect(() => createPrintJobId('   ')).toThrow(/print job id/);
    expect(() => createPrinterId('x'.repeat(129))).toThrow(/printer id/);
  });

  it('kind 与载荷族错配拒绝（document 必配 pdf，label 必配 tspl）', () => {
    expect(() =>
      makePrintJob({
        jobId: createPrintJobId('pj-x'),
        kind: 'document' as never,
        payload: { family: 'tspl', program: 'CLS\r\nPRINT 1' },
        createdAt: '2026-10-25T10:00:00.000Z',
      }),
    ).toThrow(/requires payload family 'pdf'/);
    expect(() =>
      makePrintJob({
        jobId: createPrintJobId('pj-x'),
        kind: 'label',
        payload: { family: 'tspl', program: '' },
        createdAt: '2026-10-25T10:00:00.000Z',
      }),
    ).toThrow(/non-empty tspl command string/);
    expect(() =>
      makePrintJob({
        jobId: createPrintJobId('pj-x'),
        kind: 'document',
        payload: { family: 'pdf', definition: { content: [] } as never },
        createdAt: '2026-10-25T10:00:00.000Z',
      }),
    ).toThrow(/valid pdf definition/);
  });

  it('份数边界：1 与上限通过，0 / 上限+1 / 小数拒绝', () => {
    const base = {
      jobId: createPrintJobId('pj-c'),
      kind: 'label' as const,
      payload: { family: 'tspl' as const, program: 'CLS\r\nPRINT 1' },
      createdAt: '2026-10-25T10:00:00.000Z',
    };
    expect(makePrintJob({ ...base, copies: 1 }).copies).toBe(1);
    expect(makePrintJob({ ...base, copies: MAX_PRINT_COPIES }).copies).toBe(MAX_PRINT_COPIES);
    expect(() => makePrintJob({ ...base, copies: 0 })).toThrow(/copies/);
    expect(() => makePrintJob({ ...base, copies: MAX_PRINT_COPIES + 1 })).toThrow(/copies/);
    expect(() => makePrintJob({ ...base, copies: 1.5 })).toThrow(/copies/);
  });

  it('坏时间戳拒绝', () => {
    expect(() =>
      makePrintJob({
        jobId: createPrintJobId('pj-t'),
        kind: 'label',
        payload: { family: 'tspl', program: 'CLS\r\nPRINT 1' },
        createdAt: 'not-a-date',
      }),
    ).toThrow(/createdAt/);
  });
});
