/**
 * 渠道配置与凭据占位形状（Done-when #2）。
 *
 * 纪律：本包永不持有明文凭据——配置只携带 ImSecretRef 占位引用，
 * 运行时由宿主经 ImSecretResolver 注入值；禁硬编码任何真实密钥样例。
 * apiBaseUrl 可覆写（私有化部署走网关代理，ADR-0005 双形态）。
 */
import { deepFreeze } from './internal/freeze.js';
import { isSecretRefShape, requireNonEmptyString } from './internal/guards.js';

/** M1 双生态平台集；扩展生态 = 增补字面量 + 新适配器，端口不动。 */
export type ImPlatform = 'wecom' | 'feishu';

export function assertImPlatform(value: ImPlatform): void {
  if (value !== 'wecom' && value !== 'feishu') {
    throw new Error(`integration-im: unknown ImPlatform "${String(value)}"`);
  }
}

/** 凭据占位引用：指向宿主凭据仓（示例：'secret://wecom/corp-secret'），不是凭据值。 */
export interface ImSecretRef {
  readonly kind: 'secret-ref';
  readonly ref: string;
}

export function imSecretRef(ref: string): ImSecretRef {
  requireNonEmptyString(ref, 'ImSecretRef.ref');
  return deepFreeze({ kind: 'secret-ref' as const, ref });
}

/** 凭据解析端口：把占位引用解析为运行时凭据值（由组合根注入实现）。 */
export type ImSecretResolver = (ref: ImSecretRef) => Promise<string>;

export const WECOM_API_BASE_URL_DEFAULT = 'https://qyapi.weixin.qq.com';
export const FEISHU_API_BASE_URL_DEFAULT = 'https://open.feishu.cn';

export interface WecomImChannelConfig {
  readonly platform: 'wecom';
  readonly corpId: string;
  readonly agentId: number;
  readonly corpSecret: ImSecretRef;
  readonly callbackToken: ImSecretRef;
  readonly callbackEncodingAesKey: ImSecretRef | undefined;
  readonly apiBaseUrl: string;
}

export function wecomImConfig(input: {
  corpId: string;
  agentId: number;
  corpSecret: ImSecretRef;
  callbackToken: ImSecretRef;
  callbackEncodingAesKey?: ImSecretRef;
  apiBaseUrl?: string;
}): WecomImChannelConfig {
  requireNonEmptyString(input.corpId, 'WecomImChannelConfig.corpId');
  if (!Number.isInteger(input.agentId) || input.agentId <= 0) {
    throw new Error('integration-im: WecomImChannelConfig.agentId must be a positive integer');
  }
  assertSecretRef(input.corpSecret, 'corpSecret');
  assertSecretRef(input.callbackToken, 'callbackToken');
  if (input.callbackEncodingAesKey !== undefined) {
    assertSecretRef(input.callbackEncodingAesKey, 'callbackEncodingAesKey');
  }
  return deepFreeze({
    platform: 'wecom' as const,
    corpId: input.corpId,
    agentId: input.agentId,
    corpSecret: input.corpSecret,
    callbackToken: input.callbackToken,
    callbackEncodingAesKey: input.callbackEncodingAesKey,
    apiBaseUrl: input.apiBaseUrl ?? WECOM_API_BASE_URL_DEFAULT,
  });
}

export interface FeishuImChannelConfig {
  readonly platform: 'feishu';
  readonly appId: string;
  readonly appSecret: ImSecretRef;
  readonly verificationToken: ImSecretRef;
  readonly encryptKey: ImSecretRef | undefined;
  readonly apiBaseUrl: string;
}

export function feishuImConfig(input: {
  appId: string;
  appSecret: ImSecretRef;
  verificationToken: ImSecretRef;
  encryptKey?: ImSecretRef;
  apiBaseUrl?: string;
}): FeishuImChannelConfig {
  requireNonEmptyString(input.appId, 'FeishuImChannelConfig.appId');
  assertSecretRef(input.appSecret, 'appSecret');
  assertSecretRef(input.verificationToken, 'verificationToken');
  if (input.encryptKey !== undefined) {
    assertSecretRef(input.encryptKey, 'encryptKey');
  }
  return deepFreeze({
    platform: 'feishu' as const,
    appId: input.appId,
    appSecret: input.appSecret,
    verificationToken: input.verificationToken,
    encryptKey: input.encryptKey,
    apiBaseUrl: input.apiBaseUrl ?? FEISHU_API_BASE_URL_DEFAULT,
  });
}

function assertSecretRef(value: ImSecretRef, label: string): void {
  if (!isSecretRefShape(value)) {
    throw new Error(
      `integration-im: ${label} must be an ImSecretRef built via imSecretRef(...); raw secret strings are forbidden`,
    );
  }
}
