/**
 * U7 项目成本六块口径（A5 项目成本报表-开发文档.md 的 Cadence 重述，词汇纪律
 * ADR-0010；口径权威源=文档，差异如实登记对账）。
 *
 * 六块（文档 §1.2 → Cadence block 词汇）：
 *  ② 材料（四类，计费节点一律发料）：material-part 非标件 / material-standard
 *     标准件 / material-electrical 电气件 / material-raw 原材料；
 *  ③ 外协：outsourcing（dispatch 外协明细，既定 OutsourcingPriced 口径）；
 *  ④ 人工（三类别，仅生产环节）：labor（hours 工种 machining/assembly/
 *     electrical——文档 装配/调试 两类在 Cadence 无独立调试派工面，electrical
 *     工种（电气接线）承载调试位，差异登记）；
 *  ⑤ 售后：aftercare（工时薪资 trade=aftercare + 报销四费 U5 aftercare-claim；
 *     文档 保内/保外 两行在 Cadence 无质保归属面 → 单桶，差异登记）；
 *  ⑥ 外购设备：equipment（采购段=listing 采购订单行 receivedQty×单价——
 *     listing 既定金额汇总口径；利库段=发料明细预占×录入价格）。
 *
 * 两段拆分（文档 §1.2.1 → 合同 U7 裁定）：以 U1 发料记录回执快照为据——
 *  - reserved 利库段 = reservedConsumed（预占核销；equipment 行 =
 *    useInventoryConsumed）；
 *  - purchase 采购段 = availableConsumed（可用扣减）；
 *  - raw 原材料段 = 非标行自制净发料（thisQty − reservedConsumed）×
 *    U4 工序×原材料关联行（尺寸×件数×录入单价）。
 * 段级金额解析分工：part/equipment 利库段 = costing 录入价格表（cost_price_
 * entries，未录入按 0——文档实现备注口径）；其余段 = 组合根适配器解析（本令
 * PO 加权含税单价 / 关联行单价），costing 只聚合。
 */
import { laborAmountMinor, type CostingModelDefinition } from './costing-model.js';

// ---- block / segment 词汇 ----

/** 六块成本 block（材料四类各占一块 → 8 个 entry block）。 */
export const PROJECT_COST_BLOCKS = [
  'material-part',
  'material-standard',
  'material-electrical',
  'material-raw',
  'outsourcing',
  'labor',
  'aftercare',
  'equipment',
] as const;

export type ProjectCostBlock = (typeof PROJECT_COST_BLOCKS)[number];

/** block → 展示块（六块）。 */
export type ProjectCostDisplayBlock = 'material' | 'outsourcing' | 'labor' | 'aftercare' | 'equipment';

/** 段词汇（两段拆分 + 块内构成段）。 */
export const PROJECT_COST_SEGMENTS = [
  'reserved',      // 利库段（预占核销）
  'purchase',      // 采购段（可用扣减 × PO 加权价；非标外购净发料段）
  'raw',           // 原材料段（非标自制净发料 × 关联行）
  'purchase-order', // 设备采购段（⑥采购行）
  'reimburse',     // 售后报销段（四费）
  'labor',         // 工时段（金额化在口径层）
] as const;

export type ProjectCostSegment = (typeof PROJECT_COST_SEGMENTS)[number];

/** block 人读标签（呈现层用）。 */
export const PROJECT_COST_BLOCK_LABELS: Readonly<Record<ProjectCostBlock, string>> = {
  'material-part': '非标件',
  'material-standard': '标准件',
  'material-electrical': '电气件',
  'material-raw': '原材料',
  outsourcing: '外协',
  labor: '人工',
  aftercare: '售后',
  equipment: '外购设备',
};

/** ④ 人工固定三行工种（文档 labor_category 1~3；Cadence electrical 承载调试位）。 */
export const PROJECT_LABOR_TRADES = ['machining', 'assembly', 'electrical'] as const;

/** ⑤ 售后工时工种（hours aftercare；生产三工种之外单独归 ⑤）。 */
export const AFTERCARE_LABOR_TRADE = 'aftercare';

/** 工种 → ④/⑤ 归属（misc 零工不入六块——文档无对应类别，差异登记）。 */
export function laborBlockOfTrade(trade: string): 'labor' | 'aftercare' | null {
  if ((PROJECT_LABOR_TRADES as readonly string[]).includes(trade)) return 'labor';
  if (trade === AFTERCARE_LABOR_TRADE) return 'aftercare';
  return null;
}

// ---- 聚合结果形状（快照 totals JSONB） ----

/** 材料类两段合计（非标/标准/电气同形；原材料无两段面 → MaterialRawTotals）。 */
export interface MaterialSegmentTotals {
  readonly reservedMinor: number;
  readonly purchaseMinor: number;
  readonly totalMinor: number;
}

