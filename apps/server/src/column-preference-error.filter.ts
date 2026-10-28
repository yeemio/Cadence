/**
 * 列显隐偏好域错误 -> HTTP 状态映射（fix-wave-6 6b-3，A14 / RREQ-INT-032）。
 *
 * 与 UWaveErrorFilter 同一聚合纪律（域错误类在 application，映射在组合根）：
 *   ColumnPreferenceInputError -> 400（page/table 键形状非法、hiddenProps 非数组）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ColumnPreferenceInputError } from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(ColumnPreferenceInputError)
export class ColumnPreferenceErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status = HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code = 'column_preference.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
