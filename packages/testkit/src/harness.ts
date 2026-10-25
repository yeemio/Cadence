/**
 * ReconcileHarness——对账编排：场景 → 目标调用 → 参考取回 → 比对 → 报告。
 *
 * 行为等价的判定面（ADR-0002 #3）：HTTP 状态码精确相等 + 响应体按策略深度
 * 比对零 diff。目标调用异常（网络/超时）计为该场景失败并携带错误信息，
 * 不中断其余场景。
 */
import { compareJson, type DiffEntry } from './comparator/comparator.js';
import type { CompareStrategy } from './comparator/strategy.js';
import type { ReferenceSource, ReconcileFixture, TargetAdapter, TargetResponse } from './types.js';

export interface ScenarioResult {
  readonly name: string;
  readonly file: string;
  readonly passed: boolean;
  /** 目标调用异常信息（passed=false 时可能有）。 */
  readonly error?: string;
  readonly diffs: readonly DiffEntry[];
  readonly durationMs: number;
  readonly recordedAt: string | null;
}

export interface ReconcileReport {
  readonly results: readonly ScenarioResult[];
  readonly passedCount: number;
  readonly failedCount: number;
}

export interface HarnessDeps {
  readonly target: TargetAdapter;
  readonly reference: ReferenceSource;
  readonly fixtures: readonly ReconcileFixture[];
}

export class ReconcileHarness {
  private readonly target: TargetAdapter;
  private readonly reference: ReferenceSource;
  private readonly fixtures: readonly ReconcileFixture[];

  constructor(deps: HarnessDeps) {
    this.target = deps.target;
    this.reference = deps.reference;
    this.fixtures = deps.fixtures;
  }

  /** 跑全部（或名字含 filter 子串的）场景。 */
  async run(filter?: string): Promise<ReconcileReport> {
    const selected =
      filter === undefined
        ? this.fixtures
        : this.fixtures.filter((fixture) => fixture.scenarioName.includes(filter));
    const results: ScenarioResult[] = [];
    for (const fixture of selected) {
      results.push(await this.runOne(fixture));
    }
    return {
      results,
      passedCount: results.filter((result) => result.passed).length,
      failedCount: results.filter((result) => !result.passed).length,
    };
  }

  private async runOne(fixture: ReconcileFixture): Promise<ScenarioResult> {
    const started = Date.now();
    const base: Omit<ScenarioResult, 'passed' | 'diffs' | 'durationMs'> = {
      name: fixture.scenarioName,
      file: fixture.file,
      recordedAt: fixture.recordedAt,
    };
    let actual: TargetResponse;
    try {
      actual = await this.target.invoke(fixture.input);
    } catch (error) {
      return {
        ...base,
        passed: false,
        error: describeInvokeError(error),
        diffs: [],
        durationMs: Date.now() - started,
      };
    }
    const reference = await this.reference.get(fixture.scenarioName);
    if (reference === null) {
      return {
        ...base,
        passed: false,
        diffs: [
          {
            kind: 'missing',
            path: 'reference',
            note: '参考未录制（先运行 pnpm reconcile:record）',
          },
        ],
        durationMs: Date.now() - started,
      };
    }
    const diffs = reconcileOutcome(reference, actual, fixture.strategy);
    return {
      ...base,
      passed: diffs.length === 0,
      diffs,
      durationMs: Date.now() - started,
    };
  }
}

/** 状态码 + 响应体的比对入口（导出供单测直接断言语义）。 */
export function reconcileOutcome(
  reference: { status: number; body: unknown },
  actual: TargetResponse,
  strategy: CompareStrategy,
): readonly DiffEntry[] {
  const diffs: DiffEntry[] = [];
  if (reference.status !== actual.status) {
    diffs.push({
      kind: 'value',
      path: 'status',
      expected: String(reference.status),
      actual: String(actual.status),
      note: 'HTTP 状态码',
    });
  }
  diffs.push(...compareJson(reference.body, actual.body, strategy));
  return diffs;
}

function describeInvokeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message)) {
    return `目标不可达（${message}）——确认 --target-base-url 指向运行中的被测系统`;
  }
  return message;
}
