/**
 * 组织管理域错误（M1 增量 3-D）。
 *
 * application 零框架纪律（apps/server/README.md）：本包业务类不 import
 * NestJS 运行时链路件（异常类属组合根）。因此域错误用普通 Error 子类表达，
 * HTTP 状态映射由组合根的异常过滤器完成（apps/server/src/org-error.filter.ts：
 * OrgInputError → 400、OrgNotFoundError → 404、OrgConflictError → 409）。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class OrgInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgInputError';
  }
}

/** 引用的用户/角色不存在（HTTP 404）。 */
export class OrgNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgNotFoundError';
  }
}

/** 租户内唯一键冲突（HTTP 409）。 */
export class OrgConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgConflictError';
  }
}
