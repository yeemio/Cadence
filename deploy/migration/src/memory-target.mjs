/**
 * InMemoryTarget + DryRunTarget——MigrationTarget 端口的两个内置实现。
 *
 * InMemoryTarget（测试/示例/dry-run 对照用）：
 *   - 每 dataset 一张 Map，键 = 业务键的规范化序列化（键序无关）
 *   - options.idField + options.generateId：模拟"目标侧生成代理键"的写入面
 *     （如主数据表的 id）——插入时生成，更新时**保留原 id**（与期望态更新
 *     语义一致）；缺省不生成（纯透传，通用机制不带主数据假设）
 *   - snapshot 按 Map 迭代序（= 首次插入序）返回行副本
 *
 * DryRunTarget：只记 inserted/updated 计数与键集合，不存行（快照返回 []）。
 * 与 InMemoryTarget 分开实现而非"memory 加开关"——dry-run 的合同就是**不
 * 持久化**，合并会把"少存一份"做成默认可错路径。
 */
import { randomUUID } from 'node:crypto';

/** 业务键 → 稳定串（键名排序后序列化，与键序无关）。 */
export function canonicalKey(key) {
  const sorted = {};
  for (const name of Object.keys(key).sort()) {
    sorted[name] = key[name];
  }
  return JSON.stringify(sorted);
}

export class InMemoryTarget {
  /**
   * @param {object} [options]
   * @param {string} [options.idField] 代理键字段名（如 'id'）
   * @param {() => string} [options.generateId] 代理键生成器（缺省 crypto.randomUUID）
   */
  constructor(options = {}) {
    this.name = 'memory';
    this.idField = options.idField ?? null;
    this.generateId = options.generateId ?? randomUUID;
    this._datasets = new Map(); // dataset → Map<canonicalKey, row>
  }

  async upsert(dataset, key, row) {
    let table = this._datasets.get(dataset);
    if (table === undefined) {
      table = new Map();
      this._datasets.set(dataset, table);
    }
    const existing = table.get(canonicalKey(key));
    if (existing === undefined) {
      const inserted =
        this.idField !== null ? { ...row, [this.idField]: this.generateId() } : { ...row };
      table.set(canonicalKey(key), inserted);
      return { action: 'inserted' };
    }
    const updated =
      this.idField !== null
        ? { ...row, [this.idField]: existing[this.idField] } // 更新保留代理键
        : { ...row };
    table.set(canonicalKey(key), updated);
    return { action: 'updated' };
  }

  async snapshot(dataset) {
    const table = this._datasets.get(dataset);
    if (table === undefined) return [];
    return [...table.values()].map((row) => ({ ...row }));
  }
}

export class DryRunTarget {
  constructor() {
    this.name = 'dry-run';
    this._keys = new Map(); // dataset → Map<canonicalKey, true>
  }

  async upsert(dataset, key) {
    let table = this._keys.get(dataset);
    if (table === undefined) {
      table = new Map();
      this._keys.set(dataset, table);
    }
    const existing = table.has(canonicalKey(key));
    table.set(canonicalKey(key), true);
    return { action: existing ? 'updated' : 'inserted' };
  }

  async snapshot() {
    return [];
  }
}
