/**
 * JsonLinesSource——JSON Lines 文件源读取器（MigrationSource 端口单文件实现之二）。
 *
 * 取舍：JSONL 逐行独立 JSON，node 内置 readline + JSON.parse 即完整实现，
 * 无需手写解析器。行值域合同：顶层必须是**扁平对象**（值 = JSON 标量或
 * null）；数组/嵌套对象属源 schema 复杂形状，骨架不支持（行级错误报出，
 * 接入期如需嵌套取值，扩展映射引擎的取值路径语法，不动读取端口）。
 *
 * 语义：
 *   - 空白行跳过；rowNumber = 文件物理行号（1 起）——定位即行号
 *   - 坏 JSON / 非对象 / 含非标量顶层值 → RowReadError 元素（不中断迭代）
 *   - 与源描述符列声明的关系：声明列 = 可被映射引用的列；行内未声明键
 *     忽略（同 CSV 的"多余列忽略"语义），缺列即 cells 中无该键
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { ConfigError, RowReadError } from './source-port.mjs';

function isScalar(value) {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** JsonLinesSource：一个 .jsonl 文件 = 一个 dataset。 */
export class JsonLinesSource {
  /**
   * @param {object} options
   * @param {string} options.dataset dataset 名
   * @param {string} options.filePath JSONL 文件路径
   * @param {ReadonlyArray<string|{name:string}>} options.columns 源描述符列声明
   */
  constructor({ dataset, filePath, columns }) {
    this.name = `jsonl:${filePath}`;
    this.dataset = dataset;
    this.filePath = filePath;
    this.columns = columns.map((c) => (typeof c === 'string' ? c : c.name));
  }

  descriptor() {
    return {
      datasets: [
        {
          name: this.dataset,
          file: this.filePath,
          format: 'jsonl',
          columns: this.columns.map((name) => ({ name })),
        },
      ],
    };
  }

  async *readRows(datasetName) {
    if (datasetName !== this.dataset) {
      throw new ConfigError(`jsonl 源未声明 dataset '${datasetName}'（仅有 '${this.dataset}'）`);
    }
    const declared = new Set(this.columns);
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        yield new RowReadError(datasetName, lineNumber, `JSON 解析失败：${error.message}`);
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        yield new RowReadError(datasetName, lineNumber, '顶层必须是 JSON 对象');
        continue;
      }
      const cells = {};
      let bad = null;
      for (const [key, value] of Object.entries(parsed)) {
        if (!isScalar(value)) {
          bad = `顶层字段 '${key}' 必须是标量或 null（嵌套形状不支持）`;
          break;
        }
        if (declared.has(key)) {
          cells[key] = value;
        }
        // 未声明键忽略
      }
      if (bad !== null) {
        yield new RowReadError(datasetName, lineNumber, bad);
        continue;
      }
      yield { dataset: datasetName, rowNumber: lineNumber, cells };
    }
  }
}
