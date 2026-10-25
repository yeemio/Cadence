/**
 * 依赖铁律自检：对故意违规的夹具运行 dependency-cruiser，
 * 断言每条都被对应规则拦下（非零退出 + 报出规则名）。
 *
 * 铁律只有在"真的拦得住"时才算存在——每新增一条层级规则，都要在这里配一个夹具。
 */
import { execFileSync } from 'node:child_process';

const EXPECTATIONS = [
  {
    fixtureDir: 'packages/business-core/tests/boundary-fixtures',
    rule: 'core-no-internal-deps',
  },
  {
    fixtureDir: 'packages/payroll/tests/boundary-fixtures',
    rule: 'pro-pack-tier-edges',
  },
  {
    fixtureDir: 'packages/maintenance/tests/boundary-fixtures',
    rule: 'pro-pack-tier-edges',
  },
  {
    fixtureDir: 'packages/drawing/tests/boundary-fixtures',
    rule: 'pro-pack-tier-edges',
  },
  {
    fixtureDir: 'packages/metric-pack/tests/boundary-fixtures',
    rule: 'pro-pack-tier-edges',
  },
  {
    fixtureDir: 'packages/engine-reporting/tests/boundary-fixtures',
    rule: 'engine-tier-edges',
  },
];

let failures = 0;
for (const { fixtureDir, rule } of EXPECTATIONS) {
  let output = '';
  let failedAsExpected = false;
  try {
    execFileSync('pnpm', ['exec', 'depcruise', fixtureDir, '--config', '.dep-cruiser.selftest.cjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    failedAsExpected = true;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  if (!failedAsExpected) {
    console.error(`boundary selftest FAILED: ${fixtureDir} 违规夹具未被拦下（depcruise 退出码为 0）`);
    failures += 1;
    continue;
  }
  if (!output.includes(rule)) {
    console.error(`boundary selftest FAILED: ${fixtureDir} 期望报出规则 ${rule}，实际输出：\n${output}`);
    failures += 1;
    continue;
  }

  console.log(`boundary selftest OK: ${fixtureDir} 被拦下（${rule}）`);
}

process.exit(failures > 0 ? 1 : 0);
