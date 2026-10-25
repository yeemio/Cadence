/**
 * 服务端拒绝的统一提示（M1 增量 4-I 共享组件）：
 * 403 = 会话身份在服务端无对应策略；400/404/409 = 业务校验。
 * 与 org 页内 ApiErrorHint（M1 增量 3-D 先例）同语义，供 4-I 新页复用。
 */
import { ApiError } from '../data/apiClient';

export function ApiErrorHint({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="text-sm text-destructive">
      {status === 403
        ? `服务端拒绝（403）：当前会话身份未获授权——需管理员在服务端为其授予策略。${message}`
        : `请求失败${status === undefined ? '' : `（${status}）`}：${message}`}
    </p>
  );
}
