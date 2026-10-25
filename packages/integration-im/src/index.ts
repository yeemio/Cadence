/**
 * @smes/integration-im —— 企微/飞书 IM 双生态适配层（IMessageChannel，M1）。
 *
 * 纯端口 + 可逆映射 + 注入式传输：不引任何厂商 SDK/运行时依赖，纯域可测。
 * 词汇纪律（ADR-0010）：统一层词汇厂商中立（Im*）；厂商词汇只出现在 adapters/ 与配置名。
 */
export {
  assertImPlatform,
  imSecretRef,
  wecomImConfig,
  feishuImConfig,
  WECOM_API_BASE_URL_DEFAULT,
  FEISHU_API_BASE_URL_DEFAULT,
} from './config.js';
export type {
  ImPlatform,
  ImSecretRef,
  ImSecretResolver,
  WecomImChannelConfig,
  FeishuImChannelConfig,
} from './config.js';

export type { ImHttpMethod, ImTransportRequest, ImTransportResponse, ImTransport } from './transport.js';

export {
  imRecipient,
  imTextMessage,
  imCardMessage,
  encodeCardFieldLine,
  decodeCardFieldLine,
  CARD_FIELD_SEPARATOR,
} from './message.js';
export type { ImRecipient, ImCardField, ImTextMessage, ImCardMessage, ImOutboundMessage } from './message.js';

export { imUserRef, imInboundCommand, imInboundEvent, decodeImTextInbound, IM_TEXT_EVENT_TYPE } from './inbound.js';
export type { ImUserRef, ImInboundCommand, ImInboundEvent, ImInbound } from './inbound.js';

export type { ImSendResult, IMessageChannel } from './channel.js';

export { imIdentityBinding, createInMemoryImIdentityDirectory } from './identity.js';
export type { ImIdentityBinding, ImIdentityDirectory } from './identity.js';

export { TransportTokenProvider, TOKEN_REFRESH_MARGIN_MS } from './access-token.js';
export type { TokenExchange, VendorTokenExchangeResult } from './access-token.js';

export { createJsSdkSignatureService } from './jsdk.js';
export type {
  JsSdkSignatureInput,
  JsSdkSignatureOutput,
  JsSdkSignatureAlgorithm,
  JsSdkResolvedTicketInput,
  JsSdkSignatureService,
  JsSdkSignatureServiceDeps,
} from './jsdk.js';

export { verifyImCallbackSignature, DEFAULT_CALLBACK_WINDOW_SECONDS } from './callback-verify.js';
export type {
  ImCallbackVerifyInput,
  ImCallbackVerifyDeps,
  ImCallbackVerifyDecision,
} from './callback-verify.js';

export {
  WECOM_CARD_BUTTON_TEXT,
  wecomOutboundToPayload,
  wecomPayloadToOutbound,
  wecomTokenExchange,
  WecomImChannel,
} from './adapters/wecom.js';
export type {
  WecomSendTextPayload,
  WecomSendTextCardPayload,
  WecomSendPayload,
  WecomCallbackBody,
  WecomImChannelDeps,
} from './adapters/wecom.js';

export {
  FEISHU_CARD_BUTTON_TEXT,
  feishuOutboundToPayload,
  feishuPayloadToOutbound,
  feishuTokenExchange,
  FeishuImChannel,
} from './adapters/feishu.js';
export type { FeishuSendPayload, FeishuCallbackBody, FeishuImChannelDeps } from './adapters/feishu.js';
