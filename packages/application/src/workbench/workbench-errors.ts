/**
 * 工作台域错误（M1 增量 4-I）。
 *
 * 与 org/masterdata 域错误同一纪律：application 零框架，HTTP 状态映射由
 * 组合根异常过滤器完成（apps/server/src/domain-error.filter.ts：
 * WorkbenchInputError → 400、WorkbenchNotFoundError → 404）。
 *
 * 注意：无 ConflictError——待办无租户内唯一业务键；也无 ForbiddenError——
 * "仅本人可操作"按数据级过滤实现（非本人的行对当事人不可见 → 404，
 * 不泄漏存在性），见 workbench-stores.ts 端口合同。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class WorkbenchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchInputError';
  }
}

/** 待办不存在或不属于当前用户（HTTP 404；两者同形，不泄漏他人待办存在性）。 */
export class WorkbenchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchNotFoundError';
  }
}
