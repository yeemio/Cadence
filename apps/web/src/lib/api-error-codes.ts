/**
 * ApiError 语义 code 共享白名单与文案解析（i18n 波 2 接通，PM 2026-10-28
 * §10 缺口修复）：ApiErrorHint（M1 增量 4-I）原有的 15 码白名单与「code →
 * 同码文案」解析提为共享件，供两条页面错误出口（ModuleTable 的 QueryState
 * 与 CommandOutcomeHint）复用——en-US 下命中白名单的 code 出
 * common:error.codes.<code> 英文文案；zh-CN 与白名单外 code / 缺 code 一律
 * 返回 null，由调用方回落各自现状拼接（zh 语义零变化）。
 *
 * 白名单口径不变（PM 明示只需接通既有映射，不扩码集）：码值拼写对照
 * apps/server/tests/error-code-mapping.test.ts；与两语言 common.json 的
 * error.codes 段同集；白名单外 code 不进映射。
 */

/**
 * 高频码白名单（proposal §8 波 2 枚举：auth.* 全量 3 个 + 五个高频域
 * dispatch/workorder/report/inspection/inventory 的 not_found 与
 * state_conflict，dispatch 另含 conflict/invalid_input 全族）。
 */
export const MAPPED_ERROR_CODES: ReadonlySet<string> = new Set([
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

/**
 * en-US + 白名单内 code → common:error.codes.<code> 英文文案；其余（含
 * zh-CN 全部情形、缺 code、白名单外 code）返回 null——调用方据此回落现状。
 * translate 接受带 namespace 前缀的完整键（与 ApiErrorHint 现行调用同形）。
 */
export function mappedErrorCodeCopy(
  code: string | undefined,
  language: string | undefined,
  translate: (key: string) => string,
): string | null {
  if (code === undefined || language !== 'en-US' || !MAPPED_ERROR_CODES.has(code)) {
    return null;
  }
  return translate(`common:error.codes.${code}`);
}
