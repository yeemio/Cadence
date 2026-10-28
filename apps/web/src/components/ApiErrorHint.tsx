/**
 * 服务端拒绝的统一提示（M1 增量 4-I 共享组件）：
 * 403 = 会话身份在服务端无对应策略；400/404/409 = 业务校验。
 * 与 org 页内 ApiErrorHint（M1 增量 3-D 先例）同语义，供 4-I 新页复用。
 *
 * i18n 波 1（ADR-0012）：固定前缀句走 common namespace t()；后端 message
 * 中文原文原样拼接。
 * i18n 波 2（ADR-0012 决定 3 / proposal §4 §8）：ApiError 透出服务端语义 code
 * （apiClient.ts 解析响应体 code 字段）后——en-US 下命中高频码白名单时改出
 * common:error.codes.<code> 英文文案；zh-CN 维持「前缀句 + message 原文拼接」
 * 现状（zh 语义零变化；common.json 双语 codes 段为同码权威文案，zh 侧本组件
 * 暂不取用）；白名单外 code / 缺 code / 非 ApiError 一律回落现状拼接。
 */
import { useTranslation } from 'react-i18next';
import { ApiError } from '../data/apiClient';

/**
 * 高频码白名单（proposal §8 波 2 枚举：auth.* 全量 3 个 + 五个高频域
 * dispatch/workorder/report/inspection/inventory 的 not_found 与
 * state_conflict，dispatch 另含 conflict/invalid_input 全族）——码值拼写
 * 对照 apps/server/tests/error-code-mapping.test.ts；与两语言 common.json
 * 的 error.codes 段同集；白名单外 code 不进映射。
 * （波 2 实装注：块注释内禁写"斜杠+星号收尾"字样——它会提前终止注释，
 * 前任半成品的 tsc 全树不编译即此处。）
 */
const MAPPED_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth.invalid_input',
  'auth.invalid_credentials',
  'auth.rate_limited',
  'dispatch.invalid_input',
  'dispatch.not_found',
  'dispatch.conflict',
  'dispatch.state_conflict',
  'workorder.not_found',
  'workorder.state_conflict',
  'report.not_found',
  'report.state_conflict',
  'inspection.not_found',
  'inspection.state_conflict',
  'inventory.not_found',
  'inventory.state_conflict',
]);

export function ApiErrorHint({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation();
  const status = error instanceof ApiError ? error.status : undefined;
  const code = error instanceof ApiError ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  // en-US + 白名单内 code → 英文同码文案；其余（含 zh-CN 全部情形）回落现状
  const codeCopy =
    code !== undefined && i18n.language === 'en-US' && MAPPED_ERROR_CODES.has(code)
      ? t(`common:error.codes.${code}`)
      : null;
  if (codeCopy !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {codeCopy}
      </p>
    );
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {status === 403
        ? t('common:error.forbidden403', { message })
        : t('common:error.requestFailed', {
            status: status === undefined ? '' : `（${status}）`,
            message,
          })}
    </p>
  );
}
