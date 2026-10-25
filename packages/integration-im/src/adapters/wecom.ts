/**
 * 企微（企业微信）适配器。
 *
 * 分层：纯映射（可逆 codec，单测不触传输）+ 渠道编排（ImTransport + 令牌提供器 + 身份目录）。
 * 厂商 HTTP 细节（gettoken / message/send 端点、载荷形状）封在本文件（ADR-0003 #6）。
 * 回调原文本体是 XML：本包定义 JSON 投影形状（WecomCallbackBody），XML 解析与
 * AES 解密属真凭据接入阶段（见 README 风险）。
 */
import type { TenantIdType } from '@smes/business-core';
import { TransportTokenProvider } from '../access-token.js';
import type { TokenExchange } from '../access-token.js';
import type { WecomImChannelConfig, ImSecretResolver } from '../config.js';
import type { IMessageChannel, ImSendResult } from '../channel.js';
import type { ImIdentityBinding, ImIdentityDirectory } from '../identity.js';
import { createInMemoryImIdentityDirectory } from '../identity.js';
import { decodeImTextInbound, imInboundEvent, imUserRef } from '../inbound.js';
import type { ImInbound } from '../inbound.js';
import { decodeCardFieldLine, encodeCardFieldLine, imCardMessage, imTextMessage } from '../message.js';
import type { ImOutboundMessage } from '../message.js';
import type { ImTransport } from '../transport.js';
import { isRecord } from '../internal/guards.js';

/** textcard 按钮文案：UI 常量，不属统一模型（逆映射不回读）。 */
export const WECOM_CARD_BUTTON_TEXT = '详情';

export interface WecomSendTextPayload {
  readonly touser: string;
  readonly msgtype: 'text';
  readonly agentid: number;
  readonly text: { readonly content: string };
}

export interface WecomSendTextCardPayload {
  readonly touser: string;
  readonly msgtype: 'textcard';
  readonly agentid: number;
  readonly textcard: {
    readonly title: string;
    readonly description: string;
    readonly url: string;
    readonly btntxt: string;
  };
}

export type WecomSendPayload = WecomSendTextPayload | WecomSendTextCardPayload;

export function wecomOutboundToPayload(message: ImOutboundMessage, agentId: number): WecomSendPayload {
  if (message.kind === 'text') {
    return { touser: message.to.imUserId, msgtype: 'text', agentid: agentId, text: { content: message.text } };
  }
  return {
    touser: message.to.imUserId,
    msgtype: 'textcard',
    agentid: agentId,
    textcard: {
      title: message.title,
      description: message.fields.map(encodeCardFieldLine).join('\n'),
      url: message.url ?? '',
      btntxt: WECOM_CARD_BUTTON_TEXT,
    },
  };
}

export function wecomPayloadToOutbound(payload: WecomSendPayload): ImOutboundMessage {
  if (payload.msgtype === 'text') {
    return imTextMessage({ to: payload.touser, text: payload.text.content });
  }
  const card = payload.textcard;
  return imCardMessage({
    to: payload.touser,
    title: card.title,
    fields: card.description.split('\n').map(decodeCardFieldLine),
    url: card.url === '' ? undefined : card.url,
  });
}

/** 企微回调 JSON 投影（原生 XML 解析属真凭据接入阶段）。 */
export interface WecomCallbackBody {
  readonly echostr?: string;
  readonly MsgType?: string;
  readonly Content?: string;
  readonly FromUserName?: string;
  readonly MsgId?: number | string;
  readonly Event?: string;
  readonly [key: string]: unknown;
}

export const wecomTokenExchange: TokenExchange<WecomImChannelConfig> = {
  describeRequest(config, resolvedSecret) {
    const url = `${config.apiBaseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(resolvedSecret)}`;
    return { method: 'GET', url, headers: {}, body: undefined };
  },
  parseResponse(body) {
    if (
      isRecord(body) &&
      body['errcode'] === 0 &&
      typeof body['access_token'] === 'string' &&
      typeof body['expires_in'] === 'number'
    ) {
      return { token: body['access_token'], expiresInSeconds: body['expires_in'] };
    }
    const errcode = isRecord(body) && typeof body['errcode'] === 'number' ? body['errcode'] : 'unparseable';
    const errmsg = isRecord(body) && typeof body['errmsg'] === 'string' ? body['errmsg'] : 'non-conformant gettoken response';
    throw new Error(`integration-im: wecom gettoken failed (errcode=${String(errcode)}): ${errmsg}`);
  },
};

