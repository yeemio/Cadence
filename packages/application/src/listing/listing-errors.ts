/**
 * listing 域错误（M2-W3）。
 *
 * 与 workorder/baseline 域错误同一纪律：application 零框架，HTTP 状态映射由
 * 组合根异常过滤器完成（apps/server 接线属总控合流，本包只定错误形状）：
 *   ListingInputError    -> 400（请求形状/取值非法，含 Excel 表头缺失等文件级问题）
 *   ListingNotFoundError -> 404（租户内对象不存在；跨租户同形不泄漏存在性）
 *   ListingConflictError -> 409（幂等冲突 / 版本推进冲突 / 唯一约束竞态）
 *   ListingStateError    -> 409（账本与投影不一致 / 配置换代不可重放）
 *
 * 命令路径走 smes.command.v1 CommandOutcome 三分——乐观锁冲突、幂等冲突、
 * 状态规则拒绝以 **rejected 结果值** 返回（不抛错）；本组错误类服务查询路径
 * （404/400）与不可继续的数据级冲突（账本↔投影不一致，抛 StateError 兜底）。
 */
export class ListingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口）。 */
export class ListingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingNotFoundError';
  }
}

/** 幂等/版本冲突（HTTP 409）：operationId 已落账或版本推进冲突。 */
export class ListingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingConflictError';
  }
}

/**
 * 状态冲突（HTTP 409）：事件账本与投影行不一致（写入中断/并发窗口）、或配置
 * 换代导致账本不可重放——数据级冲突，不是请求形状错。
 */
export class ListingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingStateError';
  }
}
