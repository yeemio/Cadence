/**
 * reconcile:record CLI：从运行中的目标系统录制/刷新夹具 reference。
 *
 * 用法（根入口；示例夹具需要 server 在跑，受保护端点场景需 SMES_DEV_AUTH=on）：
 *   pnpm reconcile:record --target-base-url http://localhost:3000
 * 可选：--fixtures-dir、--filter <子串>、--keep-values（不脱敏 ignore/shape 路径）
 *
 * 录制会执行真实请求（含 POST 变更请求）并覆盖写回 reference 块；
 * compare 策略块保留不动。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NodeFetchTargetAdapter } from '../adapters/node-fetch-target-adapter.js';
import { FixtureValidationError, loadFixtureDir } from '../fixtures/load.js';
import { recordFixtures, type RecordResult } from '../record.js';
import { parseArgs } from './args.js';

const DEFAULT_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const DEFAULT_BASE_URL = 'http://localhost:3000';

/** 核心流程（可编程调用）。 */
export async function runRecord(input: {
  readonly fixturesDir: string;
  readonly baseUrl: string;
  readonly filter?: string | undefined;
  readonly keepValues?: boolean | undefined;
}): Promise<{ results: readonly RecordResult[]; exitCode: number }> {
  const all = loadFixtureDir(input.fixturesDir);
  const filter = input.filter;
  const fixtures =
    filter === undefined ? all : all.filter((f) => f.scenarioName.includes(filter));
  if (fixtures.length === 0) {
    throw new FixtureValidationError(input.fixturesDir, `filter '${input.filter}' 未命中任何场景`);
  }
  const results = await recordFixtures({
    fixtures,
    target: new NodeFetchTargetAdapter({ baseUrl: input.baseUrl }),
    ...(input.keepValues === undefined ? {} : { keepValues: input.keepValues }),
  });
  return { results, exitCode: results.some((r) => r.error !== undefined) ? 1 : 0 };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('help')) {
    printUsage();
    return 0;
  }
  let outcome: { results: readonly RecordResult[]; exitCode: number };
  try {
    outcome = await runRecord({
      fixturesDir: args.values.get('fixtures-dir') ?? DEFAULT_FIXTURES_DIR,
      baseUrl: args.values.get('target-base-url') ?? DEFAULT_BASE_URL,
      ...(args.values.get('filter') === undefined ? {} : { filter: args.values.get('filter') }),
      ...(args.flags.has('keep-values') ? { keepValues: true } : {}),
    });
  } catch (error) {
    if (error instanceof FixtureValidationError) {
      console.error(`夹具加载失败（fail-fast）：${error.message}`);
      return 2;
    }
    throw error;
  }
  for (const result of outcome.results) {
    if (result.error !== undefined) {
      console.error(`FAIL ${result.name}: 录制失败 ${result.error}`);
    } else {
      console.log(`已录制 ${result.name} ← ${result.status} → ${result.file}`);
    }
  }
  return outcome.exitCode;
}

function printUsage(): void {
  console.log(`用法：pnpm reconcile:record [--target-base-url <url>] [--fixtures-dir <dir>] [--filter <子串>] [--keep-values]

  --target-base-url  录制目标基址（默认 ${DEFAULT_BASE_URL}）
  --fixtures-dir     夹具目录（默认 ${DEFAULT_FIXTURES_DIR}）
  --filter           只录制场景名含该子串的夹具
  --keep-values      不脱敏 compare.ignore / compare.shape 命中的路径（默认删除）`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
