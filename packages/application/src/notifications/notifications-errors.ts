/**
 * 通知中心域错误（T 波 #101）。
 *
 * 与 org-errors 同一纪律：application 零框架（apps/server/README.md），域错误
 * 用普通 Error 子类表达，HTTP 状态映射由组合根异常过滤器完成
 * （apps/server/src/domain-error.filter.ts：NotificationInputError → 400、
 * NotificationNotFoundError → 404）。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class NotificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationInputError';
  }
}

/** 引用的通知不存在（或非本人——数据级过滤下不可区分，HTTP 404）。 */
export class NotificationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationNotFoundError';
  }
}
