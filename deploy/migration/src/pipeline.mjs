/**
 * 迁移 pipeline——源读取 × 映射 × 目标写入 的编排（CLI 与对账示例共用）。
 *
 * 双模式（合同语义）：
 *   - report（缺省）：行级失败（读取错误/映射错误/目标写入错误）收集进报告，
 *     整批继续——失败不中断，产出完整失败明细
 *   - strict：首错即抛 StrictModeAbort 中止整批（活系统切换前的门禁跑法）
 *
 * 配置错误（源描述符/映射文件/缺列/未映射 dataset）在任何行读取前 fail-fast
 * 抛 ConfigError——CLI 语义 exit 2（未开始迁移），区别于行失败的 exit 1。
 */
import { ConfigError, RowReadError, StrictModeAbort } from './source-port.mjs';
import { compileDatasetMapping, transformRow } from './mapping-engine.mjs';

function emptyStat() {
  return { converted: 0, constant: 0, default: 0, emptyToNull: 0 };
}

/**
 * 跑一次迁移（内存报告对象，无 IO 副作用——IO 全在 source/target 端口实现里）。
 *
 * @param {object} deps
 * @param {import('./source-port.mjs').MigrationSource} deps.source
 * @param {{ file: string, datasets: Record<string, object> }} deps.mapping loadMappingFile 的返回
 * @param {import('./target-port.mjs').MigrationTarget} deps.target
 * @param {'report'|'strict'} [deps.mode]
 * @param {ReadonlyArray<string>} [deps.datasets] 只迁移指定 dataset（缺省 = 描述符全集）
 * @returns 迁移报告（renderTextReport 的输入）
 */
export async function runMigration({ source, mapping, target, mode = 'report', datasets }) {
  if (mode !== 'report' && mode !== 'strict') {
    throw new ConfigError(`mode 必须是 report/strict（得到 '${mode}'）`);
  }
  const descriptorDatasets = source.descriptor().datasets;
  const selection =
    datasets === undefined ? descriptorDatasets.map((d) => d.name) : [...datasets];
  if (selection.length === 0) {
    throw new ConfigError('dataset 选择集为空');
  }
  // 映射与源描述符双向对账（零行前报全，不来回试）
  const declared = new Set(descriptorDatasets.map((d) => d.name));
  for (const name of selection) {
    if (!declared.has(name)) {
      throw new ConfigError(`选中的 dataset '${name}' 不在源描述符中（已声明：${[...declared].join(', ')}）`);
    }
    if (mapping.datasets[name] === undefined) {
      throw new ConfigError(`dataset '${name}' 无映射配置（${mapping.file} 的 datasets 键）`);
    }
  }
  const unmapped = Object.keys(mapping.datasets).filter((name) => declared.has(name));
  void unmapped; // 映射含源外 dataset 不报错（可复用同一映射文件做子集迁移）

  const datasetResults = [];
  for (const datasetEntry of descriptorDatasets) {
    if (!selection.includes(datasetEntry.name)) {
      continue;
    }
    const compiled = compileDatasetMapping(
      mapping.datasets[datasetEntry.name],
      datasetEntry,
      datasetEntry.name,
    );
    const result = {
      dataset: datasetEntry.name,
      businessKey: [...compiled.businessKey],
      rowsRead: 0,
      rowsOk: 0,
      rowsFailed: 0,
      inserted: 0,
      updated: 0,
      failures: [],
      stats: {},
    };
    const recordFailure = (rowNumber, errors) => {
      const failure = { dataset: datasetEntry.name, rowNumber, errors };
      result.failures.push(failure);
      result.rowsFailed += 1;
      if (mode === 'strict') {
        throw new StrictModeAbort(failure);
      }
    };
    for await (const row of source.readRows(datasetEntry.name)) {
      result.rowsRead += 1;
      if (row instanceof RowReadError) {
        recordFailure(row.rowNumber, [{ field: null, message: row.message }]);
        continue;
      }
      const transformed = transformRow(compiled, row);
      if (!transformed.ok) {
        recordFailure(row.rowNumber, transformed.errors);
        continue;
      }
      for (const [field, delta] of Object.entries(transformed.stats)) {
        const stat = (result.stats[field] ??= emptyStat());
        stat.converted += delta.converted;
        stat.constant += delta.constant;
        stat.default += delta.default;
        stat.emptyToNull += delta.emptyToNull;
      }
      let upsert;
      try {
        upsert = await target.upsert(datasetEntry.name, transformed.key, transformed.value);
      } catch (error) {
        recordFailure(row.rowNumber, [
          { field: null, message: `目标写入失败：${error instanceof Error ? error.message : String(error)}` },
        ]);
        continue;
      }
      result.rowsOk += 1;
      if (upsert.action === 'updated') result.updated += 1;
      else result.inserted += 1;
    }
    datasetResults.push(result);
  }
  return {
    target: target.name,
    mode,
    startedAt: new Date().toISOString(),
    datasets: datasetResults,
    totals: {
      rowsRead: datasetResults.reduce((sum, r) => sum + r.rowsRead, 0),
      rowsOk: datasetResults.reduce((sum, r) => sum + r.rowsOk, 0),
      rowsFailed: datasetResults.reduce((sum, r) => sum + r.rowsFailed, 0),
      inserted: datasetResults.reduce((sum, r) => sum + r.inserted, 0),
      updated: datasetResults.reduce((sum, r) => sum + r.updated, 0),
    },
  };
}
