/**
 * U 波新模块错误 -> HTTP 状态映射（U6 接线波：issue / attachment 两域）。
 *
 * 与 BackfillErrorFilter 同一聚合纪律（一个过滤器覆盖一批同期落地的域错误，
 * @Catch 按异常类型命中）。注册互不重叠：T1 三域八类（menu-config ×3 /
 * approval-config ×3 / notifications ×2）已由 CapabilityErrorFilter 覆盖，
 * 本过滤器不重复注册（映射一致，重叠只会造成卫生噪音——U6 验收发现 2 修复）；
 * aftercare-claim 复用 dispatch 域错误类，已由 DispatchErrorFilter 覆盖。
 *   IssueInputError              -> 400（发料查询入参非法）
 *   IssueNotFoundError           -> 404（发料任务/记录/快递单不存在）
 *   IssueConflictError / IssueStateError -> 409（唯一性竞态 / 状态与数据级冲突）
 *   AttachmentInputError         -> 400（附件入参非法）
 *   AttachmentNotFoundError      -> 404（附件不存在 / 引用失效）
 *   AttachmentConflictError      -> 409（bizId 归属不一致）
 *   AttachmentStorageError       -> 502（对象存储端口失败——网关语义，消息无凭据）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  AttachmentConflictError,
  AttachmentInputError,
  AttachmentNotFoundError,
  AttachmentStorageError,
  IssueConflictError,
  IssueInputError,
  IssueNotFoundError,
  IssueStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  IssueInputError,
  IssueNotFoundError,
  IssueConflictError,
  IssueStateError,
  AttachmentInputError,
  AttachmentNotFoundError,
  AttachmentConflictError,
  AttachmentStorageError,
)
export class UWaveErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof AttachmentStorageError
        ? HttpStatus.BAD_GATEWAY
        : exception instanceof IssueNotFoundError ||
            exception instanceof AttachmentNotFoundError
          ? HttpStatus.NOT_FOUND
          : exception instanceof IssueConflictError ||
              exception instanceof IssueStateError ||
              exception instanceof AttachmentConflictError
            ? HttpStatus.CONFLICT
            : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