export interface WecomImChannelDeps {
  readonly transport: ImTransport;
  readonly config: WecomImChannelConfig;
  readonly resolveSecret: ImSecretResolver;
  /** epoch 毫秒；默认 Date.now。 */
  readonly clock?: () => number;
  readonly identities?: ImIdentityDirectory;
}

export class WecomImChannel implements IMessageChannel {
  readonly platform = 'wecom' as const;

  private readonly config: WecomImChannelConfig;
  private readonly transport: ImTransport;
  private readonly identities: ImIdentityDirectory;
  private readonly tokens: TransportTokenProvider<WecomImChannelConfig>;

  constructor(deps: WecomImChannelDeps) {
    this.config = deps.config;
    this.transport = deps.transport;
    this.identities = deps.identities ?? createInMemoryImIdentityDirectory();
    this.tokens = new TransportTokenProvider<WecomImChannelConfig>({
      transport: deps.transport,
      clock: deps.clock ?? Date.now,
      config: deps.config,
      exchange: wecomTokenExchange,
      credentialRef: deps.config.corpSecret,
      resolveSecret: deps.resolveSecret,
    });
  }

  async send(message: ImOutboundMessage): Promise<ImSendResult> {
    let accessToken: string;
    try {
      accessToken = await this.tokens.accessToken();
    } catch (error) {
      return failure('wecom.token-exchange-failed', error);
    }
    const payload = wecomOutboundToPayload(message, this.config.agentId);
    const url = `${this.config.apiBaseUrl}/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    let response;
    try {
      response = await this.transport.send({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
    } catch (error) {
      return failure('wecom.transport-error', error);
    }
    return mapWecomSendResponse(response.status, response.body);
  }

  receive(rawCallback: unknown): ImInbound {
    if (!isRecord(rawCallback)) {
      return imInboundEvent({ eventType: 'wecom.unknown', payload: {}, from: undefined, raw: rawCallback });
    }
    const body = rawCallback as WecomCallbackBody;
    if (typeof body.echostr === 'string') {
      return imInboundEvent({
        eventType: 'wecom.callback.verification',
        payload: { echostr: body.echostr },
        from: undefined,
        raw: rawCallback,
      });
    }
    if (body.MsgType === 'text' && typeof body.Content === 'string' && typeof body.FromUserName === 'string') {
      return decodeImTextInbound({
        text: body.Content,
        from: imUserRef('wecom', body.FromUserName),
        imMessageId: body.MsgId === undefined ? undefined : String(body.MsgId),
        raw: rawCallback,
      });
    }
    if (body.MsgType === 'event') {
      const eventName = typeof body.Event === 'string' && body.Event.length > 0 ? body.Event : 'unnamed';
      return imInboundEvent({ eventType: `wecom.event.${eventName}`, payload: rawCallback, from: undefined, raw: rawCallback });
    }
    return imInboundEvent({ eventType: 'wecom.unknown', payload: rawCallback, from: undefined, raw: rawCallback });
  }

  bindIdentity(binding: ImIdentityBinding): ImIdentityBinding {
    if (binding.platform !== 'wecom') {
      throw new Error(`integration-im: WecomImChannel rejected a "${binding.platform}" binding`);
    }
    this.identities.bind(binding);
    return binding;
  }

  resolveIdentity(imUserId: string, tenantId: TenantIdType): ImIdentityBinding | undefined {
    return this.identities.resolve('wecom', tenantId, imUserId);
  }
}

function mapWecomSendResponse(status: number, body: unknown): ImSendResult {
  if (status !== 200) {
    return { ok: false, code: `wecom.http-${status}`, message: 'message/send returned non-200' };
  }
  if (isRecord(body) && body['errcode'] === 0) {
    return { ok: true, vendorMessageId: undefined };
  }
  if (isRecord(body) && typeof body['errcode'] === 'number') {
    const errmsg = typeof body['errmsg'] === 'string' ? body['errmsg'] : 'message/send rejected';
    return { ok: false, code: `wecom.${String(body['errcode'])}`, message: errmsg };
  }
  return { ok: false, code: 'wecom.unparseable-ack', message: 'message/send ack does not conform' };
}

function failure(code: string, error: unknown): ImSendResult {
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}
