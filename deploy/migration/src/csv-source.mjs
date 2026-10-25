/**
 * CsvFileSource——CSV 文件源读取器（MigrationSource 端口的单文件实现之一）。
 *
 * 取舍（零依赖手写解析）：node 无内置 CSV 解析器；引入三方依赖违反本目录
 * "零新依赖"纪律（deploy 不入 pnpm workspace）。故手写 RFC 4180 子集的
 * **流式**状态机解析：
 *   - 引号字段：`"a,b"`、`"say ""hi"""`（双引号转义）；引号内可含逗号与换行
 *   - 记录分隔：CRLF / LF / CR 均接受；空行（无内容记录）跳过
 *   - UTF-8 BOM 容忍（首 chunk 剥离）
 *   - 不支持：注释行、可变分隔符（固定 `,`）、引号外空白保留原样（不 trim——
 *     trim 属映射层类型转换职责，读取层保持原样）
 * 性能边界：逐字符状态机，骨架期足够；接入期若遇大表性能瓶颈可换分块向量化
 * 解析——端口形状不变。
 *
 * 表头行 = 列名（首记录）；与源描述符声明列做**集合相等**校验（顺序无关，
 * 多列/缺列均 fail-fast ConfigError——绝不让错位数据静默进入映射）。
 * 单元格一律产出 string（空串 = 空）；类型语义（数字/布尔/日期）由映射层
 * 的类型转换赋予——CSV 本身无类型。
 */
import { createReadStream } from 'node:fs';
import { ConfigError, RowReadError } from './source-port.mjs';

const BOM = '\uFEFF';

/**
 * 流式解析一个 CSV 文件为记录：先出一条 { kind:'header', columns }，
 * 随后逐条出 { kind:'data', rowNumber, fields }。
 * 逐 chunk 读取、逐字符推进状态机，完成一条记录即产出——内存占用与最长
 * 单行成正比，与文件大小无关。
 */
export async function* parseCsvRecords(filePath, { encoding = 'utf8' } = {}) {
  const stream = createReadStream(filePath, { encoding });
  let buffer = '';
  let field = '';
  let record = [];
  let inQuotes = false;
  let atFieldStart = true; // 当前字段尚未开始（引号只有在此态才有开义）
  let recordHasContent = false; // 当前记录已见任何实字符（区分空行）
  let headerEmitted = false;
  let dataRowNumber = 0;
  let firstChunk = true;

  for await (const chunk of stream) {
    if (firstChunk) {
      firstChunk = false;
      buffer = chunk.startsWith(BOM) ? chunk.slice(BOM.length) : chunk;
    } else {
      buffer += chunk;
    }
    let i = 0;
    while (i < buffer.length) {
      const ch = buffer[i];
      if (inQuotes) {
        if (ch === '"') {
          if (buffer[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"' && atFieldStart) {
        inQuotes = true;
        atFieldStart = false;
        recordHasContent = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        record.push(field);
        field = '';
        atFieldStart = true;
        recordHasContent = true;
        i += 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        i += ch === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
        if (recordHasContent || field.length > 0 || record.length > 0) {
          record.push(field);
          if (!headerEmitted) {
            headerEmitted = true;
            yield { kind: 'header', columns: record };
          } else {
            dataRowNumber += 1;
            yield { kind: 'data', rowNumber: dataRowNumber, fields: record };
          }
          record = [];
          recordHasContent = false;
          atFieldStart = true;
        }
        field = '';
        continue;
      }
      field += ch;
      atFieldStart = false;
      recordHasContent = true;
      i += 1;
    }
    buffer = '';
  }
  // EOF：无尾随换行的最后一条记录
  if (recordHasContent || field.length > 0 || record.length > 0) {
    record.push(field);
    if (!headerEmitted) {
      yield { kind: 'header', columns: record };
    } else {
      dataRowNumber += 1;
      yield { kind: 'data', rowNumber: dataRowNumber, fields: record };
    }
  }
}

/**
 * CsvFileSource：一个 CSV 文件 = 一个 dataset。
 * 构造时给列声明（来自源描述符）；readRows 首条记录校验表头与列声明集合
 * 相等，随后按**实际表头顺序**对齐单元格。
 */
export class CsvFileSource {
  /**
   * @param {object} options
   * @param {string} options.dataset dataset 名
   * @param {string} options.filePath CSV 文件绝对/相对路径
   * @param {ReadonlyArray<string|{name:string}>} options.columns 源描述符列声明
   */
  constructor({ dataset, filePath, columns }) {
    this.name = `csv:${filePath}`;
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
          format: 'csv',
          columns: this.columns.map((name) => ({ name })),
        },
      ],
    };
  }

  async *readRows(datasetName) {
    if (datasetName !== this.dataset) {
      throw new ConfigError(`csv 源未声明 dataset '${datasetName}'（仅有 '${this.dataset}'）`);
    }
    const declared = new Set(this.columns);
    let header = null;
    for await (const parsed of parseCsvRecords(this.filePath)) {
      if (parsed.kind === 'header') {
        header = parsed.columns;
        const actual = new Set(header);
        const missing = [...declared].filter((c) => !actual.has(c));
        const extra = [...actual].filter((c) => !declared.has(c));
        if (missing.length > 0 || extra.length > 0) {
          throw new ConfigError(
            `${datasetName}：CSV 表头与源描述符列声明不一致` +
              (missing.length ? `（缺列：${missing.join(',')}）` : '') +
              (extra.length ? `（多列：${extra.join(',')}）` : ''),
          );
        }
        continue;
      }
      if (header === null) {
        // 理论不可达（data 必在 header 后）；防御性兜底
        throw new ConfigError(`${datasetName}：CSV 缺表头行`);
      }
      if (parsed.fields.length !== header.length) {
        yield new RowReadError(
          datasetName,
          parsed.rowNumber,
          `字段数 ${parsed.fields.length} ≠ 表头列数 ${header.length}`,
        );
        continue;
      }
      const cells = {};
      for (let i = 0; i < header.length; i += 1) {
        cells[header[i]] = parsed.fields[i];
      }
      yield { dataset: datasetName, rowNumber: parsed.rowNumber, cells };
    }
    if (header === null) {
      throw new ConfigError(`${datasetName}：CSV 文件无表头行（${this.filePath}）`);
    }
  }
}
