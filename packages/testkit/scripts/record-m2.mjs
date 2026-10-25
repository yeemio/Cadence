#!/usr/bin/env node
/**
 * M2 九模块场景批量录制入口（R2 线：活系统对账场景集骨架的配套脚本）。
 *
 * 骨架夹具：../fixtures/m2-scenarios/<NN-module>/*.reconcile.json（一个文件=一个场景，
 * reference=null 待录制）。本脚本循环九个模块目录：
 *   - --list       列出全部场景（模块分组 + 自含/链式标记 + 占位符清单）——
 *                  亦即骨架加载冒烟（加载器 fail-fast，非法骨架在此暴露）
 *   - --dry-run    录制计划（将录制 / 将跳过分组），不发请求
 *   - --target-base-url <url>   录制模式：复用 @smes/testkit recordFixtures，
 *                  把新系统（默认 http://localhost:3000，须 SMES_DEV_AUTH=on）
 *                  的真实响应写回各夹具 reference（含脱敏与录制时间戳）
 *   - --module <dir 名前缀>      只处理一个模块目录（如 --module 03-listing）
 *   - --filter <场景名子串>      只处理命中的场景（自含场景批量补录用）
 *
 * 链式场景（input 含 __UPPER_SNAKE__ 占位符：运行期 ID / 乐观锁版本 / 固定字节）
 * 在录制模式被显式 SKIP 并列出待替换占位符——绝不静默跳过，也不把 404 伪装成
 * reference。占位符替换与准备链（setup chain）步骤见 M2-RECONCILE-GUIDE.md §4。
 *
 * 退出码：0=全部成功（或 list/dry-run）；1=存在录制失败；2=加载/用法错误。
 * 零新依赖：只依赖 @smes/testkit dist（node 内置 fs/path/url）。
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_ROOT = resolve(HERE, '../fixtures/m2-scenarios');
const DEFAULT_BASE_URL = 'http://localhost:3000';
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+__/g;

/** 手写参数解析（与 src/cli/args.ts 同款语义：--key value / --flag）。 */
function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      return { error: `未知参数 '${arg}'（本脚本只接受 -- 开头的选项）` };
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { values, flags };
}

function printUsage() {
  console.log(`用法：node scripts/record-m2.mjs [--list | --dry-run | --target-base-url <url>] [--module <前缀>] [--filter <子串>]

  --list              列出全部骨架场景（加载冒烟；默认动作当无其他模式时）
  --dry-run           录制计划（将录制/将跳过），不发请求
  --target-base-url   录制目标基址（默认 ${DEFAULT_BASE_URL}；需 server 以
                      SMES_DEV_AUTH=on 运行，身份走 x-smes-user dev 头）
  --module            只处理一个模块目录（如 03-listing；前缀匹配）
  --filter            只处理场景名含子串的夹具（自含场景补录用）

  链式场景（含 __PLACEHOLDER__ 占位符）录制时显式 SKIP；
  准备链与占位符替换见 M2-RECONCILE-GUIDE.md。`);
}

/** 深扫 input（path/query/headers/body）里的 __UPPER_SNAKE__ 占位符。 */
function findPlaceholders(value, found) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) found.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) findPlaceholders(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) findPlaceholders(item, found);
  }
}

