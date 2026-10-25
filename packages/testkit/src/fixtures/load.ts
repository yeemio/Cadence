/**
 * 夹具文件校验（fail-fast）+ 目录加载。
 *
 * 坏夹具（非法 JSON / 未知键 / 非法值 / 场景重名）在加载期整体失败并报
 * 文件路径与原因——绝不让格式错误的夹具进入对账运行（否则失败会被误读为
 * 行为差异）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ReconcileFixture, TargetRequest } from '../types.js';
import {
  FIXTURE_FILE_SUFFIX,
  FIXTURE_FORMAT,
  HTTP_METHODS,
  SHAPE_TYPE_NAMES,
  type FixtureFileShape,
  type ShapeTypeName,
} from './types.js';

export class FixtureValidationError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'FixtureValidationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, file: string, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new FixtureValidationError(file, `${where} 必须是对象`);
  }
  return value;
}

function requireExactKeys(
  obj: Record<string, unknown>,
  file: string,
  where: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new FixtureValidationError(file, `${where} 含未知键 '${key}'（允许：${[...allowed].join(', ')}）`);
    }
  }
  for (const key of required) {
    if (!(key in obj)) {
      throw new FixtureValidationError(file, `${where} 缺必填键 '${key}'`);
    }
  }
}

function requireNonEmptyString(value: unknown, file: string, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FixtureValidationError(file, `${where} 必须是非空字符串`);
  }
  return value;
}

/**
 * ISO 8601 完整时间戳形状 + 可解析。max-age 门禁按 Date.parse(recordedAt)
 * 判龄：垃圾串解析为 NaN 时比较恒 false，会静默绕过门禁——所以在加载期
 * fail-fast 拒绝，而非信任运行期比较。
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireIsoTimestamp(value: unknown, file: string, where: string): string {
  const text = requireNonEmptyString(value, file, where);
  if (!ISO_TIMESTAMP_PATTERN.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new FixtureValidationError(
      file,
      `${where} 必须是合法 ISO 8601 时间戳（如 2026-01-02T03:04:05.000Z），实际 '${text}'`,
    );
  }
  return text;
}

function requireNonNegativeNumber(value: unknown, file: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new FixtureValidationError(file, `${where} 必须是 >= 0 的有限数`);
  }
  return value;
}

/** 校验单个夹具文件的解析结果（raw 来自 JSON.parse）；坏形状抛 FixtureValidationError。 */
export function validateFixtureShape(file: string, raw: unknown): FixtureFileShape {
  const root = requireObject(raw, file, '根');
  requireExactKeys(root, file, '根', ['format', 'scenario', 'reference'], ['compare']);
  if (root['format'] !== FIXTURE_FORMAT) {
    throw new FixtureValidationError(file, `format 必须是 '${FIXTURE_FORMAT}'，实际 ${JSON.stringify(root['format'])}`);
  }

  const scenario = requireObject(root['scenario'], file, 'scenario');
  requireExactKeys(scenario, file, 'scenario', ['name', 'input'], ['description']);
  requireNonEmptyString(scenario['name'], file, 'scenario.name');
  if ('description' in scenario && scenario['description'] !== undefined) {
    requireNonEmptyString(scenario['description'], file, 'scenario.description');
  }

  const input = requireObject(scenario['input'], file, 'scenario.input');
  requireExactKeys(input, file, 'scenario.input', ['method', 'path'], ['query', 'headers', 'body']);
  const method = requireNonEmptyString(input['method'], file, 'scenario.input.method');
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new FixtureValidationError(file, `scenario.input.method 必须是 ${HTTP_METHODS.join('/')}，实际 '${method}'`);
  }
  const path = requireNonEmptyString(input['path'], file, 'scenario.input.path');
  if (path.startsWith('//')) {
    // 协议相对转向：new URL('//host/x', base) 会离开目标基址指向其他主机
    throw new FixtureValidationError(
      file,
      `scenario.input.path 不得以 '//' 开头（协议相对写法会转向其他主机），实际 '${path}'`,
    );
  }
  if (!path.startsWith('/')) {
    throw new FixtureValidationError(file, `scenario.input.path 必须以 '/' 开头，实际 '${path}'`);
  }
  if ('query' in input && input['query'] !== undefined) {
    const query = requireObject(input['query'], file, 'scenario.input.query');
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new FixtureValidationError(file, `scenario.input.query.${key} 必须是 string/number/boolean`);
      }
    }
  }
  if ('headers' in input && input['headers'] !== undefined) {
    const headers = requireObject(input['headers'], file, 'scenario.input.headers');
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new FixtureValidationError(file, `scenario.input.headers.${key} 必须是 string`);
      }
    }
  }

  let reference: FixtureFileShape['reference'] = null;
  if (root['reference'] !== null) {
    const ref = requireObject(root['reference'], file, 'reference');
    requireExactKeys(ref, file, 'reference', ['status', 'body'], ['recordedAt', 'recordedFrom']);
    const status = ref['status'];
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new FixtureValidationError(file, `reference.status 必须是 100..599 的整数，实际 ${JSON.stringify(status)}`);
    }
    if ('recordedAt' in ref && ref['recordedAt'] !== undefined) {
      requireIsoTimestamp(ref['recordedAt'], file, 'reference.recordedAt');
    }
    if ('recordedFrom' in ref && ref['recordedFrom'] !== undefined) {
      requireNonEmptyString(ref['recordedFrom'], file, 'reference.recordedFrom');
    }
    reference = ref as unknown as FixtureFileShape['reference'];
  }

  if ('compare' in root && root['compare'] !== undefined) {
    const compare = requireObject(root['compare'], file, 'compare');
    requireExactKeys(
      compare,
      file,
      'compare',
      [],
      ['tolerance', 'ignore', 'shape', 'arrays', 'timestamps'],
    );
    if ('tolerance' in compare && compare['tolerance'] !== undefined) {
      const tolerance = requireObject(compare['tolerance'], file, 'compare.tolerance');
      requireExactKeys(tolerance, file, 'compare.tolerance', [], ['numeric']);
      if ('numeric' in tolerance && tolerance['numeric'] !== undefined) {
        const numeric = requireObject(tolerance['numeric'], file, 'compare.tolerance.numeric');
        requireExactKeys(numeric, file, 'compare.tolerance.numeric', [], ['relative', 'absolute']);
        for (const key of ['relative', 'absolute'] as const) {
          if (key in numeric && numeric[key] !== undefined) {
            requireNonNegativeNumber(numeric[key], file, `compare.tolerance.numeric.${key}`);
          }
        }
      }
    }
    if ('ignore' in compare && compare['ignore'] !== undefined) {
      if (!Array.isArray(compare['ignore'])) {
        throw new FixtureValidationError(file, 'compare.ignore 必须是字符串数组');
      }
      compare['ignore'].forEach((pattern, index) => {
        requireNonEmptyString(pattern, file, `compare.ignore[${index}]`);
      });
    }
    if ('shape' in compare && compare['shape'] !== undefined) {
      const shape = requireObject(compare['shape'], file, 'compare.shape');
      for (const [key, typeName] of Object.entries(shape)) {
        if (!(SHAPE_TYPE_NAMES as readonly string[]).includes(typeName as string)) {
          throw new FixtureValidationError(
            file,
            `compare.shape.${key} 必须是 ${SHAPE_TYPE_NAMES.join('/')}，实际 ${JSON.stringify(typeName)}`,
          );
        }
      }
    }
    if ('arrays' in compare && compare['arrays'] !== undefined) {
      const arrays = requireObject(compare['arrays'], file, 'compare.arrays');
      for (const [key, rule] of Object.entries(arrays)) {
        const ruleObj = requireObject(rule, file, `compare.arrays.${key}`);
        requireExactKeys(ruleObj, file, `compare.arrays.${key}`, ['match'], ['key']);
        if (ruleObj['match'] !== 'ordered' && ruleObj['match'] !== 'unordered') {
          throw new FixtureValidationError(
            file,
            `compare.arrays.${key}.match 必须是 ordered/unordered，实际 ${JSON.stringify(ruleObj['match'])}`,
          );
        }
        if ('key' in ruleObj && ruleObj['key'] !== undefined) {
          requireNonEmptyString(ruleObj['key'], file, `compare.arrays.${key}.key`);
        }
      }
    }
    if ('timestamps' in compare && compare['timestamps'] !== undefined) {
      const timestamps = requireObject(compare['timestamps'], file, 'compare.timestamps');
      requireExactKeys(timestamps, file, 'compare.timestamps', [], ['toleranceMs']);
      if ('toleranceMs' in timestamps && timestamps['toleranceMs'] !== undefined) {
        requireNonNegativeNumber(timestamps['toleranceMs'], file, 'compare.timestamps.toleranceMs');
      }
    }
  }

  return root as unknown as FixtureFileShape;
}

