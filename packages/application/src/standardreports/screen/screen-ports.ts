/**
 * 大屏事实源读端口（RREQ-RP-023~026）：各域既有 store 只读面的**结构子集**。
 *
 * 纪律：数据聚合只读消费各域端口（Pick 结构子集——不整包引 store 接口，
 * 显式声明消费面）；端口缺省 undefined = 该域读面未接线，对应块/子指标落
 * source 占位（null + pendingFields 登记），不静默回 0、不 throw 炸整帧
 * （大屏是呈现面：单域缺面降级该块，其余照常——体例对齐 workbench 渐降，
 * 而非 standardreports 求值 503 的单口径形态）。
 *
 * 组合根装配：MODULE_DEFINITIONS.screen 从 StorePorts 逐项解析（零 DB 形态
 * wiringStores 预建的工作令/派工/外协/报工内存实例可用；inspection/listing/
 * 日统计仅 PG 形态注入——零 DB 形态这些块显示「数据源待接」，语义诚实）。
 */
import type { TenantId } from '@smes/business-core';
import type { WorkOrderStore } from '../../workorder/workorder-stores.js';
import type { DispatchOrderStore, OutsourcingLineStore } from '../../dispatch/dispatch-stores.js';
import type { WorkReportStore } from '../../reporting/reporting-stores.js';
import type { InspectionOrderStore } from '../../inspection/inspection-stores.js';
import type { ListingLineStore } from '../../listing/listing-stores.js';
import type { MachiningDailyStatsStore } from './machining-daily-stores.js';

/** 大屏消费的各域只读面（全部可选——逐块降级；| undefined = 组合根可显式传缺）。 */
export interface ScreenSourceStores {
  /** 工作令投影读面（KPI①②③ + 项目进度行全集 + 延期风险）。 */
  readonly workOrders?: Pick<WorkOrderStore, 'list'> | undefined;
  /** 派工单读面（六类一体；机加/外协/装配快照 + 在制小时桶）。 */
  readonly dispatchOrders?: Pick<DispatchOrderStore, 'list'> | undefined;
  /** 外协明细读面（外协表供应商列 + 在制去重键 o: 前缀行）。 */
  readonly outsourcingLines?: Pick<OutsourcingLineStore, 'listByDispatch'> | undefined;
  /** 报工读面（12 天产出折线 + 今日排名）。 */
  readonly workReports?: Pick<WorkReportStore, 'list'> | undefined;
  /** 质检读面（今日产出/小时合格/待检三支）。 */
  readonly inspections?: Pick<InspectionOrderStore, 'list'> | undefined;
  /** 清单行读面（KPI⑤ 年度下图计数 + 项目进度零件/电气件总数）。 */
  readonly listingLines?: Pick<ListingLineStore, 'countPartLinesCreatedBetween' | 'listByWorkOrder'> | undefined;
  /** A10 日统计读面（KPI⑥ 消费同源数值）。 */
  readonly machiningDailyStats?: Pick<MachiningDailyStatsStore, 'findLatest'> | undefined;
  /** 报工排名显示名解析（org UserStore 读面；缺省回退 reporter id）。 */
  readonly userNameOf?: ((tenant: TenantId, reporter: string) => Promise<string | null>) | undefined;
}

/** 屏显静态配置（顶栏公司名/安全生产基准日等——部署期注入，不进代码库值）。 */
export interface DigitalOperationScreenConfig {
  /** 公司名称两行（源 §2.1：静态配置）。缺省 ['数字运营中心', '']。 */
  readonly companyNameLines?: readonly string[];
  /** 安全生产天数基准日（源 §2.1 定稿：2014-12-25；不扣除、日历日差）。 */
  readonly safeProductionBaselineDate?: string;
  /** 产出与入库折线窗口天数（源 §2.4：近 12 天含当天）。 */
  readonly dailyOutputWindowDays?: number;
  /** 今日报工排名条数（源契约未定；实现约定 8，可注入调整）。 */
  readonly rankLimit?: number;
}

/** 缺省配置（源文档定稿值；公司名占位文案由部署覆盖）。 */
export const DEFAULT_SCREEN_CONFIG: Required<DigitalOperationScreenConfig> = {
  companyNameLines: ['数字运营中心', ''],
  safeProductionBaselineDate: '2014-12-25',
  dailyOutputWindowDays: 12,
  rankLimit: 8,
};