/** 原材料块合计（金额 + 行数基础）。 */
export interface MaterialRawTotals {
  readonly totalMinor: number;
  readonly lineCount: number;
}

/** ④ 人工行（固定三行：机加工/装配/调试位=electrical）。 */
export interface ProjectLaborRow {
  readonly trade: string;
  readonly hours: number;
  readonly amountMinor: number;
}

/** ⑤ 售后合计（单桶——无保内/保外面，差异登记）。 */
export interface AftercareTotals {
  readonly laborHours: number;
  readonly laborMinor: number;
  readonly reimburseMinor: number;
  readonly totalMinor: number;
}

/** ⑥ 外购设备合计（采购段 + 利库段）。 */
export interface EquipmentTotals {
  readonly purchaseMinor: number;
  readonly inventoryUseMinor: number;
  readonly totalMinor: number;
}

/** ③ 外协按供应商行（文档 §1.2.3 按供应商聚合）。 */
export interface OutsourceSupplierRow {
  readonly supplierRef: string;
  readonly amountMinor: number;
  readonly lineCount: number;
}

/** 六块合计形状（cost_project_snapshots.totals JSONB 载荷）。 */
export interface ProjectCostTotals {
  /** ② 材料四类合计。 */
  readonly materialMinor: number;
  readonly materialPart: MaterialSegmentTotals;
  readonly materialStandard: MaterialSegmentTotals;
  readonly materialElectrical: MaterialSegmentTotals;
  readonly materialRaw: MaterialRawTotals;
  /** ③ 外协合计 + 供应商行。 */
  readonly outsourcingMinor: number;
  readonly outsourcingBySupplier: readonly OutsourceSupplierRow[];
  /** ④ 人工合计 + 固定三行。 */
  readonly laborMinor: number;
  readonly laborRows: readonly ProjectLaborRow[];
  /** ⑤ 售后合计。 */
  readonly aftercare: AftercareTotals;
  /** ⑥ 外购设备合计。 */
  readonly equipment: EquipmentTotals;
  /** 六块合计（②+③+④+⑤+⑥）。 */
  readonly grandMinor: number;
  /** 工时量基础（工种→净小时；口径换算留痕输入——只含入账工种，misc 不采）。 */
  readonly laborHoursByTrade: Readonly<Record<string, number>>;
  /** 各 block 条目数（对账口径）。 */
  readonly entryCounts: Readonly<Record<ProjectCostBlock, number>>;
}

export const EMPTY_PROJECT_COST_TOTALS: ProjectCostTotals = {
  materialMinor: 0,
  materialPart: { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 },
  materialStandard: { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 },
  materialElectrical: { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 },
  materialRaw: { totalMinor: 0, lineCount: 0 },
  outsourcingMinor: 0,
  outsourcingBySupplier: [],
  laborMinor: 0,
  laborRows: PROJECT_LABOR_TRADES.map((trade) => ({ trade, hours: 0, amountMinor: 0 })),
  aftercare: { laborHours: 0, laborMinor: 0, reimburseMinor: 0, totalMinor: 0 },
  equipment: { purchaseMinor: 0, inventoryUseMinor: 0, totalMinor: 0 },
  grandMinor: 0,
  laborHoursByTrade: {},
  entryCounts: Object.fromEntries(PROJECT_COST_BLOCKS.map((block) => [block, 0])) as Record<ProjectCostBlock, number>,
};

/** 空材料段合计（两段归零）。 */
export function emptySegmentTotals(): MaterialSegmentTotals {
  return { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 };
}

/**
 * 工时金额化聚合的一行贡献（既定口径：工时条目逐条 × 时薪后取整再求和——
 * 与既有 aggregateThroughModel 同一套 laborAmountMinor 语义）。
 */
export interface LaborEntryFact {
  readonly trade: string;
  readonly hours: number;
}

/** 工时行组 →（工种 → 金额）：逐条取整后求和。 */
export function laborAmountsByTrade(
  definition: CostingModelDefinition,
  entries: readonly LaborEntryFact[],
): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const entry of entries) {
    amounts[entry.trade] = (amounts[entry.trade] ?? 0) + laborAmountMinor(definition, entry.trade, entry.hours);
  }
  return amounts;
}

// ---- 聚合输入（条目行在 project-cost-stores 定义；此处只依赖结构面） ----

/** 聚合消费的条目结构面（CostProjectEntryRow 的求值子集）。 */
export interface ProjectEntryFact {
  readonly block: ProjectCostBlock;
  readonly segment: ProjectCostSegment | null;
  readonly lineKind: 'part' | 'standard' | 'electrical' | 'equipment' | null;
  readonly amountMinor: number | null;
  readonly quantity: number | null;
  readonly trade: string | null;
  readonly supplierRef: string | null;
}

