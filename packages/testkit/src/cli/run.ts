/**
 * reconcile CLI：加载夹具 → 调目标 → 比对 → 报告 → 退出码（有 fail 非零）。
 *
 * 用法（根入口）：
 *   pnpm reconcile --target-base-url http://localhost:3000
 * 可选：--fixtures-dir <dir>（默认本包 fixtures/）、--filter <子串>、
 *       --max-age-days <n>（参考录制时间早于 n 天 → 失败，防过期参考）
 *
 * 示例夹具需要 server 在跑（apps/server；受保护端点场景需 SMES_DEV_AUTH=on
 * + dev 头，见 README）。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NodeFetchTargetAdapter } from '../adapters/node-fetch-target-adapter.js';
import { StaticFixtureSource } from '../adapters/static-fixture-source.js';
import { FixtureValidationError, loadFixtureDir } from '../fixtures/load.js';
import { ReconcileHarness, type ReconcileReport } from '../harness.js';
import { formatTextReport } from '../report.js';
import { parseArgs } from './args.js';

const DEFAULT_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const DEFAULT_BASE_URL = 'http://localhost:3000';

export interface RunOutcome {
  readonly report: ReconcileReport;
  readonly stale: readonly string[];
  readonly exitCode: number;
}

/** 核心流程（可编程调用；CLI main 只做参数解析与打印）。 */
export async function runReconcile(input: {
  readonly fixturesDir: string;
  readonly baseUrl: string;
  readonly filter?: string | undefined;
  readonly maxAgeDays?: number | undefined;
  readonly now?: () => Date;
}): Promise<RunOutcome> {
  const fixtures = loadFixtureDir(input.fixturesDir);
  // 空命中防护（对称 record CLI）：filter 未命中任何场景时 fail-fast，
  // 否则「0 场景 0 失败」会被读成全绿（假绿）。
  const filter = input.filter;
  if (filter !== undefined && !fixtures.some((fixture) => fixture.scenarioName.includes(filter))) {
    throw new FixtureValidationError(input.fixturesDir, `filter '${filter}' 未命中任何场景`);
  }
  const harness = new ReconcileHarness({
    target: new NodeFetchTargetAdapter({ baseUrl: input.baseUrl }),
    reference: new StaticFixtureSource(fixtures),
    fixtures,
  });
  const report = await harness.run(input.filter);
  const stale: string[] = [];
  if (input.maxAgeDays !== undefined) {
    const now = (input.now ?? (() => new Date()))().getTime();
    const cutoff = now - input.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const fixture of fixtures) {
      if (
        input.filter !== undefined &&
        !fixture.scenarioName.includes(input.filter)
      ) {
        continue;
      }
      if (fixture.recordedAt === null) {
        stale.push(`${fixture.scenarioName}: 无录制时间戳`);
      } else if (Date.parse(fixture.recordedAt) < cutoff) {
        stale.push(`${fixture.scenarioName}: 参考录制于 ${fixture.recordedAt}（超过 ${input.maxAgeDays} 天）`);
      }
    }
  }
  return {
    report,
    stale,
    exitCode: report.failedCount > 0 || stale.length > 0 ? 1 : 0,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('help')) {
    printUsage();
    return 0;
  }
  const fixturesDir = args.values.get('fixtures-dir') ?? DEFAULT_FIXTURES_DIR;
  const baseUrl = args.values.get('target-base-url') ?? DEFAULT_BASE_URL;
  const maxAgeDaysRaw = args.values.get('max-age-days');
  let maxAgeDays: number | undefined;
  if (maxAgeDaysRaw !== undefined) {
    maxAgeDays = Number(maxAgeDaysRaw);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
      console.error(`--max-age-days 需为非负数，实际 '${maxAgeDaysRaw}'`);
      return 2;
    }
  }
  let outcome: RunOutcome;
  try {
    outcome = await runReconcile({
      fixturesDir,
      baseUrl,
      ...(args.values.get('filter') === undefined ? {} : { filter: args.values.get('filter') }),
      ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
    });
  } catch (error) {
    if (error instanceof FixtureValidationError) {
      console.error(`夹具加载失败（fail-fast）：${error.message}`);
      return 2;
    }
    throw error;
  }
  console.log(`目标：${baseUrl}`);
  console.log(formatTextReport(outcome.report));
  for (const line of outcome.stale) {
    console.log(`STALE ${line}`);
  }
  if (outcome.stale.length > 0) {
    console.log(`参考过期：${outcome.stale.length} 条（重录：pnpm reconcile:record）`);
  }
  return outcome.exitCode;
}

function printUsage(): void {
  console.log(`用法：pnpm reconcile [--target-base-url <url>] [--fixtures-dir <dir>] [--filter <子串>] [--max-age-days <n>]

  --target-base-url  被测系统基址（默认 ${DEFAULT_BASE_URL}）
  --fixtures-dir     夹具目录（默认 ${DEFAULT_FIXTURES_DIR}）
  --filter           只跑场景名含该子串的夹具
  --max-age-days     参考录制早于 n 天 → 退出码非零（防过期参考）`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
