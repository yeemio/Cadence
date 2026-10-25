import { describe, expect, it } from 'vitest';
import { buildTablePdfDocument, createNodePdfRenderer } from '../src/index.js';

/**
 * 真实渲染测试（Done-when 4 引入分支的硬证据）：
 * pdfmake 0.3 真实渲染出非空 PDF 字节流，同时持续验证本包自持的
 * doc-definition 类型是 pdfmake 可消费的结构子集。
 */
describe('createNodePdfRenderer（pdfmake 懒加载，真实渲染）', () => {
  it('渲染出非空 PDF Buffer（%PDF 头）', async () => {
    const renderer = createNodePdfRenderer();
    const definition = buildTablePdfDocument({
      title: 'Work Ticket WO-2026-0001',
      headerRow: ['No', 'Item', 'Qty'],
      rows: [
        ['1', 'Flange DN50', '4'],
        ['2', 'Gasket M8', '20'],
      ],
      footerNote: 'printed by integration-print test',
    });
    const bytes = await renderer.renderToBinary(definition);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const head = String.fromCharCode(...bytes.subarray(0, 5));
    expect(head).toBe('%PDF-');
  });

  it('冻结定义零副作用（pdfmake 改写输入 → 适配器传克隆）', async () => {
    const renderer = createNodePdfRenderer();
    const definition = buildTablePdfDocument({
      title: 'Frozen input',
      headerRow: ['A'],
      rows: [['a']],
    });
    const before = JSON.stringify(definition);
    const bytes = await renderer.renderToBinary(definition);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(definition)).toBe(before); // 冻结定义未被改动
    expect(Object.isFrozen(definition.content)).toBe(true); // 仍冻结，未因改写报错
  });

  it('懒加载后复用：连续两次渲染均产出有效流', async () => {
    const renderer = createNodePdfRenderer();
    const definition = buildTablePdfDocument({
      title: 'Twice',
      headerRow: ['A'],
      rows: [['1']],
    });
    const first = await renderer.renderToBinary(definition);
    const second = await renderer.renderToBinary(definition);
    expect(first.byteLength).toBe(second.byteLength);
    expect(String.fromCharCode(...second.subarray(0, 5))).toBe('%PDF-');
  });
});
