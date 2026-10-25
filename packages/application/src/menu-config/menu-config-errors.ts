/**
 * 菜单配置域错误（T 波 #98/99）。
 *
 * 与 org-errors 同一纪律：application 零框架（apps/server/README.md），域错误
 * 用普通 Error 子类表达，HTTP 状态映射由组合根异常过滤器完成
 * （apps/server/src/domain-error.filter.ts：MenuConfigInputError → 400、
 * MenuConfigNotFoundError → 404、MenuConfigConflictError → 409）。
 */

/** 输入形状/取值非法（HTTP 400；含节点树形状违规）。 */
export class MenuConfigInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuConfigInputError';
  }
}

/** 引用的配置集不存在（HTTP 404）。 */
export class MenuConfigNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuConfigNotFoundError';
  }
}

/** 租户内 code 唯一键冲突（HTTP 409）。 */
export class MenuConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuConfigConflictError';
  }
}
