/**
 * 每日机加工进度统计存储端口（PRD 20 册 RREQ-RP-027 / A10）。
 *
 * 表语义（PRD 冻结口径）：日统计表一行一天（(tenant, statisticsDate) 唯一；
 * 存在则更新否则插入）；无页面、无手工触发、无 Controller（纯跑批）；
 * 为 S12 月报与大屏 KPI⑥ 提供同源口径。
 *
 * 两指标（表处中图号数 / 待机加数量）的冻结公式：
 *  - 表处中图号数 = 该图号行：已下单工序含表处理 ∧ 已下单机加工序全部报满
 *    （report_quantity≥total_quantity，缺省按 1；无机加视为成立）∧ 零件入库
 *    状态非全部入库（表处理工序自身是否报满不影响）；
 *  - 待机加数量 = 图号总数 − 外购1 − 外购2 − 已入库非纯外购 − 表处中
 *    （允许为负；外购1/2 = 加工类型 4/5 全部图号行不论是否入库）。
 *
 * **登记不做（读面缺失，值落 null + pendingReasons 说明）**：Cadence 清单行
 * 无加工类型列（外购1/2 不可判）、无逐行入库状态列（已入库非纯外购/非全部
 * 入库不可判）、工序主数据分类为自由文本 category（ADR-0010 行业词只进数据
 * 不进代码——机加/表处不可机器判定）。三读面落地后本端口行结构不变，跑批
 * 实现补齐公式即可（表列 nullable 即为此预留）。
 *
 * PG 持久化：business-store prisma/migrations/*_machining_daily_stats
 * （machining_daily_stats 表，RLS 全表守恒）；内存实现先行（本文件）。
 */
import type { TenantId } from '@smes/business-core';

/** 日统计行（statisticsDate = yyyy-MM-dd）。 */
export interface MachiningDailyStatsRow {
  readonly tenant: TenantId;
  readonly statisticsDate: string;
  /** 表处中图号数（读面缺失时 null）。 */
  readonly surfaceTreatmentDrawingCount: number | null;
  /** 待机加数量（残差公式，允许为负；读面缺失时 null）。 */
  readonly pendingMachiningCount: number | null;
  /** 指标级占位说明（metric → 原因；两指标可读时为空对象）。 */
  readonly pendingReasons: Readonly<Record<string, string>>;
  /** 本次跑批时刻（ISO 8601；审计排查用）。 */
  readonly computedAt: string;
  /** 跑批主体（系统任务标识，如 'machining-daily-job'）。 */
  readonly computedBy: string;
}

export interface UpsertMachiningDailyStatsInput {
  readonly tenant: TenantId;
  readonly statisticsDate: string;
  readonly surfaceTreatmentDrawingCount: number | null;
  readonly pendingMachiningCount: number | null;
  readonly pendingReasons: Readonly<Record<string, string>>;
  readonly computedAt: string;
  readonly computedBy: string;
}

/**
 * 日统计存储端口。实现方保证：
 *  - upsert = 存在则更新否则插入（(tenant, statisticsDate) 唯一）；
 *  - listRecent 按 statisticsDate 降序、至多 days 行；
 *  - 全部读操作按租户收口。
 */
export interface MachiningDailyStatsStore {
  upsert(input: UpsertMachiningDailyStatsInput): Promise<MachiningDailyStatsRow>;
  find(tenant: TenantId, statisticsDate: string): Promise<MachiningDailyStatsRow | null>;
  /** 最新一行（statisticsDate 降序；空表 null——大屏 KPI⑥ 消费面）。 */
  findLatest(tenant: TenantId): Promise<MachiningDailyStatsRow | null>;
  listRecent(tenant: TenantId, days: number): Promise<readonly MachiningDailyStatsRow[]>;
}

/** 内存实现（零 DB boot / 测试；upsert 语义与 PG 同口径）。 */
export class InMemoryMachiningDailyStatsStore implements MachiningDailyStatsStore {
  private readonly rows = new Map<string, MachiningDailyStatsRow>(); // key: `${tenant}|${date}`

  async upsert(input: UpsertMachiningDailyStatsInput): Promise<MachiningDailyStatsRow> {
    const row: MachiningDailyStatsRow = { ...input };
    this.rows.set(`${String(input.tenant)}|${input.statisticsDate}`, row);
    return row;
  }

  async find(tenant: TenantId, statisticsDate: string): Promise<MachiningDailyStatsRow | null> {
    return this.rows.get(`${String(tenant)}|${statisticsDate}`) ?? null;
  }

  async findLatest(tenant: TenantId): Promise<MachiningDailyStatsRow | null> {
    const latest = await this.listRecent(tenant, 1);
    return latest[0] ?? null;
  }

  async listRecent(tenant: TenantId, days: number): Promise<readonly MachiningDailyStatsRow[]> {
    return [...this.rows.values()]
      .filter((row) => String(row.tenant) === String(tenant))
      .sort((a, b) => (a.statisticsDate < b.statisticsDate ? 1 : a.statisticsDate > b.statisticsDate ? -1 : 0))
      .slice(0, Math.max(0, Math.trunc(days)));
  }
}
