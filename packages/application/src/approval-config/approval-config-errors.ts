/**
 * 审批配置域错误（T 波 #102，approval 域）。
 *
 * 与 org-errors 同一纪律：application 零框架（apps/server/README.md），域错误
 * 用普通 Error 子类表达，HTTP 状态映射由组合根异常过滤器完成
 * （apps/server/src/domain-error.filter.ts：ApprovalConfigInputError → 400、
 * ApprovalConfigNotFoundError → 404、ApprovalConfigConflictError → 409）。
 */

/** 配置文档/输入非法（HTTP 400；engine-flow 校验错误包装于此）。 */
export class ApprovalConfigInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConfigInputError';
  }
}

/** 引用的流配置不存在（HTTP 404）。 */
export class ApprovalConfigNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConfigNotFoundError';
  }
}

/** 租户内 flowId 唯一键冲突（HTTP 409）。 */
export class ApprovalConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConfigConflictError';
  }
}
