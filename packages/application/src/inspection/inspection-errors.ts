/**
 * inspection 域错误（M2-W4）。
 *
 * 与 org/masterdata/workbench/approval/workorder 域错误同一纪律：application
 * 零框架，HTTP 状态映射由组合根异常过滤器完成（apps/server 增设
 * inspection-error.filter 的接线属总控合流，本包只定义并导出错误形状）：
 *   InspectionInputError    -> 400（请求形状/取值非法）
 *   InspectionNotFoundError -> 404（租户内对象不存在；跨租户同形不泄漏存在性）
 *   InspectionConflictError -> 409（幂等冲突 / 版本推进冲突）
 *   InspectionStateError    -> 409（状态机规则拒绝 / 账本与投影不一致）
 *
 * 注意（与 approval 的分工差异，同 workorder 头注口径）：命令路径走
 * smes.command.v1 CommandOutcome 三分——乐观锁冲突、幂等冲突、状态规则拒绝以
 * **rejected 结果值** 返回（不抛错）；本组错误类服务**查询路径**（404/400）与
 * 不可继续的数据级冲突（账本↔投影不一致，抛 StateError 由过滤器兜底）。
 */
export class InspectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口）。 */
export class InspectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionNotFoundError';
  }
}

/** 幂等/版本冲突（HTTP 409）：operationId 已落账或版本推进冲突。 */
export class InspectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionConflictError';
  }
}

/**
 * 状态冲突（HTTP 409）：事件账本与投影行不一致（写入中断/并发窗口）、
 * 或配置换代导致账本不可重放——数据级冲突，不是请求形状错。
 */
export class InspectionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionStateError';
  }
}