/**
 * 六块聚合纯函数（快照与实时汇总的唯一实现）：
 *  - 材料 part/standard/electrical 按 segment 分桶两段；raw 直加；
 *  - outsourcing 按供应商聚合行 + 合计；
 *  - labor：④ 三工种逐条目金额化（口径层换算）+ 工时行；aftercare 工种同法入 ⑤；
 *  - aftercare = 工时薪资 + 报销段；equipment = purchase-order 段 + equipment
 *    行 reserved 段；
 *  - misc 零工不入六块账本（服务层不采——工时留痕归 hours 模块自身）。
 */
export function aggregateProjectCost(
  entries: readonly ProjectEntryFact[],
  definition: CostingModelDefinition,
): ProjectCostTotals {
  const part: { reservedMinor: number; purchaseMinor: number; totalMinor: number } = { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 };
  const standard: { reservedMinor: number; purchaseMinor: number; totalMinor: number } = { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 };
  const electrical: { reservedMinor: number; purchaseMinor: number; totalMinor: number } = { reservedMinor: 0, purchaseMinor: 0, totalMinor: 0 };
  const raw: { totalMinor: number; lineCount: number } = { totalMinor: 0, lineCount: 0 };
  const outsourcingBySupplierMap = new Map<string, { amountMinor: number; lineCount: number }>();
  const laborFacts: LaborEntryFact[] = [];
  const aftercareLaborFacts: LaborEntryFact[] = [];
  let reimburseMinor = 0;
  let equipmentPurchaseMinor = 0;
  let equipmentInventoryUseMinor = 0;
  const laborHoursByTrade: Record<string, number> = {};
  const entryCounts = Object.fromEntries(PROJECT_COST_BLOCKS.map((block) => [block, 0])) as Record<ProjectCostBlock, number>;

  for (const entry of entries) {
    entryCounts[entry.block] += 1;
    const amount = entry.amountMinor ?? 0;
    switch (entry.block) {
      case 'material-part':
      case 'material-standard':
      case 'material-electrical': {
        const bucket = entry.block === 'material-part' ? part : entry.block === 'material-standard' ? standard : electrical;
        if (entry.segment === 'reserved') bucket.reservedMinor += amount;
        else if (entry.segment === 'purchase') bucket.purchaseMinor += amount;
        else bucket.purchaseMinor += amount; // 未标段的材料行归采购段（防御口径）
        bucket.totalMinor = bucket.reservedMinor + bucket.purchaseMinor;
        break;
      }
      case 'material-raw':
        raw.totalMinor += amount;
        raw.lineCount += 1;
        break;
      case 'outsourcing': {
        const key = entry.supplierRef ?? '(none)';
        const row = outsourcingBySupplierMap.get(key) ?? { amountMinor: 0, lineCount: 0 };
        row.amountMinor += amount;
        row.lineCount += 1;
        outsourcingBySupplierMap.set(key, row);
        break;
      }
      case 'labor': {
        const hours = entry.quantity ?? 0;
        const trade = entry.trade ?? '(none)';
        laborFacts.push({ trade, hours });
        laborHoursByTrade[trade] = (laborHoursByTrade[trade] ?? 0) + hours;
        break;
      }
      case 'aftercare': {
        if (entry.segment === 'reimburse') {
          reimburseMinor += amount;
        } else {
          const hours = entry.quantity ?? 0;
          const trade = entry.trade ?? '(none)';
          aftercareLaborFacts.push({ trade, hours });
          laborHoursByTrade[trade] = (laborHoursByTrade[trade] ?? 0) + hours;
        }
        break;
      }
      case 'equipment': {
        if (entry.segment === 'purchase-order') equipmentPurchaseMinor += amount;
        else equipmentInventoryUseMinor += amount;
        break;
      }
    }
  }

  // outsourcing 合计（Map 累计后直加）
  let outsourcingTotal = 0;
  for (const row of outsourcingBySupplierMap.values()) outsourcingTotal += row.amountMinor;

  const laborAmounts = laborAmountsByTrade(definition, laborFacts);
  const aftercareAmounts = laborAmountsByTrade(definition, aftercareLaborFacts);
  // misc 等未入六块工种的留痕工时已进 laborHoursByTrade；金额不入块
  let laborMinorTotal = 0;
  const laborRows: ProjectLaborRow[] = PROJECT_LABOR_TRADES.map((trade) => {
    const hours = laborFacts.filter((fact) => fact.trade === trade).reduce((sum, fact) => sum + fact.hours, 0);
    const amountMinor = laborAmounts[trade] ?? 0;
    laborMinorTotal += amountMinor;
    return { trade, hours, amountMinor };
  });
  const aftercareLaborHours = aftercareLaborFacts.reduce((sum, fact) => sum + fact.hours, 0);
  const aftercareLaborMinor = aftercareAmounts[AFTERCARE_LABOR_TRADE] ?? 0;

  const materialMinor = part.totalMinor + standard.totalMinor + electrical.totalMinor + raw.totalMinor;
  const aftercareTotal = aftercareLaborMinor + reimburseMinor;
  const equipmentTotal = equipmentPurchaseMinor + equipmentInventoryUseMinor;

  return {
    materialMinor,
    materialPart: part,
    materialStandard: standard,
    materialElectrical: electrical,
    materialRaw: raw,
    outsourcingMinor: outsourcingTotal,
    outsourcingBySupplier: [...outsourcingBySupplierMap.entries()]
      .map(([supplierRef, row]) => ({ supplierRef, amountMinor: row.amountMinor, lineCount: row.lineCount }))
      .sort((a, b) => a.supplierRef.localeCompare(b.supplierRef)),
    laborMinor: laborMinorTotal,
    laborRows,
    aftercare: {
      laborHours: aftercareLaborHours,
      laborMinor: aftercareLaborMinor,
      reimburseMinor,
      totalMinor: aftercareTotal,
    },
    equipment: {
      purchaseMinor: equipmentPurchaseMinor,
      inventoryUseMinor: equipmentInventoryUseMinor,
      totalMinor: equipmentTotal,
    },
    grandMinor: materialMinor + outsourcingTotal + laborMinorTotal + aftercareTotal + equipmentTotal,
    laborHoursByTrade,
    entryCounts,
  };
}

