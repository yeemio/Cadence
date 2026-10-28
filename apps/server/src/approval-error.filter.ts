/**
 * 审批域错误 -> HTTP 状态映射（M1 收尾波-①）。
 *
 * 与 OrgErrorFilter / DomainErrorFilter 同一装配纪律（域错误类在 application，
 * 映射在组合根）；独立成过滤器，注册互不重叠（@Catch 按异常类型命中）：
 *   ApprovalInputError    -> 400（请求形状/取值非法）
 *   ApprovalNotFoundError -> 404（案件不存在/跨租户）
 *   ApprovalConflictError -> 409（版本声明过期、案件 id 冲突、并发版本占用）
 *   ApprovalStateError    -> 409（当前状态不支持该决策：无迁移规则/守卫拒绝/账本对账不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ApprovalConflictError,
  ApprovalInputError,
  ApprovalNotFoundError,
  ApprovalStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  ApprovalInputError,
  ApprovalNotFoundError,
  ApprovalConflictError,
  ApprovalStateError,
)
export class ApprovalErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof ApprovalConflictError || exception instanceof ApprovalStateError
        ? HttpStatus.CONFLICT
        : exception instanceof ApprovalNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof ApprovalConflictError
        ? 'approval.conflict'
        : exception instanceof ApprovalStateError
          ? 'approval.state_conflict'
          : exception instanceof ApprovalNotFoundError
            ? 'approval.not_found'
            : 'approval.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
