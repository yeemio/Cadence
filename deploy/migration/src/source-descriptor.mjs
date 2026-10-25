/**
 * 源描述符（运行时配置）+ DirectoryMigrationSource（目录组合源）。
 *
 * 源描述符文件形状（放在源目录，名固定 `source-descriptor.json`）：
 *
 *   {
 *     "format": "smes.migration-source@1",
 *     "datasets": [
 *       {
 *         "name": "items",                       // dataset 名（迁移报告/映射文件的键）
 *         "file": "items.csv",                   // 相对源目录的文件名
 *         "format": "csv",                       // csv | jsonl
 *         "columns": [                           // 列元数据（顺序无关）
 *           { "name": "code" },
 *           { "name": "price", "type": "number" }// type 仅文档性质，映射引擎自持类型转换
 *         ]
 *       }
 *     ]
 *   }
 *
 * 清洁室要点：列名/文件名/类型标注全部来自**这份运行时配置**——换一个源
 * 系统不改任何代码。描述符校验全部 fail-fast（ConfigError）：
 * format 串、dataset 名唯一且非空、文件存在、format 合法、列名唯一非空。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError } from './source-port.mjs';
import { CsvFileSource } from './csv-source.mjs';
import { JsonLinesSource } from './jsonl-source.mjs';

export const SOURCE_DESCRIPTOR_FORMAT = 'smes.migration-source@1';
export const SOURCE_DESCRIPTOR_FILENAME = 'source-descriptor.json';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 加载并校验源描述符（坏形状 fail-fast，报文件路径与原因）。 */
export function loadSourceDescriptor(sourceDir) {
  const file = join(sourceDir, SOURCE_DESCRIPTOR_FILENAME);
  if (!existsSync(file)) {
    throw new ConfigError(`源描述符缺失：${file}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file}：JSON 解析失败：${error.message}`);
  }
  if (!isPlainObject(raw) || raw.format !== SOURCE_DESCRIPTOR_FORMAT) {
    throw new ConfigError(`${file}：format 必须是 '${SOURCE_DESCRIPTOR_FORMAT}'`);
  }
  if (!Array.isArray(raw.datasets) || raw.datasets.length === 0) {
    throw new ConfigError(`${file}：datasets 必须是非空数组`);
  }
  const seen = new Set();
  for (const entry of raw.datasets) {
    if (!isPlainObject(entry)) {
      throw new ConfigError(`${file}：datasets 元素必须是对象`);
    }
    const { name, file: dataFile, format } = entry;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ConfigError(`${file}：dataset.name 必须是非空字符串`);
    }
    if (seen.has(name)) {
      throw new ConfigError(`${file}：dataset 名 '${name}' 重复`);
    }
    seen.add(name);
    if (typeof dataFile !== 'string' || dataFile.length === 0) {
      throw new ConfigError(`${file}：dataset '${name}' 缺 file`);
    }
    if (!['csv', 'jsonl'].includes(format)) {
      throw new ConfigError(`${file}：dataset '${name}' 的 format 必须是 csv/jsonl`);
    }
    if (!Array.isArray(entry.columns) || entry.columns.length === 0) {
      throw new ConfigError(`${file}：dataset '${name}' 缺非空 columns`);
    }
    const colSeen = new Set();
    for (const column of entry.columns) {
      const columnName = typeof column === 'string' ? column : column?.name;
      if (typeof columnName !== 'string' || columnName.trim().length === 0) {
        throw new ConfigError(`${file}：dataset '${name}' 有非法列声明 ${JSON.stringify(column)}`);
      }
      if (colSeen.has(columnName)) {
        throw new ConfigError(`${file}：dataset '${name}' 列名 '${columnName}' 重复`);
      }
      colSeen.add(columnName);
    }
    const absolute = resolve(sourceDir, dataFile);
    if (!existsSync(absolute)) {
      throw new ConfigError(`${file}：dataset '${name}' 的数据文件不存在：${absolute}`);
    }
  }
  return { file, dir: sourceDir, datasets: raw.datasets };
}

/**
 * DirectoryMigrationSource：源目录 → MigrationSource 端口实现。
 * 一个目录 = 一组 dataset（描述符声明），按 format 分派 Csv/JsonLines 读取器。
 */
export class DirectoryMigrationSource {
  constructor(sourceDir) {
    this.descriptorFile = loadSourceDescriptor(sourceDir);
    this.name = `dir:${resolve(sourceDir)}`;
    this._readers = new Map();
    for (const entry of this.descriptorFile.datasets) {
      this._readers.set(
        entry.name,
        entry.format === 'csv'
          ? new CsvFileSource({
              dataset: entry.name,
              filePath: resolve(sourceDir, entry.file),
              columns: entry.columns,
            })
          : new JsonLinesSource({
              dataset: entry.name,
              filePath: resolve(sourceDir, entry.file),
              columns: entry.columns,
            }),
      );
    }
  }

  descriptor() {
    return {
      datasets: [...this._readers.values()].flatMap((reader) => reader.descriptor().datasets),
    };
  }

  readRows(datasetName) {
    const reader = this._readers.get(datasetName);
    if (reader === undefined) {
      throw new ConfigError(
        `源目录未声明 dataset '${datasetName}'（已声明：${[...this._readers.keys()].join(', ')}）`,
      );
    }
    return reader.readRows(datasetName);
  }
}
