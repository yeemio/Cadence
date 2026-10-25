/**
 * 标准报表域错误（S1 backfill：0920 #89/#91/#92/#96）。
 *
 * application 零框架纪律：域错误用普通 Error 子类，HTTP 状态映射由组合根
 * 异常过滤器完成（apps/server/src/backfill-error.filter.ts：
 * Input → 400、NotFound → 404、Source → 503）。
 */

/** 查询入参形状/取值非法（HTTP 400）。 */
export class StandardReportsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardReportsInputError';
  }
}

/** 引用的报表口径不存在（HTTP 404）。 */
export class StandardReportsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardReportsNotFoundError';
  }
}

/**
 * 事实源未绑定/不可用（HTTP 503）——零 DB boot 形态求值时的诚实失败：
 * 口径在、数据面缺。不静默返回空结果（空结果会被误读为"无数据"）。
 */
export class StandardReportsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardReportsSourceError';
  }
}
