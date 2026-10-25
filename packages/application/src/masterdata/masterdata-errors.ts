/**
 * 基础数据域错误（M1 增量 4-I）。
 *
 * 与 org-errors 同一纪律：application 零框架（apps/server/README.md），
 * 域错误用普通 Error 子类表达，HTTP 状态映射由组合根异常过滤器完成
 * （apps/server/src/domain-error.filter.ts：
 * MasterdataInputError → 400、MasterdataNotFoundError → 404、
 * MasterdataConflictError → 409）。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class MasterdataInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterdataInputError';
  }
}

/** 引用的物品/资源不存在（HTTP 404）。 */
export class MasterdataNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterdataNotFoundError';
  }
}

/** 租户内 code 唯一键冲突（HTTP 409）。 */
export class MasterdataConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterdataConflictError';
  }
}
