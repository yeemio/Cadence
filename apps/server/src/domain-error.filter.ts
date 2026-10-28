/**
 * 基础数据/工作台域错误 -> HTTP 状态映射（M1 增量 4-I）。
 *
 * 与 OrgErrorFilter 同一装配纪律（域错误类在 application，映射在组合根）；
 * 独立成过滤器而非并入 OrgErrorFilter——org 是既有纵贯线，本过滤器只覆盖
 * 4-I 新域错误，两者注册互不重叠（@Catch 按异常类型命中）：
 *   MasterdataInputError / WorkbenchInputError    -> 400（请求形状/取值非法）
 *   MasterdataNotFoundError / WorkbenchNotFoundError -> 404（不存在/非本人）
 *   MasterdataConflictError                       -> 409（租户内 code 冲突）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  MasterdataConflictError,
  MasterdataInputError,
  MasterdataNotFoundError,
  WorkbenchInputError,
  WorkbenchNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  MasterdataInputError,
  MasterdataNotFoundError,
  MasterdataConflictError,
  WorkbenchInputError,
  WorkbenchNotFoundError,
)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof MasterdataConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof MasterdataNotFoundError ||
            exception instanceof WorkbenchNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof MasterdataConflictError
        ? 'masterdata.conflict'
        : exception instanceof MasterdataNotFoundError
          ? 'masterdata.not_found'
          : exception instanceof WorkbenchNotFoundError
            ? 'workbench.not_found'
            : exception instanceof MasterdataInputError
              ? 'masterdata.invalid_input'
              : 'workbench.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
