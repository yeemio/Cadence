/**
 * MigrationSource 端口——数据迁移的源读取合同（M4 数据迁移工具骨架，ADR-0002 #4）。
 *
 * 清洁室边界（README 重申）：本端口只定义**通用读取形状**——dataset 名 + 流式
 * 行迭代器。任何具体源系统（MySQL 等）的表结构、列名、字段口径都是**运行时
 * 配置**（源描述符 + 映射文件），不进代码；真实源连接器属接入期实现。
 *
 * 端口形状（JSDoc 鸭子合同，.mjs 无 interface——组合点按此校验）：
 *
 *   interface MigrationSource {
 *     readonly name: string;                    // 报告显示名
 *     descriptor(): SourceDescriptor;           // dataset 清单与列元数据
 *     readRows(datasetName: string): AsyncIterable<SourceRow>;  // 流式读行
 *   }
 *
 * 语义合同：
 *   - readRows 按行流式产出，不整载入内存（大表可增量迁移）；
 *   - rowNumber 是**数据行**序号（1 起，不含表头/描述行）；
 *   - 行级解析错误（坏 JSON、字段数不齐）以 RowReadError 形态产出，
 *     由 pipeline 按双模式处置（report 收集 / strict 中止），不静默丢弃；
 *   - 未知 datasetName → 同步抛 ConfigError（读取开始前的可判定错误）。
 */

/** 单元格值域：CSV 产出 string；JSONL 产出原生 JSON 标量或 null。 */
// typedef CellValue = string | number | boolean | null

/** 源数据行（流式迭代器的元素）。 */
// typedef SourceRow = {
//   dataset: string,                       // 所属 dataset 名
//   rowNumber: number,                     // 数据行序号（1 起）
//   cells: Record<string, CellValue>,      // 列名 → 值（缺列不在 cells 中）
// }

/** 行级读取错误（作为元素产出，不中断迭代）。 */
export class RowReadError extends Error {
  constructor(dataset, rowNumber, message) {
    super(`${dataset} 行 ${rowNumber}：${message}`);
    this.name = 'RowReadError';
    this.dataset = dataset;
    this.rowNumber = rowNumber;
  }
}

/** 配置错误（源描述符/映射文件层，迁移开始前 fail-fast；exit 码 2）。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 严格模式首错即停错误（携带定位，pipeline 转 CLI 退出码 1）。 */
export class StrictModeAbort extends Error {
  constructor(failure) {
    super(
      `strict 模式首错即停：${failure.dataset} 行 ${failure.rowNumber}：` +
        failure.errors.map((e) => `${e.field ?? '<行>'} ${e.message}`).join('；'),
    );
    this.name = 'StrictModeAbort';
    this.failure = failure;
  }
}
