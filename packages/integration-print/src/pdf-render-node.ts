/**
 * Node 侧 PDF 渲染端口实现（pdfmake 懒加载适配器，M1 增量 4-K）
 *
 * 依赖决策（Done-when 4，写明）：**pdfmake 0.3 真实引入**（MIT，ADR-0007
 * 复用白名单内）。理由：
 * 1. 本包是文档打印边缘包（ADR-0003 #6 边缘包独占外部 SDK），pdfmake 就是
 *    文档族选型库（非"三选一之一"），node 端可真实渲染——不是 F 线
 *    html5-qrcode 那种需要 DOM 挂载、引入即零调用的死依赖；
 * 2. 测试里真实渲染出非空 PDF Buffer（%PDF 头断言），持续验证
 *    pdf-document.ts 的自持 doc-definition 类型确为 pdfmake 可消费的结构
 *    子集——这是"端口形状正确"的唯一硬证据；
 * 3. 懒加载纪律不变：首次 renderToBinary 才 require('pdfmake') 并 memoize，
 *    纯域使用方（构造器/端口逻辑）零 SDK 加载成本。
 *
 * 字体策略（取舍写明）：
 * - 默认注册 pdfmake 自带 Roboto 字体容器（vfs 内嵌 base64，无需文件系统，
 *   覆盖拉丁字符）；
 * - 中文等 CJK 需要**外部授权的 TTF 字体**经 fontContainers 注入（许可证
 *   纪律按 ADR-0007 白名单在接线期裁定），M1 非目标，不处理；
 * - 安全：默认 setLocalAccessPolicy / setUrlAccessPolicy 全拒绝（pdfmake
 *   0.3 安全公告），仅 vfs 内嵌字体可用。
 *
 * 实现注意（实测）：pdfmake 会**改写**传入的 doc-definition（冻结对象直接
 * 抛 "Cannot add property version"）——本适配器先 structuredClone 再传入，
 * 调用方的冻结定义零副作用。故 PdfDefinition 必须保持纯数据形状。
 */
import { createRequire } from 'node:module';
import type { PdfDefinition, PdfRenderPort } from './pdf-document.js';

/** pdfmake 字体容器形状（build/fonts/Roboto.js 等模块的导出） */
export interface PdfFontContainer {
  readonly vfs: Readonly<Record<string, { readonly data: string; readonly encoding?: string }>>;
  readonly fonts: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface NodePdfRendererOptions {
  /** 追加字体容器（如 CJK TTF 容器，接线期提供）；Roboto 总是默认注册 */
  readonly fontContainers?: readonly PdfFontContainer[];
}

/** 渲染结果的最低可信判据：非空且以 %PDF- 开头 */
const PDF_MAGIC = '%PDF-';

/** 懒加载后的 pdfmake 引擎（结构化封装，避免 SDK 类型渗入域层） */
interface PdfmakeEngine {
  render(definition: unknown): Promise<Uint8Array>;
}

async function loadPdfmakeEngine(
  extraContainers: readonly PdfFontContainer[],
): Promise<PdfmakeEngine> {
  const nodeRequire = createRequire(import.meta.url);
  // pdfmake 为 CJS 包且不带类型声明；createRequire 返回 any，天然隔离 SDK 类型
  const pdfmake: {
    virtualfs: { writeFileSync(name: string, data: string, encoding?: string): void };
    addFonts(fonts: unknown): void;
    setLocalAccessPolicy(policy: (path: string) => boolean): void;
    setUrlAccessPolicy(policy: (url: string) => boolean): void;
    createPdf(definition: unknown): { getBuffer(): Promise<Uint8Array> };
  } = nodeRequire('pdfmake');
  const roboto: PdfFontContainer = nodeRequire('pdfmake/build/fonts/Roboto.js');

  const containers: readonly PdfFontContainer[] = [roboto, ...extraContainers];
  for (const container of containers) {
    for (const [name, entry] of Object.entries(container.vfs)) {
      pdfmake.virtualfs.writeFileSync(name, entry.data, entry.encoding);
    }
    pdfmake.addFonts(container.fonts);
  }
  pdfmake.setLocalAccessPolicy(() => false);
  pdfmake.setUrlAccessPolicy(() => false);

  return {
    async render(definition: unknown): Promise<Uint8Array> {
      // pdfmake 会改写 doc-definition（实测冻结对象抛 TypeError）——传克隆
      const buffer = await pdfmake.createPdf(definition).getBuffer();
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
      return bytes;
    },
  };
}

/**
 * Node 渲染端口：懒加载 pdfmake（首次渲染时加载并 memoize），
 * renderToBinary 返回与 pdfmake 内部缓冲解耦的字节副本。
 */
export function createNodePdfRenderer(options: NodePdfRendererOptions = {}): PdfRenderPort {
  let engine: PdfmakeEngine | undefined;
  return {
    async renderToBinary(definition: PdfDefinition): Promise<Uint8Array> {
      const active = engine ?? (engine = await loadPdfmakeEngine(options.fontContainers ?? []));
      const bytes = await active.render(structuredClone(definition));
      if (bytes.byteLength === 0) {
        throw new Error('pdfmake produced an empty stream: expected a non-empty pdf');
      }
      const head = String.fromCharCode(...bytes.subarray(0, PDF_MAGIC.length));
      if (head !== PDF_MAGIC) {
        throw new Error(`pdfmake produced an unexpected stream: expected it to start with ${PDF_MAGIC}`);
      }
      return bytes;
    },
  };
}
