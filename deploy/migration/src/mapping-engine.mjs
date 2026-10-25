/**
 * 映射引擎——FieldMapping 配置 → 行变换器（纯函数，本工具的核心件）。
 *
 * 映射文件形状（运行时配置，`--mapping <file>`）：
 *
 *   {
 *     "format": "smes.migration-mapping@1",
 *     "datasets": {
 *       "items": {                                  // 键 = 源描述符的 dataset 名
 *         "businessKey": ["code"],                  // 业务键（目标 upsert 判重键，可复合）
 *         "fields": [
 *           { "to": "tenant", "constant": "tenant-alpha" },          // 常量注入
 *           { "to": "code",   "from": "code",  "type": "string", "required": true },
 *           { "to": "name",   "from": "label", "type": "string", "required": true },
 *           { "to": "unit",   "from": "uom",   "type": "string", "default": "件" },
 *           { "to": "price",  "from": "price", "type": "number" },
 *           { "to": "active", "from": "enabled", "type": "boolean", "default": true },
 *           { "to": "listedAt", "from": "listed", "type": "date" }
 *         ]
 *       }
 *     }
 *   }
 *
 * 规则语义（field rule）：
 *   - to：目标字段名（dataset 内唯一；businessKey 各键必须出现在某个 to）
 *   - from | constant：二选一。constant = 每行注入常量（如租户标识）；
 *     constant 规则的值域 = JSON 标量
 *   - type：string | number | boolean | date（缺省 string）
 *       string  → trim 后的字符串（number/boolean 原值转串）
 *       number  → 有限数（拒 NaN/Infinity；拒 boolean；字符串按 Number 语义）
 *       boolean → true/false、1/0、true/false/yes/no/on/off/y/n（大小写不敏感）
 *       date    → Date.parse 可解析的串，规范化为 ISO-8601 UTC 串
 *                 （拒 number/boolean——epoch 语义含混，需接入期显式约定）
 *   - required：true = 空（缺失/null/纯空白串）即该行失败；业务键字段隐含
 *     required（键为空无法 upsert）
 *   - default：空且非必填时取默认值（JSON 标量，不再过类型转换）；无默认 → null
 *
 * 双模式（pipeline 层语义，引擎只产出结果不决策）：
 *   - report 模式：行失败收集进报告，整批继续
 *   - strict 模式：首错即抛 StrictModeAbort 中止整批
 *
 * 纯函数：compileDatasetMapping 只做配置校验与预编译（含缺列 fail-fast），
 * transformRow 无副作用、无 IO——单测直接断言语义。
 */
import { readFileSync } from 'node:fs';
import { ConfigError } from './source-port.mjs';

