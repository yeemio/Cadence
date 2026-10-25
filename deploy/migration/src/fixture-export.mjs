/**
 * 夹具导出器——迁移结果 → @smes/testkit 对账夹具（`smes.reconcile-fixture@1`）。
 *
 * 衔接语义（ADR-0002 #3 行为等价的迁移版）：迁移产出（目标快照行）导出为
 * 夹具后，与**源侧期望**（同一导出器从期望行产出，或活源录制）经
 * ReconcileHarness 深度比对——见 examples/run-reconcile-example.mjs。
 *
 * 产出一个 `<dataset>.reconcile.json`：
 *   - scenario.input = 可配置的读回请求形状（缺省 GET /masterdata/<dataset>，
 *     接入期换成真实目标的路由）
 *   - reference.body = { <bodyKey>: rows }
 *   - compare 策略自动生成：
 *       unorderedKey（单字段业务键）→ 无序数组按 key 配对（行序无关）
 *       generatedFields（目标侧生成字段，如 id）→ `bodyKey[*].<field>` 形状
 *       断言 string——期望侧可省略该字段（脱敏语义与 testkit comparator 一致）
 *
 * 零依赖取舍：不 import @smes/testkit（deploy 不在 workspace）——格式串与
 * 策略形状按 packages/testkit/src/fixtures/types.ts 对齐，导出文件由 testkit
 * 的 loadFixtureFile 校验/加载（单测实证）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECONCILE_FIXTURE_FORMAT = 'smes.reconcile-fixture@1';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 导出一个 dataset 的夹具文件。
 *
 * @param {object} options
 * @param {string} options.dir 输出目录（自动创建）
 * @param {string} options.dataset dataset 名（场景名 migration-<dataset>）
 * @param {ReadonlyArray<Record<string, unknown>>} options.rows 快照行
 * @param {string} [options.scenarioPath] 读回请求路径（缺省 /masterdata/<dataset>）
 * @param {string} [options.bodyKey] body 包装键（缺省 = dataset 名）
 * @param {string|null} [options.unorderedKey] 无序比对键（单字段业务键；null = 有序比对）
 * @param {ReadonlyArray<string>} [options.generatedFields] 目标侧生成字段（shape: string）
 * @param {string} [options.recordedFrom] 来源标注
 * @param {string} [options.recordedAt] ISO 时间戳（缺省当前时刻）
 * @param {string} [options.description] 场景说明
 * @returns {string} 写出的文件绝对路径
 */
export function exportDatasetFixtures({
  dir,
  dataset,
  rows,
  scenarioPath,
  bodyKey,
  unorderedKey = null,
  generatedFields = [],
  recordedFrom = 'migration-export',
  recordedAt,
  description,
}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('exportDatasetFixtures：dir 必填');
  if (typeof dataset !== 'string' || dataset.length === 0) throw new Error('exportDatasetFixtures：dataset 必填');
  if (!Array.isArray(rows)) throw new Error('exportDatasetFixtures：rows 必须是数组');
  for (const row of rows) {
    if (!isPlainObject(row)) {
      throw new Error(`exportDatasetFixtures：${dataset} 的行必须是对象（得到 ${JSON.stringify(row)}）`);
    }
    for (const [field, value] of Object.entries(row)) {
      if (value !== null && typeof value === 'object') {
        throw new Error(
          `exportDatasetFixtures：${dataset} 行字段 '${field}' 非标量（夹具 body 只接受平面对象行）`,
        );
      }
    }
  }
  const key = bodyKey ?? dataset;
  const ordered = unorderedKey
    ? [...rows].sort((a, b) => String(a[unorderedKey]).localeCompare(String(b[unorderedKey])))
    : [...rows];
  const fixture = {
    format: RECONCILE_FIXTURE_FORMAT,
    scenario: {
      name: `migration-${dataset}`,
      ...(description === undefined ? {} : { description }),
      input: { method: 'GET', path: scenarioPath ?? `/masterdata/${dataset}` },
    },
    reference: {
      status: 200,
      body: { [key]: ordered },
      recordedAt: recordedAt ?? new Date().toISOString(),
      recordedFrom,
    },
    compare: {
      ...(unorderedKey
        ? { arrays: { [key]: { match: 'unordered', key: unorderedKey } } }
        : {}),
      ...(generatedFields.length > 0
        ? {
            shape: Object.fromEntries(
              generatedFields.map((field) => [`${key}[*].${field}`, 'string']),
            ),
          }
        : {}),
    },
  };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${dataset}.reconcile.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return file;
}
