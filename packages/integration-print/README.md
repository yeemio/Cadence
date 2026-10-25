# integration-print（打印边缘包）

M1 增量 4-K。文档打印（pdfmake）与标签打印（TSPL 纯字符串生成）两族端口：
PrintJob 统一形状 + submit/预览 dry-run 端口 + 打印机注册表端口 + 纯构造器。
纯域可测（不真连打印机；node 适配器真实渲染 PDF 只走内存流）。

## 端口一览（统一 `PrintPort`：preview dry-run / submit）

| 族 | 实现口 | 承载 | 现状 |
| --- | --- | --- | --- |
| pdf（单据） | `PdfPrintPort` | doc-definition → pdfmake 渲染 | 渲染适配器已实现（node，懒加载）；设备打印适配器待接线增量 |
| tspl（标签） | `TsplPrintPort` | TSPL 命令串 → 标签打印机 | USB/TCP/串口传输待接线增量；命令生成已完备 |

- `PrintJob = { jobId, kind(document/label), payload, copies(1~1000), targetPrinterId?, createdAt }`，
  构造即冻结；kind 与载荷族一一对应（document↔pdf，label↔tspl）。
- `preview(job)`：dry-run——纯校验 + 载荷摘要（tspl 命令行数 / pdf 内容块数），
  **不触达任何设备**；`submit(job)`：触达设备/驱动，产出发票（冻结）。
- `PrinterRegistryPort`（list/get）：注册表的存储与发现属接线层；包内提供
  纯内存实现（`createInMemoryPrinterRegistry`）供组合根占位与测试。
- `createInMemoryPrintPort(family)`：两族共用的纯内存端口（记录已提交任务），
  测试与接线占位用。

## TSPL 标签命令生成（`tspl.ts`，纯字符串）

- 命令构造器：`tsplSize` / `tsplGap` / `tsplDirection` / `tsplCls` / `tsplText` /
  `tsplBarcode` / `tsplQrcode` / `tsplPrint` / `tsplCopy`；`buildTsplProgram`
  以 CRLF 逐行拼接（无尾随分隔符），逐条校验单行、无控制字符。
- **转义语义**：TSPL 字符串以双引号定界、协议无转义写法——换行/控制字符
  （U+0000–U+001F、U+007F）与双引号一律**构造期抛错拒绝**，不发明转义；
  多行文本拆多条 TEXT；反斜杠按字面传递。
- **参数校验**：坐标/倍率非负整数（倍率 1~10）、尺寸正数（mm 两位小数去尾零）、
  码值按码制字符域（128=可打印 ASCII；39=大写+数字+`- . $ / + %`；
  EAN13/EAN8/UPCA=定长数字且校验位正确）。
- **COPY 语义**：`COPY n` 在已打印标签上**追加**重印 n 张（总计 1+n，
  TSPL2 手册口径）；打 N 份 = `PRINT 1` + `COPY N-1`。
- QRCODE mode 固定 A（自动掩码）；manual 掩码参数序未经真机验证，不凭记忆写。

## PDF 文档定义（`pdf-document.ts` + `pdf-render-node.ts`）

- `PdfDefinition`：**自持类型**（pdfmake TDocumentDefinitions 的结构子集，
  清洁室，不 import SDK 类型）——content(text/table)/styles/info/pageSize，
  `createPdfDefinition` 校验后深冻结**克隆**（快照语义：不改冻调用方对象）。
- 场景构造器：`buildTablePdfDocument`（标题+表格+脚注单据）、
  `buildQrLabelProgram`（二维码+文本行标签，`mmToDots` 换算 dpi）。
- `createNodePdfRenderer()`：node 渲染端口，懒加载 pdfmake 并 memoize；
  实测 pdfmake 会改写 doc-definition（冻结对象直接抛 TypeError）→ 适配器
  先 `structuredClone` 再传入，调用方冻结定义零副作用；输出字节做 `%PDF`
  头与非空校验。

## 依赖决策（pdfmake：真实引入）

**pdfmake 0.3 已引入**（MIT，ADR-0007 复用白名单）。理由：

1. 本包是文档打印边缘包（ADR-0003 #6 边缘包独占外部 SDK），pdfmake 就是
   文档族选型库，node 端可真实渲染——不同于 F 线 html5-qrcode 需 DOM 挂载、
   引入即零调用死依赖的场景；
2. 测试真实渲染非空 PDF Buffer（%PDF 头断言），持续验证自持 doc-definition
   类型是 pdfmake 可消费的结构子集——端口形状正确的唯一硬证据；
3. 懒加载纪律不变：首次 `renderToBinary` 才加载 SDK，纯域使用方零成本。

**字体策略（取舍）**：默认注册 pdfmake 自带 Roboto 字体容器（vfs 内嵌
base64，无需文件系统，覆盖拉丁字符）；本地文件与外网 URL 访问默认全拒绝
（pdfmake 0.3 安全公告）。中文等 CJK 需外部授权 TTF 经 `fontContainers`
注入，许可证按 ADR-0007 白名单在接线期裁定——M1 非目标。

## 词汇与依赖关系

词汇过 ADR-0010 三问：print/job/document/label/text/barcode/dpi 均为跨行业
通用词；TSPL 为命令语言标准名，仅存于边缘包导出前缀，不进 business-core。
依赖 `@smes/business-core`（类型级 Brand）+ `@smes/application`（脚手架既有，
本增量未用）+ `pdfmake`；受 `.dep-cruiser.cjs` `integration-tier-edges` 约束。
