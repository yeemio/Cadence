/**
 * listing 工序×原材料关联表存储端口（U4，S10——A5 项目成本 r11 原材料成本的
 * 取数源前置；生产购置清单开发文档 §1.3.4/1.2 重述，ADR-0010 词汇纪律）。
 *
 * 定位：零件清单行（listing_lines，对应原文 mes_purchase_part）的工序行挂
 * **N 条原材料关联行**（原文 mes_purchase_part_process_material：一工序 : N
 * 原材料，sort_order 区分行序）。本波只落数据面（关联 CRUD + 尺寸/单价快照
 * 录入值 + 数量），成本计算与下单/派工接线归后续波。
 *
 * 词汇重述（原文 → 本模块）：
 *   pruchase_part_id             → listingLineId（零件清单行 id——本模块聚合锚）
 *   purchase_part_process_id     → processId（**工序行 opaque 引用**——listing 域
 *                                  工序面尚未落库，调用方按后续工序面约定传入；
 *                                  同租户内一个 processId 只允许挂一个清单行，
 *                                  由 service 预检 + DB (tenant, processId) 组
 *                                  UNIQUE 守恒）
 *   raw_material_unit_price      → unitPriceMinor（**录入值快照**，分——合同裁定
 *                                  无取价源；原文由派工模块写入/清空，本波按合同
 *                                  改为下单侧录入）
 *   measure_type 1/2/3           → measureType 'length'|'volume'|'area'（由
 *                                  cutSizeForm 确定性派生，原文同口径）
 *   cut_size_form 1/2/3          → cutSizeForm 'length'|'length-width-height'|'area'
 *   cut_size_unit 1.mm/2.m²      → cutSizeUnit 'mm'|'m2'（由 cutSizeForm 派生）
 *   （合同列明）                 → quantity（数量/件数——原文表无此列，Cadence
 *                                  数据面为 A5 取数源补）
 *
 * 表形态取舍（运营投影，同 listing_sheets/listing_lines）：不套证据公共列、
 * 无行级乐观版本——关联集只有**整表替换**一个写面（replaceSet：事务内删旧
 * 插新；原文「整表覆盖写入 + 逻辑删除旧行」的 Cadence 重述，逻辑删除改硬删
 * ——本模块投影无 is_deleted 面），部分行更新不存在故不设 objectVersion。
 * 维护语义（原文 §三、8）：有选料按序写 N 行、同工序原材料不可重复、行序
 * 从 0 递增；「空列表不覆盖 / 已派工不改关联行」属于下单编排门禁，归接线波
 * （本端口空行集 = 显式清空该工序全部关联行）。
 */
import type { TenantId } from '@smes/business-core';

// ---- 下料尺寸词汇（字典 material_cut_size_form / material_cut_size_unit 重述） ----

/** 下料尺寸形式（原文字典 material_cut_size_form：1.长 2.长宽厚度 3.面积）。 */
export const CUT_SIZE_FORMS = ['length', 'length-width-height', 'area'] as const;

export type CutSizeForm = (typeof CUT_SIZE_FORMS)[number];

/** 计量方式（原文 measure_type：1.长度 2.体积 3.面积——由尺寸形式映射）。 */
export type ProcessMaterialMeasureType = 'length' | 'volume' | 'area';

/** 尺寸单位（原文 cut_size_unit：1.mm 2.m²——面积形式为 m²，其余 mm）。 */
export type CutSizeUnit = 'mm' | 'm2';

/** 尺寸形式 → 计量方式（确定性派生，原文「后端按形式计算为准」口径）。 */
export function measureTypeOfCutSizeForm(form: CutSizeForm): ProcessMaterialMeasureType {
  return form === 'length-width-height' ? 'volume' : form;
}

/** 尺寸形式 → 尺寸单位（面积形式 m²，长度/体积 mm）。 */
export function cutSizeUnitOfCutSizeForm(form: CutSizeForm): CutSizeUnit {
  return form === 'area' ? 'm2' : 'mm';
}

// ---- 关联行形状 ----

/** 工序×原材料关联行（一工序 N 行，sortOrder 0 起递增）。 */
export interface ProcessMaterialLink {
  /** ppm-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 零件清单行 id（聚合锚；原文 pruchase_part_id 冗余列的对应面）。 */
  readonly listingLineId: string;
  /** 工序行 opaque 引用（原文 purchase_part_process_id；工序面落库前由调用方约定）。 */
  readonly processId: string;
  /** 同一工序下原材料行序，从 0 递增（按 materials 数组顺序写）。 */
  readonly sortOrder: number;
  /** 原材料物料 id（items 主数据）。 */
  readonly rawMaterialId: string;
  /** 数量/件数（正整数；合同列明的数据面字段）。 */
  readonly quantity: number;
  /** 单价快照（分，整数精确；录入值无取价源；null = 未定价）。 */
  readonly unitPriceMinor: number | null;
  readonly measureType: ProcessMaterialMeasureType;
  /** 下料尺寸·长或面积值（>0，最多 2 位小数）。 */
  readonly partLength: number;
  /** 下料尺寸·宽（仅体积形式有值且 >0；长度/面积为 null）。 */
  readonly partWidth: number | null;
  /** 下料尺寸·厚（仅体积形式有值且 >0；长度/面积为 null）。 */
  readonly partHeight: number | null;
  readonly cutSizeForm: CutSizeForm;
  readonly cutSizeUnit: CutSizeUnit;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 整表替换的单行输入（id 由用例层铸造；sortOrder 由存储层按数组序分配）。 */
export interface ProcessMaterialRowInput {
  readonly id: string;
  readonly rawMaterialId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly measureType: ProcessMaterialMeasureType;
  readonly partLength: number;
  readonly partWidth: number | null;
  readonly partHeight: number | null;
  readonly cutSizeForm: CutSizeForm;
  readonly cutSizeUnit: CutSizeUnit;
}

/** 整表替换输入：空 rows = 显式清空该工序全部关联行。 */
export interface ReplaceProcessMaterialSetInput {
  readonly tenant: TenantId;
  readonly listingLineId: string;
  readonly processId: string;
  readonly rows: readonly ProcessMaterialRowInput[];
}

/**
 * 工序×原材料关联存储端口。实现方保证：
 *  - replaceSet 原子整表替换（删旧行 + 按数组序插新行，sortOrder 0 起分配）；
 *    同工序 (sortOrder / rawMaterialId) 唯一冲突抛 ListingConflictError；
 *  - 全部读按租户收口；行序按 sortOrder 升序（listByLine 先按 processId 再
 *    按 sortOrder——跨工序行集稳定排序）；
 *  - findByProcessId 跨清单行取该工序引用全部行（service 工序归属预检用）。
 */
export interface ProcessMaterialLinkStore {
  replaceSet(input: ReplaceProcessMaterialSetInput): Promise<readonly ProcessMaterialLink[]>;
  listByProcess(
    tenant: TenantId,
    listingLineId: string,
    processId: string,
  ): Promise<readonly ProcessMaterialLink[]>;
  listByLine(tenant: TenantId, listingLineId: string): Promise<readonly ProcessMaterialLink[]>;
  findByProcessId(tenant: TenantId, processId: string): Promise<readonly ProcessMaterialLink[]>;
}