// ---- 等值判定（幂等重算"值未变"依据） ----

function sameSegment(a: MaterialSegmentTotals, b: MaterialSegmentTotals): boolean {
  return a.reservedMinor === b.reservedMinor && a.purchaseMinor === b.purchaseMinor && a.totalMinor === b.totalMinor;
}

/** 六块合计等值判定（嵌套全比；快照幂等与对账共用）。 */
export function sameProjectTotals(a: ProjectCostTotals, b: ProjectCostTotals): boolean {
  if (
    a.materialMinor !== b.materialMinor ||
    a.outsourcingMinor !== b.outsourcingMinor ||
    a.laborMinor !== b.laborMinor ||
    a.grandMinor !== b.grandMinor ||
    !sameSegment(a.materialPart, b.materialPart) ||
    !sameSegment(a.materialStandard, b.materialStandard) ||
    !sameSegment(a.materialElectrical, b.materialElectrical) ||
    a.materialRaw.totalMinor !== b.materialRaw.totalMinor ||
    a.materialRaw.lineCount !== b.materialRaw.lineCount ||
    a.aftercare.laborHours !== b.aftercare.laborHours ||
    a.aftercare.laborMinor !== b.aftercare.laborMinor ||
    a.aftercare.reimburseMinor !== b.aftercare.reimburseMinor ||
    a.aftercare.totalMinor !== b.aftercare.totalMinor ||
    a.equipment.purchaseMinor !== b.equipment.purchaseMinor ||
    a.equipment.inventoryUseMinor !== b.equipment.inventoryUseMinor ||
    a.equipment.totalMinor !== b.equipment.totalMinor
  ) {
    return false;
  }
  if (a.outsourcingBySupplier.length !== b.outsourcingBySupplier.length) return false;
  for (let index = 0; index < a.outsourcingBySupplier.length; index += 1) {
    const rowA = a.outsourcingBySupplier[index]!;
    const rowB = b.outsourcingBySupplier[index]!;
    if (rowA.supplierRef !== rowB.supplierRef || rowA.amountMinor !== rowB.amountMinor || rowA.lineCount !== rowB.lineCount) {
      return false;
    }
  }
  if (a.laborRows.length !== b.laborRows.length) return false;
  for (let index = 0; index < a.laborRows.length; index += 1) {
    const rowA = a.laborRows[index]!;
    const rowB = b.laborRows[index]!;
    if (rowA.trade !== rowB.trade || rowA.hours !== rowB.hours || rowA.amountMinor !== rowB.amountMinor) return false;
  }
  const blocks = PROJECT_COST_BLOCKS.filter(
    (block) => (a.entryCounts[block] ?? 0) !== (b.entryCounts[block] ?? 0),
  );
  if (blocks.length > 0) return false;
  const trades = new Set([...Object.keys(a.laborHoursByTrade), ...Object.keys(b.laborHoursByTrade)]);
  for (const trade of trades) {
    if ((a.laborHoursByTrade[trade] ?? 0) !== (b.laborHoursByTrade[trade] ?? 0)) return false;
  }
  return true;
}
