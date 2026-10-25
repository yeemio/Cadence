/**
 * maintenance 域错误（M3，m3-drafts/02-maintenance.md v1.0）。
 *
 * 与 payroll/hours/costing 域错误同一纪律：本包零框架，HTTP 状态映射由组合根异常
 * 过滤器完成：
 *   MaintenanceInputError    -> 400（请求形状/取值非法——含命令信封字段非法）
 *   MaintenanceNotFoundError -> 404（租户内对象不存在）
 *   MaintenanceConflictError -> 409（计划版本唯一约束冲突、任务 sourceKey 到期
 *                                锚点碰撞、事件 eventId 碰撞等并发竞态）
 *
 * 命令执行的业务性拒绝不走异常，走 CommandOutcome.rejected（smes.command.v1
 * 结果三分）；异常只用于读路径与存储层唯一键冲突（实现方合同）。
 *
 * 跨包结构同形防线（pro-pack-tier-edges 推论）：business-store 的 PG 适配
 * **不得 import 本包**（dep-cruiser 禁止），其冲突信号用同形本地类承载——
 * isMaintenanceConflict 按 name 识别（本包真类 or business-store 同形镜像类），
 * 不依赖跨包 instanceof。
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class MaintenanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceInputError';
  }
}

/** 对象不存在（HTTP 404；租户内收口，跨租户同形不泄漏存在性）。 */
export class MaintenanceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceNotFoundError';
  }
}

/** 唯一键约束冲突（HTTP 409；计划版本竞态/任务到期锚点碰撞/事件幂等锚点碰撞）。 */
export class MaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConflictError';
  }
}

/**
 * 冲突信号判定（跨包结构同形）：本包实现抛 MaintenanceConflictError 同包真类；
 * business-store PG 适配（不 import 本包）抛 name 同形的镜像类。服务层
 * 统一经本函数识别，两端口实现同一可观察行为。
 */
export function isMaintenanceConflict(error: unknown): error is MaintenanceConflictError {
  if (error instanceof MaintenanceConflictError) return true;
  return error instanceof Error && error.name === 'MaintenanceConflictError';
}