/** 收集九模块目录 → 每目录 loadFixtureDir（fail-fast）→ 跨目录场景名唯一性自检。 */
async function loadModules(loadFixtureDir, modulePrefix) {
  const entries = readdirSync(SCENARIOS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => modulePrefix === undefined || entry.name.startsWith(modulePrefix))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    throw new Error(`模块目录未命中（root=${SCENARIOS_ROOT}${modulePrefix === undefined ? '' : `，前缀 '${modulePrefix}'`}）`);
  }
  const modules = [];
  const seenNames = new Map();
  for (const dir of entries) {
    const fixtures = loadFixtureDir(join(SCENARIOS_ROOT, dir));
    for (const fixture of fixtures) {
      const previous = seenNames.get(fixture.scenarioName);
      if (previous !== undefined) {
        throw new Error(`场景名 '${fixture.scenarioName}' 跨目录重复（${previous} vs ${fixture.file}）`);
      }
      seenNames.set(fixture.scenarioName, fixture.file);
    }
    modules.push({ dir, fixtures });
  }
  return modules;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const { values, flags } = parsed;
  if (flags.has('help')) {
    printUsage();
    return 0;
  }
  const modes = ['list', 'dry-run', 'target-base-url'].filter((m) => flags.has(m) || values.has(m));
  if (modes.length > 1) {
    console.error(`--list / --dry-run / --target-base-url 互斥（收到 ${modes.join(' + ')}）`);
    return 2;
  }
  const list = modes.length === 0 || flags.has('list');
  const dryRun = flags.has('dry-run');
  const filter = values.get('filter');

  let testkit;
  try {
    testkit = await import('../dist/index.js');
  } catch {
    console.error('无法加载 @smes/testkit dist——先构建：pnpm --filter @smes/testkit build');
    return 2;
  }

  let modules;
  try {
    modules = await loadModules(testkit.loadFixtureDir, values.get('module'));
  } catch (error) {
    console.error(`骨架加载失败（fail-fast）：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // 分组：自含（可直接录制） vs 链式（占位符待替换）
  let total = 0;
  let chained = 0;
  const selfContained = [];
  for (const module of modules) {
    for (const fixture of module.fixtures) {
      if (filter !== undefined && !fixture.scenarioName.includes(filter)) continue;
      total += 1;
      const placeholders = new Set();
      findPlaceholders(fixture.input, placeholders);
      if (placeholders.size > 0) {
        chained += 1;
        module.chained = [...(module.chained ?? []), { fixture, placeholders: [...placeholders] }];
      } else {
        selfContained.push({ module: module.dir, fixture });
      }
    }
  }
  if (filter !== undefined && total === 0) {
    console.error(`filter '${filter}' 未命中任何场景`);
    return 2;
  }

  const header = `M2 场景集：${SCENARIOS_ROOT}`;
  console.log(header);

  if (list) {
    for (const module of modules) {
      const rows = module.fixtures.filter((f) => filter === undefined || f.scenarioName.includes(filter));
      if (rows.length === 0) continue;
      const chainedRows = module.chained ?? [];
      console.log(`  ${module.dir}：${rows.length} 场景（自含 ${rows.length - chainedRows.length} / 链式 ${chainedRows.length}）`);
      for (const fixture of rows) {
        const entry = (module.chained ?? []).find((c) => c.fixture === fixture);
        console.log(`    ${fixture.scenarioName}${entry === undefined ? '' : `  [链式→待替换: ${entry.placeholders.join(', ')}]`}`);
      }
    }
    console.log(`合计：${total} 场景（自含 ${total - chained} / 链式 ${chained}）；reference 全部待录制（骨架形态）`);
    return 0;
  }

  if (dryRun) {
    console.log(`将录制（自含，${selfContained.length} 个）：`);
    for (const { module: dir, fixture } of selfContained) console.log(`  [${dir}] ${fixture.scenarioName}`);
    console.log(`将跳过（链式占位，${chained} 个）——替换占位符后重跑：`);
    for (const module of modules) {
      for (const entry of module.chained ?? []) {
        if (filter !== undefined && !entry.fixture.scenarioName.includes(filter)) continue;
        console.log(`  [${module.dir}] ${entry.fixture.scenarioName}  待替换: ${entry.placeholders.join(', ')}`);
      }
    }
    return 0;
  }

  // 录制模式：复用 recordFixtures（写回 reference + 脱敏 + recordedAt/recordedFrom）
  const baseUrl = values.get('target-base-url') ?? DEFAULT_BASE_URL;
  const target = new testkit.NodeFetchTargetAdapter({ baseUrl });
  console.log(`录制目标：${baseUrl}（自含 ${selfContained.length} 个；链式 ${chained} 个跳过）`);
  if (selfContained.length === 0) {
    console.log('无可录制场景（全部为链式占位或被 filter 过滤）');
    return 0;
  }
  const results = await testkit.recordFixtures({
    fixtures: selfContained.map((s) => s.fixture),
    target,
  });
  let failed = 0;
  for (const result of results) {
    if (result.error !== undefined) {
      failed += 1;
      console.error(`FAIL ${result.name}: 录制失败 ${result.error}`);
    } else {
      console.log(`已录制 ${result.name} ← ${result.status} → ${result.file}`);
    }
  }
  if (chained > 0) {
    console.log(`SKIP ${chained} 个链式场景（占位符未替换）——清单：本脚本 --dry-run 查看；替换步骤见 M2-RECONCILE-GUIDE.md §4`);
  }
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