export const MAPPING_FORMAT = 'smes.migration-mapping@1';
export const FIELD_TYPES = ['string', 'number', 'boolean', 'date'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value) {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** 加载映射文件（通用形状校验；dataset 级缺列校验在编译期做——需要描述符）。 */
export function loadMappingFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${filePath}：JSON 解析失败：${error.message}`);
  }
  if (!isPlainObject(raw) || raw.format !== MAPPING_FORMAT) {
    throw new ConfigError(`${filePath}：format 必须是 '${MAPPING_FORMAT}'`);
  }
  if (!isPlainObject(raw.datasets) || Object.keys(raw.datasets).length === 0) {
    throw new ConfigError(`${filePath}：datasets 必须是非空对象（键 = dataset 名）`);
  }
  for (const [name, entry] of Object.entries(raw.datasets)) {
    if (!isPlainObject(entry)) {
      throw new ConfigError(`${filePath}：datasets['${name}'] 必须是对象`);
    }
    if (!Array.isArray(entry.businessKey) || entry.businessKey.length === 0) {
      throw new ConfigError(`${filePath}：datasets['${name}'].businessKey 必须是非空数组`);
    }
    if (!Array.isArray(entry.fields) || entry.fields.length === 0) {
      throw new ConfigError(`${filePath}：datasets['${name}'].fields 必须是非空数组`);
    }
  }
  return { file: filePath, datasets: raw.datasets };
}

/**
 * 编译单个 dataset 的映射（配置错误全部 fail-fast ConfigError，迁移零行前报出）。
 * @param {object} mappingEntry datasets[name] 的值
 * @param {{name:string, columns:ReadonlyArray<{name:string}>}} datasetEntry 源描述符条目
 */
export function compileDatasetMapping(mappingEntry, datasetEntry, context = '') {
  const where = context === '' ? '' : `${context}：`;
  const sourceColumns = new Set(datasetEntry.columns.map((c) => c.name));
  const businessKey = [...mappingEntry.businessKey];
  for (const key of businessKey) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new ConfigError(`${where}businessKey 含非法键名 ${JSON.stringify(key)}`);
    }
  }
  const rules = [];
  const seenTo = new Set();
  const errors = [];
  for (const [index, rule] of mappingEntry.fields.entries()) {
    if (!isPlainObject(rule)) {
      throw new ConfigError(`${where}fields[${index}] 必须是对象`);
    }
    if (typeof rule.to !== 'string' || rule.to.trim().length === 0) {
      throw new ConfigError(`${where}fields[${index}].to 必须是非空字符串`);
    }
    if (seenTo.has(rule.to)) {
      throw new ConfigError(`${where}目标字段 '${rule.to}' 重复声明`);
    }
    seenTo.add(rule.to);
    const hasFrom = rule.from !== undefined;
    const hasConstant = 'constant' in rule;
    if (hasFrom === hasConstant) {
      throw new ConfigError(`${where}fields[${index}]（to='${rule.to}'）：from 与 constant 必须二选一`);
    }
    if (hasConstant && !isScalar(rule.constant)) {
      throw new ConfigError(`${where}fields[${index}]（to='${rule.to}'）：constant 必须是 JSON 标量`);
    }
    if (hasFrom && typeof rule.from !== 'string') {
      throw new ConfigError(`${where}fields[${index}]（to='${rule.to}'）：from 必须是字符串`);
    }
    if (rule.type !== undefined && !FIELD_TYPES.includes(rule.type)) {
      throw new ConfigError(
        `${where}fields[${index}]（to='${rule.to}'）：type 必须是 ${FIELD_TYPES.join('/')}`,
      );
    }
    if (rule.default !== undefined && !isScalar(rule.default)) {
      throw new ConfigError(`${where}fields[${index}]（to='${rule.to}'）：default 必须是 JSON 标量`);
    }
    if (rule.required !== undefined && typeof rule.required !== 'boolean') {
      throw new ConfigError(`${where}fields[${index}]（to='${rule.to}'）：required 必须是布尔`);
    }
    if (hasFrom && !sourceColumns.has(rule.from)) {
      errors.push(`目标字段 '${rule.to}' 引用源列 '${rule.from}' 不在 dataset '${datasetEntry.name}' 列声明中`);
    }
    rules.push({
      to: rule.to,
      from: hasFrom ? rule.from : null,
      constant: hasConstant ? rule.constant : undefined,
      type: rule.type ?? 'string',
      // 业务键字段隐含必填（键为空无法 upsert）
      required: rule.required === true || businessKey.includes(rule.to),
      default: rule.default,
      isConstant: hasConstant,
    });
  }
  if (errors.length > 0) {
    // 缺列 fail-fast：列出全部缺失引用（一次报全，不来回试）
    throw new ConfigError(`${where}映射引用了不存在的源列——${errors.join('；')}`);
  }
  const missingKeys = businessKey.filter((key) => !seenTo.has(key));
  if (missingKeys.length > 0) {
    throw new ConfigError(
      `${where}businessKey 字段 [${missingKeys.join(', ')}] 未出现在任何 fields[].to 中（键值必须随行产出）`,
    );
  }
  return { dataset: datasetEntry.name, businessKey, rules };
}

// ---- 类型转换（值语义见文件头） ----

function convertToString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return { error: `无法转换为 string：${JSON.stringify(value)}` };
}

function convertToNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { error: `非有限数：${String(value)}` };
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return { error: '空串（空值应在上游走 default/null 路径）' };
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      return { error: `无法转换为 number：'${trimmed}'` };
    }
    return parsed;
  }
  return { error: `无法转换为 number：${JSON.stringify(value)}` };
}

const TRUTHY = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY = new Set(['false', '0', 'no', 'n', 'off']);

function convertToBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return { error: `无法转换为 boolean：数字 ${value}（仅 1/0）` };
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    return { error: `无法转换为 boolean：'${value.trim()}'` };
  }
  return { error: `无法转换为 boolean：${JSON.stringify(value)}` };
}

function convertToDate(value) {
  if (typeof value !== 'string') {
    return { error: `无法转换为 date：${JSON.stringify(value)}（仅接受可解析的日期时间串）` };
  }
  const trimmed = value.trim();
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return { error: `无法转换为 date：'${trimmed}'` };
  }
  return new Date(ms).toISOString();
}

const CONVERTERS = {
  string: convertToString,
  number: convertToNumber,
  boolean: convertToBoolean,
  date: convertToDate,
};

/** 空值判定：缺失 / null / 纯空白串（number 0、boolean false 不是空）。 */
function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

/**
 * 行变换（纯函数）。
 * @returns {{ ok:true, value:object, key:object, stats:Record<string,object> }
 *          | { ok:false, errors:ReadonlyArray<{field:string|null, message:string}> }}
 */
export function transformRow(compiled, row) {
  const value = {};
  const stats = {};
  const errors = [];
  for (const rule of compiled.rules) {
    const stat = (stats[rule.to] ??= { converted: 0, constant: 0, default: 0, emptyToNull: 0 });
    if (rule.isConstant) {
      value[rule.to] = rule.constant;
      stat.constant += 1;
      continue;
    }
    const raw = row.cells?.[rule.from];
    if (isEmptyValue(raw)) {
      if (rule.required) {
        errors.push({
          field: rule.to,
          message: `必填字段为空（源列 '${rule.from}'）`,
        });
        continue;
      }
      if (rule.default !== undefined) {
        value[rule.to] = rule.default;
        stat.default += 1;
      } else {
        value[rule.to] = null;
        stat.emptyToNull += 1;
      }
      continue;
    }
    const converted = CONVERTERS[rule.type](raw);
    if (converted !== null && typeof converted === 'object' && 'error' in converted) {
      errors.push({ field: rule.to, message: converted.error });
      continue;
    }
    value[rule.to] = converted;
    stat.converted += 1;
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const key = {};
  for (const keyField of compiled.businessKey) {
    const keyValue = value[keyField];
    if (keyValue === null || keyValue === undefined) {
      return {
        ok: false,
        errors: [{ field: keyField, message: '业务键字段为空（无法 upsert）' }],
      };
    }
    key[keyField] = keyValue;
  }
  return { ok: true, value, key, stats };
}
