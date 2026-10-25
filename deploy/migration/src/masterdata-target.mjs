/**
 * MasterdataTarget——主数据目标适配器**形状**（对齐 business-store masterdata 端口）。
 *
 * 零依赖取舍（合同）：deploy/migration 不入 pnpm workspace，不能 import
 * @smes/business-store——本适配器用**鸭子类型**对齐
 * packages/application/src/masterdata/masterdata-stores.ts 的 ItemStore /
 * ResourceStore 端口子集（create / list / update），真实连接由**接入期组合**：
 *
 *   接入期调用示例（在 apps/server 或一次性脚本里，那里有 workspace 解析）：
 *
 *     import { connectMasterdataStore } from '@smes/business-store/masterdata';
 *     import { TenantId } from '@smes/business-core';
 *     import { MasterdataTarget } from '<相对路径>/deploy/migration/src/masterdata-target.mjs';
 *
 *     const handle = connectMasterdataStore({ datasourceUrl: process.env.DATABASE_URL });
 *     const target = new MasterdataTarget({
 *       stores: { items: handle.itemStore, resources: handle.resourceStore },
 *       toTenantId: TenantId.create,          // 行内 tenant 串 → TenantId 值对象
 *     });
 *     // …迁移 pipeline 照常：upsert('items', { code }, row)…
 *     await handle.disconnect();
 *
 *     RLS 注意（deploy/README 威胁模型）：SMES_RLS_SESSION=on 时无请求上下文的
 *     迁移进程需经 runWithRlsTenant 包裹（或用 superuser 形态跑批）——接入期定夺。
 *
 * 端口对齐子集（鸭子形状，字段缺一即接入期组装报错）：
 *
 *   ItemStoreLike = {
 *     create(input: { tenant, code, name, spec?, unit?, category?, active? })
 *       → Promise<{ code, name, spec, unit, category, active, … }>;
 *     list(tenant) → Promise<ReadonlyArray<{ code, … }>>;
 *     update(tenant, id, input) → Promise<row | null>;
 *   }
 *   ResourceStoreLike：字段集为 { tenant, code, name, type?, active? }
 *
 * 已知边界（写明，接入期优化项）：
 *   - upsert 判重走 list(tenant) 全量 + code 匹配——O(n)/行；接入期应给端口
 *     补 findByCode(tenant, code)（或批量 upsert），本适配器换一个方法即可
 *   - 期望态语义：行内**出现的**字段全量下发（null = 显式清空，对齐
 *     UpdateInput 的字段级期望态）；行内未出现的字段不动
 *   - 目标侧约束（code 形状、名称长度等）由 masterdata 输入校验层把关，
 *     违规抛错 → pipeline 行级失败进报告（双模式语义不在此重复）
 */

/** 各 dataset 的目标字段投影（行内出现才下发）。 */
const DATASET_FIELDS = {
  items: ['name', 'spec', 'unit', 'category', 'active'],
  resources: ['name', 'type', 'active'],
};

export class MasterdataTarget {
  /**
   * @param {object} options
   * @param {{ items?: object, resources?: object }} options.stores 鸭子形状的主数据存储
   * @param {(tenant: string) => unknown} [options.toTenantId] 行内 tenant 串 → 端口租户值对象
   *        （接入期传 TenantId.create；缺省恒等——纯数据面测试/内存实现直用）
   */
  constructor({ stores, toTenantId }) {
    if (stores === null || typeof stores !== 'object') {
      throw new Error('MasterdataTarget：stores 必须是 { items?, resources? } 形状');
    }
    if (Object.keys(stores).length === 0) {
      throw new Error('MasterdataTarget：stores 至少要声明一个 dataset（items/resources）——空目标无写入面');
    }
    for (const [name, store] of Object.entries(stores)) {
      if (DATASET_FIELDS[name] === undefined) {
        throw new Error(`MasterdataTarget：未知主数据 dataset '${name}'（items/resources）`);
      }
      for (const method of ['create', 'list', 'update']) {
        if (typeof store?.[method] !== 'function') {
          throw new Error(
            `MasterdataTarget：stores.${name} 缺 ${method}()——端口形状对齐失败（见文件头鸭子合同）`,
          );
        }
      }
    }
    this.name = 'masterdata';
    this.stores = stores;
    this.toTenantId = toTenantId ?? ((tenant) => tenant);
  }

  async upsert(dataset, key, row) {
    const store = this.stores[dataset];
    if (store === undefined) {
      throw new Error(`主数据目标未声明 dataset '${dataset}'（已声明：${Object.keys(this.stores).join(', ')}）`);
    }
    if (typeof row.tenant !== 'string' || row.tenant === '') {
      throw new Error(`${dataset}：行缺 tenant 字段（映射需注入租户常量）`);
    }
    if (key.code === undefined) {
      throw new Error(`${dataset}：主数据业务键必须是 code（得到 ${JSON.stringify(key)}）`);
    }
    const tenant = this.toTenantId(row.tenant);
    // 投影：行内出现的目标字段才下发（期望态；未出现不动）
    const present = (names) =>
      Object.fromEntries(names.filter((f) => f in row).map((f) => [f, row[f]]));
    const existing = (await store.list(tenant)).find((candidate) => candidate.code === key.code);
    if (existing === undefined) {
      await store.create({ tenant, code: key.code, name: row.name, ...present(DATASET_FIELDS[dataset]) });
      return { action: 'inserted' };
    }
    await store.update(tenant, existing.id, present(DATASET_FIELDS[dataset]));
    return { action: 'updated' };
  }

  /** 对账导出面（按租户列出——filter.tenant 必填）。 */
  async snapshot(dataset, filter) {
    const store = this.stores[dataset];
    if (store === undefined) {
      throw new Error(`主数据目标未声明 dataset '${dataset}'`);
    }
    if (typeof filter?.tenant !== 'string') {
      throw new Error(`${dataset}：主数据快照需 filter.tenant（按租户列出）`);
    }
    return store.list(this.toTenantId(filter.tenant));
  }
}