/** 读单个夹具文件 → ReconcileFixture。 */
export function loadFixtureFile(file: string): ReconcileFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new FixtureValidationError(file, `JSON 解析失败：${(error as Error).message}`);
  }
  const shape = validateFixtureShape(file, raw);
  const input: TargetRequest = {
    method: shape.scenario.input.method,
    path: shape.scenario.input.path,
    ...(shape.scenario.input.query === undefined ? {} : { query: shape.scenario.input.query }),
    ...(shape.scenario.input.headers === undefined ? {} : { headers: shape.scenario.input.headers }),
    ...('body' in shape.scenario.input && shape.scenario.input.body !== undefined
      ? { body: shape.scenario.input.body }
      : {}),
  };
  return {
    file,
    scenarioName: shape.scenario.name,
    ...(shape.scenario.description === undefined ? {} : { description: shape.scenario.description }),
    input,
    reference:
      shape.reference === null
        ? null
        : { status: shape.reference.status, body: shape.reference.body },
    strategy: shape.compare ?? {},
    recordedAt: shape.reference?.recordedAt ?? null,
    recordedFrom: shape.reference?.recordedFrom ?? null,
  };
}

/** 加载目录下全部 *.reconcile.json（按场景名排序；重名 fail-fast）。 */
export function loadFixtureDir(dir: string): readonly ReconcileFixture[] {
  const absoluteDir = isAbsolute(dir) ? dir : resolve(dir);
  let entries: readonly string[];
  try {
    entries = readdirSync(absoluteDir);
  } catch (error) {
    throw new FixtureValidationError(absoluteDir, `目录读取失败：${(error as Error).message}`);
  }
  const files = entries
    .filter((name) => name.endsWith(FIXTURE_FILE_SUFFIX))
    .sort()
    .map((name) => join(absoluteDir, name));
  if (files.length === 0) {
    throw new FixtureValidationError(absoluteDir, `目录下无 '${FIXTURE_FILE_SUFFIX}' 夹具文件`);
  }
  const fixtures: ReconcileFixture[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const fixture = loadFixtureFile(file);
    const previous = seen.get(fixture.scenarioName);
    if (previous !== undefined) {
      throw new FixtureValidationError(
        file,
        `场景名 '${fixture.scenarioName}' 与 ${previous} 重复（场景名必须全局唯一）`,
      );
    }
    seen.set(fixture.scenarioName, file);
    fixtures.push(fixture);
  }
  return fixtures.sort((a, b) => a.scenarioName.localeCompare(b.scenarioName));
}
