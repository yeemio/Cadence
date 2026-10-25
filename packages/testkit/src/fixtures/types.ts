/**
 * 对账夹具文件格式（v1）：一个 `*.reconcile.json` 文件 = 一个场景。
 *
 * {
 *   "format": "smes.reconcile-fixture@1",
 *   "scenario": {
 *     "name": "auth-login",                     // 场景名（全局唯一）
 *     "description": "可选说明",
 *     "input": {                                 // 同一份输入喂目标与参考源
 *       "method": "POST", "path": "/auth/login",
 *       "query": { "k": "v" },                   // 可选
 *       "headers": { "x": "y" },                 // 可选
 *       "body": { "username": "admin", ... }     // 可选（任意 JSON）
 *     }
 *   },
 *   "reference": {                               // 参考输出；null = 待录制
 *     "status": 200, "body": { ... },
 *     "recordedAt": "2026-10-25T08:00:00.000Z",  // 录制时间戳（防误提交过期参考）
 *     "recordedFrom": "http://localhost:3000"    // 录制目标（来源可追溯）
 *   },
 *   "compare": {                                 // 比对策略（见 comparator/strategy.ts）
 *     "tolerance": { "numeric": { "relative": 0.001, "absolute": 0.5 } },
 *     "ignore": ["token", "bySource[*].source"],
 *     "shape": { "expiresAt": "string" },
 *     "arrays": { "bySource": { "match": "unordered", "key": "source" } },
 *     "timestamps": { "toleranceMs": 60000 }
 *   }
 * }
 */

export const FIXTURE_FORMAT = 'smes.reconcile-fixture@1';

export const FIXTURE_FILE_SUFFIX = '.reconcile.json';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

export type FixtureHttpMethod = (typeof HTTP_METHODS)[number];

export type ShapeTypeName =
  | 'null'
  | 'boolean'
  | 'number'
  | 'integer'
  | 'string'
  | 'array'
  | 'object';

export const SHAPE_TYPE_NAMES: readonly ShapeTypeName[] = [
  'null',
  'boolean',
  'number',
  'integer',
  'string',
  'array',
  'object',
];

export interface FixtureFileShape {
  readonly format: typeof FIXTURE_FORMAT;
  readonly scenario: {
    readonly name: string;
    readonly description?: string;
    readonly input: {
      readonly method: FixtureHttpMethod;
      readonly path: string;
      readonly query?: Record<string, string | number | boolean>;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
    };
  };
  readonly reference:
    | null
    | {
        readonly status: number;
        readonly body: unknown;
        readonly recordedAt?: string;
        readonly recordedFrom?: string;
      };
  readonly compare?: {
    readonly tolerance?: {
      readonly numeric?: {
        readonly relative?: number;
        readonly absolute?: number;
      };
    };
    readonly ignore?: readonly string[];
    readonly shape?: Record<string, ShapeTypeName>;
    readonly arrays?: Record<string, { readonly match: 'ordered' | 'unordered'; readonly key?: string }>;
    readonly timestamps?: { readonly toleranceMs?: number };
  };
}
