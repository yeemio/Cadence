/**
 * RuleIntentRouter —— 意图路由 v1 确定性默认实现（CONTRACT v1 §意图路由）。
 *
 * 无模型：纯词法规则，页面明示「规则引擎模式·未接入 AI 模型」。DSH 真实
 * 运行服务接入时替换 IntentRouter 实现层，能力执行与权限留在 Cadence。
 *
 * 规则（首版最小集，判定顺序固定）：
 *  1. 缺口词（缺料/齐套/物料/材料）→ material-gap（主体线索 = 编号/项目名词）；
 *  2. 进度词（进度/做到/完成/剩）→ workorder-progress；
 *  3. 质检词（检验/质量/不合格/返工/特采）→ quality-inspection（携带时间词解析
 *     结果；无时间词 timeRange=null，由服务层发澄清选项）；
 *  4. 未命中 → unsupported。
 *
 * 主体线索 token：剥离时间词后，问题中含数字的连续串（工作令编号或编号尾号、
 * 项目名内嵌数字段）；token 为空 = 泛主体（服务层回落到租户工作令候选）。
 * 多词命中时缺口词优先（齐套/缺料指向更具体的数据需求）；中文数字时间词
 * （如「最近七天」）v1 不解析——确定性回落到时间澄清。
 */
import type { AiQueryIntent, AiQueryTimeRange, IntentRouter } from './ai-query-ports.js';
import { MAX_LAST_N_DAYS } from './ai-query-time.js';

const GAP_WORDS = ['缺料', '齐套', '物料', '材料'] as const;
const PROGRESS_WORDS = ['进度', '做到', '完成', '剩'] as const;
const QUALITY_WORDS = ['检验', '质量', '不合格', '返工', '特采'] as const;

/** 时间词（解析前先剥离，避免「7」混入主体线索 token）。 */
const TIME_PHRASE_PATTERN = /(?:今日|今天|本周|(?:最近|近|过去)\s*[0-9]+\s*天)/g;
const LAST_N_DAYS_PATTERN = /(?:最近|近|过去)\s*([0-9]+)\s*天/;

/** 时间词解析：今日/本周/最近N天（N 为 1~366 整数；越界/无数字视为无时间词）。 */
export function parseTimePhrase(question: string): AiQueryTimeRange | null {
  if (/今日|今天/.test(question)) return { kind: 'today' };
  if (/本周/.test(question)) return { kind: 'this-week' };
  const match = LAST_N_DAYS_PATTERN.exec(question);
  if (match !== null) {
    const days = Number(match[1]);
    if (Number.isInteger(days) && days >= 1 && days <= MAX_LAST_N_DAYS) {
      return { kind: 'last-n-days', days };
    }
  }
  return null;
}

/** 主体线索 token：剥离时间词后，含数字的连续拉丁/数字/连字符串（小写归一）。 */
export function extractSubjectTokens(question: string): readonly string[] {
  const stripped = question.replace(TIME_PHRASE_PATTERN, ' ');
  const matches = stripped.match(/[A-Za-z0-9][A-Za-z0-9\-_.]*/g) ?? [];
  return [...new Set(matches.filter((token) => /[0-9]/.test(token)).map((token) => token.toLowerCase()))];
}

/** 确定性规则路由（纯函数：无存储访问、无副作用）。 */
export class RuleIntentRouter implements IntentRouter {
  route(question: string): AiQueryIntent {
    const gap = GAP_WORDS.some((word) => question.includes(word));
    if (gap) {
      return { kind: 'routed', capabilityId: 'material-gap', subjectTokens: extractSubjectTokens(question) };
    }
    const progress = PROGRESS_WORDS.some((word) => question.includes(word));
    if (progress) {
      return { kind: 'routed', capabilityId: 'workorder-progress', subjectTokens: extractSubjectTokens(question) };
    }
    const quality = QUALITY_WORDS.some((word) => question.includes(word));
    if (quality) {
      return { kind: 'routed', capabilityId: 'quality-inspection', timeRange: parseTimePhrase(question) };
    }
    return { kind: 'unsupported' };
  }
}
