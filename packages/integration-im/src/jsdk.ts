/**
 * JS-SDK 签名后端端口（Done-when #4）。
 *
 * TODO(真凭据接入，刻意留钩子)：厂商 JS-SDK 签名算法常量（规范化串的字段拼接顺序 +
 * 哈希选择）不随本包实现。理由：当前无真实 corp/app 凭据与 jsapi_ticket，任何算法
 * 实现都无法对厂商端验证，落常量只会制造"已实现已验证"的假象（验收纪律：无证据
 * 不宣称完成）。接入真实凭据后在此提供 JsSdkSignatureAlgorithm 具体实现，
 * 并用厂商官方测试向量补单测。
 *
 * 本文件交付的是：纯接口（JsSdkSignatureService）+ 默认实现形状
 * （createJsSdkSignatureService：输入校验 → 凭据解析 → 算法钩子 → 冻结签名组）。
 */
import type { ImSecretRef, ImSecretResolver } from './config.js';
import { deepFreeze } from './internal/freeze.js';
import { isSecretRefShape, requireNonEmptyString } from './internal/guards.js';

/** 签名输入：url + ticket 凭据形状（占位引用，值经解析端口注入）。 */
export interface JsSdkSignatureInput {
  readonly url: string;
  readonly nonceStr: string;
  /** epoch 秒。 */
  readonly timestamp: number;
  readonly ticket: ImSecretRef;
}

/** 签名组：回显 nonce/timestamp 供前端容器 config 直用。 */
export interface JsSdkSignatureOutput {
  readonly signature: string;
  readonly nonceStr: string;
  readonly timestamp: number;
}

export interface JsSdkResolvedTicketInput {
  readonly url: string;
  readonly nonceStr: string;
  readonly timestamp: number;
  readonly ticketValue: string;
}

/** 厂商算法钩子（TODO：见文件头说明）。 */
export type JsSdkSignatureAlgorithm = (resolved: JsSdkResolvedTicketInput) => string;

export interface JsSdkSignatureService {
  sign(input: JsSdkSignatureInput): Promise<JsSdkSignatureOutput>;
}

export interface JsSdkSignatureServiceDeps {
  readonly algorithm: JsSdkSignatureAlgorithm;
  readonly resolveTicket: ImSecretResolver;
}

export function createJsSdkSignatureService(deps: JsSdkSignatureServiceDeps): JsSdkSignatureService {
  return {
    async sign(input) {
      requireNonEmptyString(input.url, 'JsSdkSignatureInput.url');
      requireNonEmptyString(input.nonceStr, 'JsSdkSignatureInput.nonceStr');
      if (!Number.isInteger(input.timestamp) || input.timestamp <= 0) {
        throw new Error('integration-im: JsSdkSignatureInput.timestamp must be a positive integer (epoch seconds)');
      }
      if (!isSecretRefShape(input.ticket)) {
        throw new Error('integration-im: JsSdkSignatureInput.ticket must be an ImSecretRef built via imSecretRef(...)');
      }
      const ticketValue = await deps.resolveTicket(input.ticket);
      requireNonEmptyString(ticketValue, 'resolved jsapi ticket value');
      const signature = deps.algorithm({
        url: input.url,
        nonceStr: input.nonceStr,
        timestamp: input.timestamp,
        ticketValue,
      });
      requireNonEmptyString(signature, 'JsSdkSignatureOutput.signature');
      return deepFreeze({ signature, nonceStr: input.nonceStr, timestamp: input.timestamp });
    },
  };
}
