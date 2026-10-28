/**
 * 维保专业包域错误 -> HTTP 状态映射（M3 第二波）。
 *
 * 与既有各域过滤器同一装配纪律（域错误类在专业包，映射在组合根）：
 *   MaintenanceInputError    -> 400（请求形状/取值非法）
 *   MaintenanceNotFoundError -> 404（计划/任务/记录不存在或跨租户）
 *   MaintenanceConflictError -> 409（版本乐观锁失配、幂等记账冲突——正常经
 *                               服务层吞成 rejected，此映射兜底直抛路径）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  MaintenanceConflictError,
  MaintenanceInputError,
  MaintenanceNotFoundError,
} from '@smes/maintenance';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(MaintenanceInputError, MaintenanceNotFoundError, MaintenanceConflictError)
export class MaintenanceErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof MaintenanceConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof MaintenanceNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof MaintenanceConflictError
        ? 'maintenance.conflict'
        : exception instanceof MaintenanceNotFoundError
          ? 'maintenance.not_found'
          : 'maintenance.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
