/**
 * dispatch 售后报销跨模块读端口（U5 A12）。
 *
 * 「仅审批通过后可填报」（文档 §2.4.1）的事实源在 reporting 模块：售后报工
 * （kind=aftermarket）核查通过（state=verified，链尾行）。dispatch 不直接读
 * reporting 存储——经本端口互调（ADR-0011 / dispatch-ports 同一纪律），实现方
 * = 组合根适配器（合流接线）；缺省空实现 = 恒无通过报工（fail-closed：未接线
 * 时报销新增被拒——通过事实不可伪证，体例同 EMPTY_KIT_CHECK_PORT）。
 *
 * 组合根适配口径（合流时按此接线，结构化兼容不引 reporting 类型）：
 *   reporting ReportingService.listReports(tenant, { dispatchId, kind:
 *   'aftermarket', state: 'verified' })（链尾行，被修正/撤销行不返回）→
 *   经 createAftercareReportPort 投影成 AftercareApprovedReportLine。
 */
import { TenantId, UserId } from '@smes/business-core';

/** 审批通过的售后报工行（报销明细的取数事实；字段以 reporting WorkReport 为准）。 */
export interface AftercareApprovedReportLine {
  /** 报工单 id（WorkReport id，opaque；报销行明细键）。 */
  readonly reportId: string;
  /** 报工日期（businessTime，ISO 8601——文档「报工日期」列）。 */
  readonly reportDate: string;
  /** 售后人（报工申报人——文档「实际售后人」列）。 */
  readonly worker: UserId;
  /** 审批人（报工核查人 verifiedBy；可空——文档「审批人/报工人」列）。 */
  readonly approvedBy: UserId | null;
  /** 审批工时（分钟；Cadence 报工单值 laborMinutes，无正班/加班分列）。 */
  readonly approvedMinutes: number;
}

/** 审批通过报工读端口（报销面唯一外部事实输入）。 */
export interface AftercareApprovedReportPort {
  /** 按派工单列审批通过报工（reportDate 升序，同日报工单 id 稳定序）。 */
  listApproved(tenant: TenantId, dispatchId: string): Promise<readonly AftercareApprovedReportLine[]>;
}

/** 缺省空端口：恒无通过报工（零接线 boot——报销新增被拒，fail-closed）。 */
export const EMPTY_AFTERCARE_REPORT_PORT: AftercareApprovedReportPort = {
  listApproved: async () => [],
};

/** reporting 报工行的结构化形状（listReports 返回面的镜像超集；字段缺失按空收口）。 */
export interface AftercareReportSourceLike {
  readonly id?: unknown;
  readonly businessTime?: unknown;
  readonly reporter?: unknown;
  readonly verifiedBy?: unknown;
  readonly laborMinutes?: unknown;
}

/** reporting 服务查询面的结构化形状（组合根/测试适配器用；listReports 同形）。 */
export interface AftercareReportSource {
  listReports(
    tenant: TenantId,
    filter?: { readonly dispatchId?: string; readonly kind?: string; readonly state?: string },
  ): Promise<readonly AftercareReportSourceLike[]>;
}

function asUserId(value: unknown): UserId | null {
  return typeof value === 'string' && value.length > 0 ? UserId.create(value) : null;
}

/**
 * 报工行镜像 → 报销取数行投影（组合根/测试适配器；verified 报工的
 * verifiedBy 理论非空，缺失按 null 收口不炸查询；reporter 缺失 = 适配器
 * 数据级异常，fail-fast 抛错不静默造人）。
 */
export function toAftercareApprovedLine(row: AftercareReportSourceLike): AftercareApprovedReportLine {
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('aftercare 报工行投影失败：report id 缺失（适配器数据级异常）');
  }
  const worker = asUserId(row.reporter);
  if (worker === null) {
    throw new Error(`aftercare 报工行投影失败：报工 '${row.id}' 缺申报人（适配器数据级异常）`);
  }
  return {
    reportId: row.id,
    reportDate: typeof row.businessTime === 'string' ? row.businessTime : '',
    worker,
    approvedBy: asUserId(row.verifiedBy),
    approvedMinutes: typeof row.laborMinutes === 'number' ? row.laborMinutes : 0,
  };
}

/**
 * reporting 查询面 → 端口适配器（合流接线用；固定 kind=aftermarket +
 * state=verified——「审批通过」的 Cadence 口径，链尾行由 reporting 侧保证）。
 */
export function createAftercareReportPort(source: AftercareReportSource): AftercareApprovedReportPort {
  return {
    listApproved: async (tenant, dispatchId) =>
      (await source.listReports(tenant, { dispatchId, kind: 'aftermarket', state: 'verified' })).map(
        toAftercareApprovedLine,
      ),
  };
}
