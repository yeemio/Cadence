/**
 * 口令强度策略（M2 安全前置批 SP-4，依据 grokbot 终验 D-23 P3）。
 *
 * 放 org 域（消费方全在 org：建号初始口令 + 管理员重置两端点），避免与
 * auth 域写入面交叉。策略校验**仅设置口**——登录不校验（存量弱口令仍可
 * 登录，出清走管理员重置，合同登记为非目标）。
 *
 * 策略面（合同冻结）：
 *  - 最小长度：缺省 8；env SMES_PASSWORD_MIN_LENGTH 覆写（main.ts 读取，
 *    越界 fail-fast 拒启动）；上限 128 维持 org-input 既有口径不变；
 *  - 字符类要求开关：env SMES_PASSWORD_REQUIRE_CLASSES，缺省关闭（渐进
 *    收紧不破既有使用习惯）；开启时要求小写/大写/数字/符号四类中至少三类
 *    （开关冻结于合同，"三类"为实现裁量——NIST SP 800-63B 常见量级）。
 *
 * 词汇纪律（ADR-0010）：password 全通用词。文案不含口令本体与用户信息。
 */

/** 口令长度上界（与 org-input.ts 的 PASSWORD_MAX_LENGTH 同值同义——本域策略面单份口径）。 */
export const PASSWORD_MAX_LENGTH = 128;

export const DEFAULT_PASSWORD_MIN_LENGTH = 8;

export interface PasswordPolicy {
  /** 最小长度（1..PASSWORD_MAX_LENGTH；越界在装配/配置面 fail-fast）。 */
  readonly minLength: number;
  /** 字符类要求（false = 关——缺省，行为与 SP-4 前一致）。 */
  readonly requireClasses: boolean;
}

/** 缺省策略：min 8、字符类关（渐进收紧第一档）。 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: DEFAULT_PASSWORD_MIN_LENGTH,
  requireClasses: false,
};

const CHARACTER_CLASSES: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
const REQUIRED_CLASS_COUNT = 3;

/**
 * 校验口令是否满足策略。满足返回 null；不满足返回拒绝文案（含策略要求，
 * 不含口令本体与用户存在性——调用方以 OrgInputError 400 同族抛出）。
 * 长度上界/非字符串由 org-input 的解析层把关（1..128），此处只查策略增量。
 */
export function passwordPolicyViolation(policy: PasswordPolicy, password: string): string | null {
  if (password.length < policy.minLength) {
    return `口令强度不足：长度至少 ${policy.minLength} 个字符（上限 ${PASSWORD_MAX_LENGTH}）`;
  }
  if (policy.requireClasses) {
    const present = CHARACTER_CLASSES.filter((pattern) => pattern.test(password)).length;
    if (present < REQUIRED_CLASS_COUNT) {
      return `口令强度不足：须至少包含小写字母、大写字母、数字、符号四类中的 ${REQUIRED_CLASS_COUNT} 类`;
    }
  }
  return null;
}

/**
 * 策略配置自校验（fail-fast）：非法策略在装配面抛错，不静默回落——
 * env 解析（main.ts）与 OrgModule.register 装配共用本入口。
 */
export function assertValidPasswordPolicy(policy: PasswordPolicy): void {
  if (
    !Number.isSafeInteger(policy.minLength) ||
    policy.minLength < 1 ||
    policy.minLength > PASSWORD_MAX_LENGTH
  ) {
    throw new Error(
      `口令策略非法：minLength 须为 1~${PASSWORD_MAX_LENGTH} 的整数（当前：${policy.minLength}）——拒绝启动（fail-fast）`,
    );
  }
}
