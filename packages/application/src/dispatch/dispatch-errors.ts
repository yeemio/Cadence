/**
 * dispatch 域错误（M2-W6）。
 *
 * 与 workorder/listing/inspection 域错误同一纪律：application 零框架，HTTP 状态
 * 映射由组合根异常过滤器完成（apps/server 接线属总控合流，本包只定错误形状）：
 *   DispatchInputError    -> 400（请求形状/取值非法）
 *   DispatchNotFoundError -> 404（租户内对象不存在；跨租户同形不泄漏存在性）
 *   DispatchConflictError -> 409（幂等冲突 / 版本推进冲突 / 唯一约束竞态）
 *   DispatchStateError    -> 409（账本与投影不一致 / 配置换代不可重放）
 *
 * 命令路径走 smes.command.v1 CommandOutcome 三分——乐观锁冲突、幂等冲突、状态
 * 规则拒绝（含齐套拦截拒绝）以 **rejected 结果值** 返回（不抛错）；本组错误类
 * 服务查询路径（404/400）与不可继续的数据级冲突（账本↔投影不一致，抛
 * StateError 兜底）。
 */
export class DispatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口）。 */
export class DispatchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchNotFoundError';
  }
}

/** 幂等/版本冲突（HTTP 409）：operationId 已落账或版本推进冲突。 */
export class DispatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchConflictError';
  }
}

/**
 * 状态冲突（HTTP 409）：事件账本与投影行不一致（写入中断/并发窗口）、或配置
 * 换代导致账本不可重放——数据级冲突，不是请求形状错。
 */
export class DispatchStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchStateError';
  }
}
