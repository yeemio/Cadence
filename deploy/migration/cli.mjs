#!/usr/bin/env node
/**
 * 数据迁移 CLI（M4 数据迁移工具骨架；决策簿 M4"数据迁移+并行运行+切流"四件
 * 之首件——本骨架只做通用迁移机制，并行运行/切流不在本线）。
 *
 * 用法：
 *   node deploy/migration/cli.mjs \
 *     --source <dir>          # 源目录（含 source-descriptor.json + 数据文件）
 *     --mapping <file>        # 映射文件（smes.migration-mapping@1）
 *     --target memory|dry-run # 目标：memory（内存写入）/ dry-run（只算不写）
 *     [--mode report|strict]  # 行失败处置：收集报告（缺省）/ 首错即停
 *     [--generate-ids]        # memory 目标模拟代理键生成（字段 id，uuid）
 *     [--export-fixtures <dir>]  # 迁移后导出 testkit 对账夹具（仅 memory）
 *
 * exit 码：0 全成；1 有行失败（含 strict 中止）；2 配置/环境错误。
 * 清洁室纪律：源 schema 全部来自运行时配置——换源系统零代码改动（README）。
 */
import { resolve } from 'node:path';
import { DirectoryMigrationSource } from './src/source-descriptor.mjs';
import { loadMappingFile } from './src/mapping-engine.mjs';
import { InMemoryTarget, DryRunTarget } from './src/memory-target.mjs';
import { runMigration } from './src/pipeline.mjs';
import { renderTextReport, exitCodeOf } from './src/report.mjs';
import { exportDatasetFixtures } from './src/fixture-export.mjs';
import { ConfigError } from './src/source-port.mjs';

const USAGE = `用法：node deploy/migration/cli.mjs --source <dir> --mapping <file> --target memory|dry-run
可选：--mode report|strict  --generate-ids  --export-fixtures <dir>
exit 码：0 全成；1 有行失败；2 配置错误`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ConfigError(`参数 '${arg}' 缺值`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case '--source':
        options.source = next();
        break;
      case '--mapping':
        options.mapping = next();
        break;
      case '--target':
        options.target = next();
        break;
      case '--mode':
        options.mode = next();
        break;
      case '--export-fixtures':
        options.exportFixtures = next();
        break;
      case '--generate-ids':
        options.generateIds = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new ConfigError(`未知参数 '${arg}'\n${USAGE}`);
    }
  }
  for (const required of ['source', 'mapping', 'target']) {
    if (options[required] === undefined) {
      throw new ConfigError(`缺 --${required} 参数\n${USAGE}`);
    }
  }
  if (!['memory', 'dry-run'].includes(options.target)) {
    throw new ConfigError(`--target 必须是 memory|dry-run（得到 '${options.target}'）`);
  }
  if (options.mode !== undefined && !['report', 'strict'].includes(options.mode)) {
    throw new ConfigError(`--mode 必须是 report|strict（得到 '${options.mode}'）`);
  }
  if (options.target === 'dry-run' && options.exportFixtures !== undefined) {
    throw new ConfigError('--export-fixtures 仅支持 --target memory（dry-run 无持久化快照）');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const source = new DirectoryMigrationSource(resolve(options.source));
  const mapping = loadMappingFile(resolve(options.mapping));
  const target =
    options.target === 'dry-run'
      ? new DryRunTarget()
      : new InMemoryTarget(options.generateIds ? { idField: 'id' } : {});
  const report = await runMigration({
    source,
    mapping,
    target,
    mode: options.mode ?? 'report',
  });
  console.log(renderTextReport(report));
  if (options.exportFixtures !== undefined && report.totals.rowsFailed === 0) {
    const dir = resolve(options.exportFixtures);
    for (const dataset of report.datasets) {
      const rows = await target.snapshot(dataset.dataset);
      const file = exportDatasetFixtures({
        dir,
        dataset: dataset.dataset,
        rows,
        unorderedKey: dataset.businessKey.length === 1 ? dataset.businessKey[0] : null,
        generatedFields: options.generateIds ? ['id'] : [],
        recordedFrom: `cli:${target.name}`,
      });
      console.log(`夹具已导出：${file}（${rows.length} 行，供 testkit ReconcileHarness 比对）`);
    }
  }
  return exitCodeOf(report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ConfigError) {
      console.error(`配置错误：${error.message}`);
      process.exitCode = 2;
      return;
    }
    if (error.name === 'StrictModeAbort') {
      console.error(`${error.message}（strict 模式：整批中止，已中止于首错）`);
      process.exitCode = 1;
      return;
    }
    console.error(`迁移失败：${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 2;
  });
