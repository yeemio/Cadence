/**
 * @smes/integration-print —— 打印边缘包（M1 增量 4-K）
 *
 * 两族能力：文档打印（pdfmake，doc-definition 纯数据 + node 渲染适配器）
 * 与标签打印（TSPL 命令纯字符串生成）。端口 + 纯构造器，纯域可测；
 * 真实打印机传输（USB/TCP/串口）与注册表发现属接线增量。
 */
// ---- 打印任务统一形状（Done-when 2：类型/载荷/份数/目标打印机可空） ----
export type {
  PrintJobId,
  PrinterId,
  PrintJobKind,
  PrintPayload,
  PrintJob,
  PrintJobInput,
} from './print-job.js';
export {
  createPrintJobId,
  isPrintJobId,
  createPrinterId,
  isPrinterId,
  makePrintJob,
  isPrintJob,
  MAX_PRINT_COPIES,
} from './print-job.js';

// ---- 打印端口（submit / 预览 dry-run）+ 两族实现口 + 内存实现 ----
export type {
  PrintFamily,
  PrintPreview,
  PrintSubmission,
  PrintPort,
  PdfPrintPort,
  TsplPrintPort,
  InMemoryPrintPort,
  InMemoryPrintPortOptions,
} from './print-port.js';
export {
  PrintJobInvalidError,
  PrintPortMismatchError,
  createInMemoryPrintPort,
} from './print-port.js';

// ---- 打印机注册表端口 + 内存实现 ----
export type { PrinterDescriptor, PrinterRegistryPort } from './printer-registry.js';
export { createInMemoryPrinterRegistry } from './printer-registry.js';

// ---- TSPL 标签命令生成器（Done-when 3 重点：纯字符串 + 参数校验 + 转义语义） ----
export type {
  TsplDirectionValue,
  TsplRotation,
  TsplEccLevel,
  TsplBarcodeType,
  TsplTextOptions,
  TsplBarcodeOptions,
  TsplQrcodeOptions,
} from './tspl.js';
export {
  TSPL_BARCODE_TYPES,
  TSPL_LINE_SEPARATOR,
  tsplSize,
  tsplGap,
  tsplDirection,
  tsplCls,
  tsplText,
  tsplBarcode,
  tsplQrcode,
  tsplPrint,
  tsplCopy,
  buildTsplProgram,
} from './tspl.js';

// ---- 标签场景构造器（Done-when 6：二维码 + 文本行） ----
export type { LabelTextLine, QrLabelSpec } from './label-program.js';
export { buildQrLabelProgram, mmToDots } from './label-program.js';

// ---- PDF 文档定义（Done-when 4：纯数据 doc-definition + 渲染端口） ----
export type {
  PdfAlignment,
  PdfMargin,
  PdfPageSize,
  PdfTextStyle,
  PdfTextContent,
  PdfTableCell,
  PdfColumnWidth,
  PdfTableContent,
  PdfContent,
  PdfStyles,
  PdfMetadata,
  PdfDefinition,
  PdfRenderPort,
} from './pdf-document.js';
export { createPdfDefinition, isPdfDefinition } from './pdf-document.js';

// ---- 单据场景构造器（Done-when 6：含表格的 doc-definition） ----
export type { TableDocumentSpec } from './table-document.js';
export { buildTablePdfDocument } from './table-document.js';

// ---- Node 渲染适配器（pdfmake 懒加载，真实引入，见模块头依赖决策） ----
export type { PdfFontContainer, NodePdfRendererOptions } from './pdf-render-node.js';
export { createNodePdfRenderer } from './pdf-render-node.js';
