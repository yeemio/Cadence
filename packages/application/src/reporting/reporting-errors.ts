/**
 * reporting 域错误（M2-W7）。
 *
 * 与 workorder/listing/dispatch 域错误同一纪律：application 零框架，HTTP 状态
 * 映射由组合根异常过滤器完成（apps/server 接线属总控合流，本包只定错误形状）：
 *   ReportInputError    -> 400（请求形状/取值非法）
 *   ReportNotFoundError -> 404（租户内对象不存在；跨租户同形不泄漏存在性）
 *   ReportConflictError -> 409（幂等冲突 / 版本推进冲突 / 唯一约束竞态）
 *   ReportStateError    -> 409（账本与投影不一致 / 配置换代不可重放）
 *
 * 命令路径走 smes.command.v1 CommandOutcome 三分——乐观锁冲突、幂等冲突、状态
 * 规则拒绝（含派工单状态拦截拒绝）以 **rejected 结果值** 返回（不抛错）；本组
 * 错误类服务查询路径（404/400）与不可继续的数据级冲突（账本↔投影不一致，抛
 * StateError 兜底）。
 */
export class ReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口）。 */
export class ReportNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportNotFoundError';
  }
}

/** 幂等/版本冲突（HTTP 409）：operationId 已落账或版本推进冲突。 */
export class ReportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportConflictError';
  }
}

/**
 * 状态冲突（HTTP 409）：事件账本与投影行不一致（写入中断/并发窗口）、或配置
 * 换代导致账本不可重放——数据级冲突，不是请求形状错。
 */
export class ReportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportStateError';
  }
}
