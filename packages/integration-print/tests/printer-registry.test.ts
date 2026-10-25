import { describe, expect, it } from 'vitest';
import { createInMemoryPrinterRegistry, createPrinterId } from '../src/index.js';

const labeler = {
  printerId: createPrinterId('labeler-01'),
  name: 'Cell A labeler',
  families: ['tspl'] as const,
  online: true,
};
const officePrinter = {
  printerId: createPrinterId('doc-01'),
  name: 'Office A4',
  families: ['pdf', 'tspl'] as const,
  online: false,
};

describe('内存打印机注册表', () => {
  it('list 返回全量快照（冻结），get 命中与未命中', async () => {
    const registry = createInMemoryPrinterRegistry([labeler, officePrinter]);
    const all = await registry.list();
    expect(all).toHaveLength(2);
    expect(Object.isFrozen(all[0])).toBe(true);

    const found = await registry.get(createPrinterId('labeler-01'));
    expect(found).toMatchObject({ name: 'Cell A labeler', families: ['tspl'], online: true });

    expect(await registry.get(createPrinterId('nobody'))).toBeNull();
  });

  it('描述符与注册表校验：重复标识 / 坏形状拒绝', () => {
    expect(() =>
      createInMemoryPrinterRegistry([labeler, { ...labeler, name: 'dup' }]),
    ).toThrow(/duplicate printerId/);
    expect(() =>
      createInMemoryPrinterRegistry([{ ...labeler, name: ' ' }]),
    ).toThrow(/name/);
    expect(() =>
      createInMemoryPrinterRegistry([{ ...labeler, families: [] as never }]),
    ).toThrow(/families/);
    expect(() =>
      createInMemoryPrinterRegistry([{ ...labeler, online: 'yes' as never }]),
    ).toThrow(/online/);
    expect(() => createInMemoryPrinterRegistry([{ ...labeler, printerId: '' as never }])).toThrow(
      /printerId/,
    );
  });

  it('get 入参校验', async () => {
    const registry = createInMemoryPrinterRegistry([labeler]);
    await expect(registry.get('' as never)).rejects.toThrow(/printerId/);
  });
});
