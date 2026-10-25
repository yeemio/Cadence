/**
 * 技术准备（baseline）域错误（M2-W2，P1 子集：工序库/物料校验/外协计价/设备台账）。
 *
 * 与 org/masterdata/approval 域错误同一纪律：application 零框架，HTTP 状态映射
 * 由组合根异常过滤器完成：
 *   BaselineInputError    -> 400（请求形状/取值非法——含命令信封字段非法）
 *   BaselineNotFoundError -> 404（租户内对象不存在）
 *   BaselineConflictError -> 409（唯一键/版本唯一约束冲突、并发修订竞态）
 *
 * 注意：命令执行的业务性拒绝（乐观锁不符、code 已存在、payload 非法）不走异常，
 * 走 CommandOutcome.rejected（smes.command.v1 结果三分）；异常只用于读路径
 * （404/400）与存储层唯一键冲突（实现方合同，见 baseline-stores.ts）。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class BaselineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口，跨租户同形不泄漏存在性）。 */
export class BaselineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineNotFoundError';
  }
}

/** 唯一键/版本唯一约束冲突（HTTP 409；并发同版本写入竞态由存储实现方抛出）。 */
export class BaselineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineConflictError';
  }
}
