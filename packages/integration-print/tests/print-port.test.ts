import { describe, expect, it } from 'vitest';
import {
  createInMemoryPrintPort,
  makePrintJob,
  PrintJobInvalidError,
  PrintPortMismatchError,
  buildQrLabelProgram,
  buildTablePdfDocument,
  createPrintJobId,
  createPrinterId,
  type PrintJob,
} from '../src/index.js';

const tableJob: PrintJob = makePrintJob({
  jobId: createPrintJobId('pj-doc'),
  kind: 'document',
  payload: {
    family: 'pdf',
    definition: buildTablePdfDocument({
      title: 'Work Ticket',
      headerRow: ['No'],
      rows: [['1']],
    }),
  },
  createdAt: '2026-10-25T10:00:00.000Z',
});

const labelJob: PrintJob = makePrintJob({
  jobId: createPrintJobId('pj-label'),
  kind: 'label',
  payload: {
    family: 'tspl',
    program: buildQrLabelProgram({
      size: { widthMm: 40, heightMm: 30 },
      qrcode: { content: 'WO-1', xDots: 8, yDots: 8 },
      lines: [{ text: 'WO-1' }, { text: 'CELL-A' }],
      copies: 2,
    }),
  },
  targetPrinterId: createPrinterId('labeler-01'),
  createdAt: '2026-10-25T10:00:00.000Z',
});

describe('内存打印端口：preview dry-run 与 submit', () => {
  it('两族端口类型收窄（family 字面量）', () => {
    const pdfPort = createInMemoryPrintPort('pdf');
    const tsplPort = createInMemoryPrintPort('tspl');
    expect(pdfPort.family).toBe('pdf');
    expect(tsplPort.family).toBe('tspl');
  });

  it('preview 为 dry-run：不触达设备、不记录任务', () => {
    const port = createInMemoryPrintPort('tspl');
    const preview = port.preview(labelJob);
    expect(preview).toMatchObject({ jobId: 'pj-label', family: 'tspl', copies: 1 });
    expect(preview.payloadSize).toBe(9); // SIZE/GAP/DIRECTION/CLS/QRCODE/TEXT×2/PRINT/COPY
    expect(port.submittedJobs()).toHaveLength(0);
  });

  it('submit 记录任务并发票（时钟注入定值）', async () => {
    let clock = 1_000_000;
    const port = createInMemoryPrintPort('tspl', { now: () => clock });
    const submission = await port.submit(labelJob);
    expect(submission).toEqual({
      jobId: 'pj-label',
      family: 'tspl',
      submittedAt: '1970-01-01T00:16:40.000Z',
      targetPrinterId: 'labeler-01',
    });
    expect(Object.isFrozen(submission)).toBe(true);
    expect(port.submittedJobs()).toEqual([labelJob]);

    clock = 2_000_000;
    const pdfPort = createInMemoryPrintPort('pdf', { now: () => clock });
    const docSubmission = await pdfPort.submit(tableJob);
    expect(docSubmission.submittedAt).toBe('1970-01-01T00:33:20.000Z');
    expect(pdfPort.preview(tableJob).payloadSize).toBe(2); // 标题 + 表格两个内容块
  });

  it('族不匹配拒绝：tspl 端口拒 pdf 任务，反之亦然', () => {
    const tsplPort = createInMemoryPrintPort('tspl');
    expect(() => tsplPort.preview(tableJob)).toThrow(PrintPortMismatchError);
    const pdfPort = createInMemoryPrintPort('pdf');
    expect(() => pdfPort.preview(labelJob)).toThrow(PrintPortMismatchError);
    expect(pdfPort.submittedJobs()).toHaveLength(0);
  });

  it('无效任务拒绝（绕过 makePrintJob 的畸形形状）', () => {
    const port = createInMemoryPrintPort('pdf');
    expect(() => port.preview({ kind: 'document' } as never)).toThrow(PrintJobInvalidError);
  });
});
