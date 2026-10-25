/**
 * 审批域错误（M1 收尾波-①）。
 *
 * 与 org/masterdata/workbench 域错误同一纪律：application 零框架，HTTP 状态
 * 映射由组合根异常过滤器完成（apps/server/src/approval-error.filter.ts）：
 *   ApprovalInputError    -> 400（请求形状/取值非法）
 *   ApprovalNotFoundError -> 404（租户内案件不存在）
 *   ApprovalConflictError -> 409（版本声明过期/与当前案件版本不符）
 *   ApprovalStateError    -> 409（当前状态不支持该命令：无迁移规则、守卫拒绝、
 *                              或事件账本与案件行不一致——数据级冲突，非请求形状错）
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class ApprovalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalInputError';
  }
}

/** 案件不存在（HTTP 404；租户内收口，跨租户同形不泄漏存在性）。 */
export class ApprovalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalNotFoundError';
  }
}

/** 版本冲突（HTTP 409）：提交的 objectVersion 声明与案件当前版本不符。 */
export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

/**
 * 状态冲突（HTTP 409）：当前状态下命令不可用——配置无该迁移规则（unhandled）、
 * 守卫拒绝（blocked）或事件账本与案件行版本不一致（写入中断/并发窗口）。
 */
export class ApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalStateError';
  }
}
