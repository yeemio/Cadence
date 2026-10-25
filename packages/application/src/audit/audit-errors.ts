/**
 * 操作日志域错误（S1 backfill：0920 #103）。
 *
 * application 零框架纪律（apps/server/README.md）：域错误用普通 Error 子类，
 * HTTP 状态映射由组合根异常过滤器完成（apps/server/src/backfill-error.filter.ts：
 * AuditInputError → 400）。
 */

/** 查询入参形状/取值非法（HTTP 400）。 */
export class AuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditInputError';
  }
}
