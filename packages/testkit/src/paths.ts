/**
 * 路径表示与模式匹配（比对器与录制脱敏共用的底层件）。
 *
 * 路径渲染约定：对象键以 '.' 相连，数组索引用 '[n]' 挂在前一段上，
 * 例：`a.b[2].c`。根路径渲染为空串 ''。
 *
 * 模式（glob）语义——写给夹具作者的可预测子集：
 *   - 精确路径：`token`、`user.displayName`
 *   - `*`：段内通配，匹配任意不含 '.' 的字符（含数组索引段，例 `a.*` 匹配 `a.b[0]`）
 *   - `[n]`：精确数组索引；`[*]`：任意索引（例 `bySource[*].source`）
 *   - `**`：任意长度任意段（例 `meta.**`、`**`）
 */

/** 路径段：对象键（string）或数组索引（number）。 */
export type PathSegment = string | number;

/** 把段序列渲染成 `a.b[2].c` 形式。 */
export function renderPath(segments: readonly PathSegment[]): string {
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out.length === 0 ? segment : `.${segment}`;
    }
  }
  return out;
}

const REGEX_SPECIAL = new Set(['\\', '^', '$', '.', '|', '?', '+', '(', ')', '[', ']', '{', '}']);
const patternCache = new Map<string, RegExp>();

/** 解析渲染路径 `a.b[2].c` → 段序列 ['a','b',2,'c']（renderPath 的逆）。 */
export function parsePath(path: string): PathSegment[] {
  if (path === '') {
    return [];
  }
  const segments: PathSegment[] = [];
  for (const part of path.split('.')) {
    const match = part.match(/^(.*?)((?:\[\d+\])*)$/);
    const key = match?.[1] ?? part;
    const indexRuns = match?.[2] ?? '';
    if (key.length > 0) {
      segments.push(key);
    }
    for (const indexMatch of indexRuns.matchAll(/\[(\d+)\]/g)) {
      segments.push(Number(indexMatch[1] as string));
    }
  }
  return segments;
}

/** 值沿段序列可达且非 undefined（JSON 值域内 = 字段存在）。 */
export function hasPath(value: unknown, segments: readonly PathSegment[]): boolean {
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        return false;
      }
      current = current[segment];
    } else {
      if (!isPlainObject(current) || !(segment in current)) {
        return false;
      }
      current = current[segment];
    }
    if (current === undefined) {
      return false;
    }
  }
  return true;
}

/** 把 glob 模式编译为整串匹配的 RegExp（带缓存）。 */
export function patternToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^.]*';
      }
    } else if (REGEX_SPECIAL.has(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  const regexp = new RegExp(`${source}$`);
  patternCache.set(pattern, regexp);
  return regexp;
}

/** 渲染后的路径是否命中某个 glob 模式。 */
export function pathMatches(path: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(path);
}

/** 路径是否命中模式集中的任一条。 */
export function pathMatchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pathMatches(path, pattern));
}

/** 普通对象（非 null 非数组）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规范化序列化：对象键按字典序排序后 JSON.stringify。
 * 用于无序数组的原始值多集合匹配（键序不参与相等判定）。
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeForCanonical(value));
}

function normalizeForCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonical(item));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalizeForCanonical(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 按模式集从 JSON 值中删除命中的路径（录制脱敏用；返回新对象，不改入参）。
 * 入参来自 JSON.parse（值域不含 undefined），因此内部以 undefined 作删除标记。
 */
export function omitPaths<T>(value: T, patterns: readonly string[]): T {
  if (patterns.length === 0) {
    return value;
  }
  return omitWalk(value, patterns, '') as T;
}

function omitWalk(value: unknown, patterns: readonly string[], path: string): unknown {
  if (path !== '' && pathMatchesAny(path, patterns)) {
    return undefined; // 删除标记（对象键层剔除 / 数组元素层剔除）
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const child = omitWalk(value[i], patterns, path === '' ? `[${i}]` : `${path}[${i}]`);
      if (child !== undefined) {
        kept.push(child);
      }
    }
    return kept;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      if (pathMatchesAny(keyPath, patterns)) {
        continue;
      }
      const replaced = omitWalk(child, patterns, keyPath);
      if (replaced !== undefined) {
        out[key] = replaced;
      }
    }
    return out;
  }
  return value;
}
