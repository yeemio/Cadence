/**
 * 每日机加工进度统计跑批用例（PRD 20 册 RREQ-RP-027 / A10）。
 *
 * 「生成→刷新（覆盖）→唯一一天一行」：runDaily 对指定统计日落一行，重复跑
 * 幂等覆盖（upsert）。无页面/无手工触发/无 Controller（纯跑批——调度宿主在
 * 组合根 screen 模块的定时器，OQ-4 裁定：Cadence 无 XXL-Job，Nest 内置
 * 定时节拍承接）。
 *
 * 统计日期语义（OQ-6 开放，本实现缺省 = 跑批时刻的前一自然日，S12 月报
 * 「前一天优先读 A10 日表」消费语义对齐；dayOffset 选项可改 0=当天）。
 *
 * 两指标现值 = null + pendingReasons（读面缺失登记，见 machining-daily-stores.ts
 * 头注与 PRD「口径要点」：统计范围=未完成工作令且购置清单有数据、工序仅认
 * 已下单、当日结束时点快照——公式已冻结，读面落地后在本服务补齐求值）。
 */
import type { TenantId } from '@smes/business-core';
import type { MachiningDailyStatsRow, MachiningDailyStatsStore } from './machining-daily-stores.js';

/** 跑批主体标识（computedBy 落账值）。 */
export const MACHINING_DAILY_JOB_ACTOR = 'machining-daily-job';

/** 读面缺失登记（两指标当前同因：清单行加工类型/入库状态 + 工序分类三读面缺）。 */
export const MACHINING_DAILY_PENDING_REASONS: Readonly<Record<string, string>> = {
  surfaceTreatmentDrawingCount:
    '数据源待接：清单行入库状态读面缺失 + 工序机加/表处分类读面缺失（PRD RREQ-RP-027 冻结公式无法求值）',
  pendingMachiningCount:
    '数据源待接：清单行加工类型（外购1/2）与入库状态读面缺失（PRD RREQ-RP-027 残差公式无法求值）',
};

export interface MachiningDailyRunResult {
  readonly row: MachiningDailyStatsRow;
  /** 首跑（插入）还是重跑（覆盖更新）——按落账前是否存在分叉，供跑批留痕。 */
  readonly created: boolean;
}

export class MachiningDailyStatsService {
  constructor(private readonly store: MachiningDailyStatsStore) {}

  /**
   * 跑一天：statisticsDate 缺省 = now 的前一自然日（UTC yyyy-MM-dd，OQ-6 缺省
   * 前一日）；幂等 upsert（存在则更新否则插入）。
   */
  async runDaily(
    tenant: TenantId,
    options: { readonly now?: string; readonly statisticsDate?: string; readonly dayOffset?: number } = {},
  ): Promise<MachiningDailyRunResult> {
    const now = options.now ?? new Date().toISOString();
    const dayOffset = options.dayOffset ?? 1;
    const statisticsDate =
      options.statisticsDate ?? utcDayKey(new Date(Date.parse(now) - dayOffset * 86_400_000));
    const existing = await this.store.find(tenant, statisticsDate);
    const row = await this.store.upsert({
      tenant,
      statisticsDate,
      // 读面缺失登记不做（头注）：两指标 null + 原因，公式冻结待读面落地。
      surfaceTreatmentDrawingCount: null,
      pendingMachiningCount: null,
      pendingReasons: MACHINING_DAILY_PENDING_REASONS,
      computedAt: now,
      computedBy: MACHINING_DAILY_JOB_ACTOR,
    });
    return { row, created: existing === null };
  }

  /** 最近 N 天（验证/大屏消费面；降序）。 */
  listRecent(tenant: TenantId, days = 30): Promise<readonly MachiningDailyStatsRow[]> {
    return this.store.listRecent(tenant, days);
  }

  /** 最新一行（大屏 KPI⑥ 消费面）。 */
  findLatest(tenant: TenantId): Promise<MachiningDailyStatsRow | null> {
    return this.store.findLatest(tenant);
  }
}

/** UTC yyyy-MM-dd（与 reporting 域 dateKeyOf 同口径——时区取舍见 service 头注）。 */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
