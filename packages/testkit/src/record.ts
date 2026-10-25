/**
 * 录制核心：把目标系统对场景输入的真实响应写回夹具的 reference 块。
 *
 * - 写入 recordedAt 时间戳 + recordedFrom（目标名），防误提交过期参考
 *   （对账端 --max-age-days 据此拒绝陈旧参考）
 * - 默认脱敏：compare.ignore 与 compare.shape 命中的路径从写入值中删除
 *   （随机值/敏感值不落仓；--keep-values 关闭脱敏）
 * - compare 策略块原样保留（录制不猜策略；策略由夹具作者声明）
 * - 注意：录制执行真实请求——含 POST 等变更请求，作者自担选择
 */
import { writeFile } from 'node:fs/promises';
import { omitPaths } from './paths.js';
import type { ReconcileFixture, TargetAdapter } from './types.js';
import { FIXTURE_FORMAT } from './fixtures/types.js';

export interface RecordResult {
  readonly name: string;
  readonly file: string;
  readonly status: number;
  readonly error?: string;
}

export interface RecordFixturesOptions {
  readonly fixtures: readonly ReconcileFixture[];
  readonly target: TargetAdapter;
  readonly keepValues?: boolean;
  readonly now?: () => string;
}

/** 逐夹具调用目标并写回 reference；单夹具失败记入结果（不中断其余）。 */
export async function recordFixtures(options: RecordFixturesOptions): Promise<readonly RecordResult[]> {
  const now = options.now ?? (() => new Date().toISOString());
  const results: RecordResult[] = [];
  for (const fixture of options.fixtures) {
    try {
      const response = await options.target.invoke(fixture.input);
      const redactPatterns = options.keepValues
        ? []
        : [
            ...(fixture.strategy.ignore ?? []),
            ...Object.keys(fixture.strategy.shape ?? {}),
          ];
      const body = omitPaths(response.body, redactPatterns);
      const file = {
        format: FIXTURE_FORMAT,
        scenario: {
          name: fixture.scenarioName,
          ...(fixture.description === undefined ? {} : { description: fixture.description }),
          input: fixture.input,
        },
        reference: {
          status: response.status,
          body,
          recordedAt: now(),
          recordedFrom: options.target.name,
        },
        ...(Object.keys(fixture.strategy).length === 0 ? {} : { compare: fixture.strategy }),
      };
      await writeFile(fixture.file, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      results.push({ name: fixture.scenarioName, file: fixture.file, status: response.status });
    } catch (error) {
      results.push({
        name: fixture.scenarioName,
        file: fixture.file,
        status: 0,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
  return results;
}
