/**
 * issue 域错误（U1）。与 workorder/listing/dispatch 同一纪律：application
 * 零框架，HTTP 状态映射由组合根异常过滤器完成（apps/server 接线属总控合流）：
 *   IssueInputError    -> 400（请求形状/取值非法）
 *   IssueNotFoundError -> 404（租户内对象不存在；跨租户同形不泄漏存在性）
 *   IssueConflictError -> 409（同维度任务 / 同单号快递唯一性竞态）
 *   IssueStateError    -> 409（不可撤销 / 可发为负的数据错误 / 版本不符）
 *
 * 命令路径走 smes.command.v1 CommandOutcome 三分——幂等冲突、可发不足、状态
 * 规则拒绝以 rejected 结果值返回（不抛错）；本组错误类服务查询路径（404/400）
 * 与不可继续的数据级冲突（抛 StateError 兜底）。
 */
export class IssueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口）。 */
export class IssueNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueNotFoundError';
  }
}

/** 唯一性冲突（HTTP 409）：同维度任务 / 同单号快递头竞态。 */
export class IssueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueConflictError';
  }
}

/**
 * 状态冲突（HTTP 409）：已撤销记录再撤销、任务非未开始不可清理、
 * 已发>已预占的数据错误阻断（文档 1.4.1：后端按数据错误处理，不前端截断）。
 */
export class IssueStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueStateError';
  }
}
