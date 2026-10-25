/**
 * 成本账（costing）域错误（M2-W6，09-costing.md v1.0）。
 *
 * 与既有域错误同一纪律：application 零框架，HTTP 状态映射由组合根异常过滤器
 * 完成：
 *   CostingInputError    -> 400（请求形状/取值非法——含命令信封字段非法）
 *   CostingNotFoundError -> 404（租户内对象不存在）
 *   CostingConflictError -> 409（sourceKey 唯一冲突、口径版本链分叉等并发竞态）
 *
 * 命令执行的业务性拒绝（乐观锁不符、口径码已存在、载荷非法）不走异常，走
 * CommandOutcome.rejected；异常只用于读路径与存储层唯一键冲突。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class CostingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostingInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口）。 */
export class CostingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostingNotFoundError';
  }
}

/** 唯一键约束冲突（HTTP 409）。 */
export class CostingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostingConflictError';
  }
}
