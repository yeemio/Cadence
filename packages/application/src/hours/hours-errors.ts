/**
 * 工时账（hours）域错误（M2-W6，08-hours.md v1.0）。
 *
 * 与 org/masterdata/baseline/listing 域错误同一纪律：application 零框架，
 * HTTP 状态映射由组合根异常过滤器完成：
 *   HoursInputError    -> 400（请求形状/取值非法——含命令信封字段非法）
 *   HoursNotFoundError -> 404（租户内对象不存在）
 *   HoursConflictError -> 409（sourceKey 唯一约束冲突、快照链分叉等并发竞态）
 *
 * 注意：命令执行的业务性拒绝（乐观锁不符、载荷非法、报工联动形状非法）不走
 * 异常，走 CommandOutcome.rejected（smes.command.v1 结果三分）；异常只用于读
 * 路径（404/400）与存储层唯一键冲突（实现方合同，见 hours-stores.ts）。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class HoursInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoursInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口，跨租户同形不泄漏存在性）。 */
export class HoursNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoursNotFoundError';
  }
}

/** 唯一键约束冲突（HTTP 409；sourceKey 幂等锚点竞态/快照 supersedes 链分叉）。 */
export class HoursConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoursConflictError';
  }
}
