/**
 * 飞书适配器。
 *
 * 分层：纯映射（可逆 codec，单测不触传输）+ 渠道编排（ImTransport + 令牌提供器 + 身份目录）。
 * 厂商 HTTP 细节（tenant_access_token / im/v1/messages 端点、content 双层 JSON 形状）
 * 封在本文件（ADR-0003 #6）。M1 收件人口径 = open_id（receive_id_type=open_id）。
 */
import type { TenantIdType } from '@smes/business-core';
import { TransportTokenProvider } from '../access-token.js';
import type { TokenExchange } from '../access-token.js';
import type { FeishuImChannelConfig, ImSecretResolver } from '../config.js';
import type { IMessageChannel, ImSendResult } from '../channel.js';
import type { ImIdentityBinding, ImIdentityDirectory } from '../identity.js';
import { createInMemoryImIdentityDirectory } from '../identity.js';
import { decodeImTextInbound, imInboundEvent, imUserRef } from '../inbound.js';
import type { ImInbound } from '../inbound.js';
import { decodeCardFieldLine, encodeCardFieldLine, imCardMessage, imTextMessage } from '../message.js';
import type { ImCardField, ImOutboundMessage } from '../message.js';
import type { ImTransport } from '../transport.js';
import { isRecord } from '../internal/guards.js';

/** 卡片 action 按钮文案：UI 常量，不属统一模型（逆映射只读 url）。 */
export const FEISHU_CARD_BUTTON_TEXT = '详情';

/** 飞书发送载荷：content 是 JSON 字符串（厂商双层 JSON 形状）。 */
export interface FeishuSendPayload {
  readonly receive_id: string;
  readonly msg_type: 'text' | 'interactive';
  readonly content: string;
}

export function feishuOutboundToPayload(message: ImOutboundMessage): FeishuSendPayload {
  if (message.kind === 'text') {
    return { receive_id: message.to.imUserId, msg_type: 'text', content: JSON.stringify({ text: message.text }) };
  }
  const elements: unknown[] = [
    {
      tag: 'div',
      fields: message.fields.map((field) => ({
        is_short: true,
        text: { tag: 'lark_md', content: encodeCardFieldLine(field) },
      })),
    },
  ];
  if (message.url !== undefined) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: FEISHU_CARD_BUTTON_TEXT },
          type: 'primary',
          url: message.url,
        },
      ],
    });
  }
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: message.title } },
    elements,
  };
  return { receive_id: message.to.imUserId, msg_type: 'interactive', content: JSON.stringify(card) };
}

export function feishuPayloadToOutbound(payload: FeishuSendPayload): ImOutboundMessage {
  if (payload.msg_type === 'text') {
    const parsed = parseJsonObject(payload.content);
    if (parsed === undefined || !isRecord(parsed) || typeof parsed['text'] !== 'string') {
      throw new Error('integration-im: feishu text payload content does not conform');
    }
    return imTextMessage({ to: payload.receive_id, text: parsed['text'] });
  }
  const card = parseJsonObject(payload.content);
  if (card === undefined || !isRecord(card) || !isRecord(card['header']) || !isRecord(card['header']['title'])) {
    throw new Error('integration-im: feishu interactive payload content does not conform');
  }
  const title = card['header']['title']['content'];
  if (typeof title !== 'string') {
    throw new Error('integration-im: feishu interactive payload header.title.content must be a string');
  }
  const elements = Array.isArray(card['elements']) ? card['elements'] : [];
  const fields: ImCardField[] = [];
  let url: string | undefined;
  for (const element of elements) {
    if (!isRecord(element)) continue;
    if (element['tag'] === 'div' && Array.isArray(element['fields'])) {
      for (const field of element['fields']) {
        if (isRecord(field) && isRecord(field['text']) && typeof field['text']['content'] === 'string') {
          fields.push(decodeCardFieldLine(field['text']['content']));
        }
      }
    }
    if (url === undefined && element['tag'] === 'action' && Array.isArray(element['actions'])) {
      url = extractActionUrl(element['actions']);
    }
  }
  return imCardMessage({ to: payload.receive_id, title, fields, url });
}

/** 企微侧对应形状见 wecom.ts；飞书 v2 事件回调 + url_verification 握手。 */
export interface FeishuCallbackBody {
  readonly type?: string;
  readonly challenge?: string;
  readonly header?: { readonly event_type?: string; readonly [key: string]: unknown };
  readonly event?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export const feishuTokenExchange: TokenExchange<FeishuImChannelConfig> = {
  describeRequest(config, resolvedSecret) {
    return {
      method: 'POST',
      url: `${config.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      headers: { 'content-type': 'application/json' },
      body: { app_id: config.appId, app_secret: resolvedSecret },
    };
  },
  parseResponse(body) {
    if (
      isRecord(body) &&
      body['code'] === 0 &&
      typeof body['tenant_access_token'] === 'string' &&
      typeof body['expire'] === 'number'
    ) {
      return { token: body['tenant_access_token'], expiresInSeconds: body['expire'] };
    }
    const code = isRecord(body) && typeof body['code'] === 'number' ? body['code'] : 'unparseable';
    const msg = isRecord(body) && typeof body['msg'] === 'string' ? body['msg'] : 'non-conformant tenant_access_token response';
    throw new Error(`integration-im: feishu tenant_access_token failed (code=${String(code)}): ${msg}`);
  },
};

export interface FeishuImChannelDeps {
  readonly transport: ImTransport;
  readonly config: FeishuImChannelConfig;
  readonly resolveSecret: ImSecretResolver;
  /** epoch 毫秒；默认 Date.now。 */
  readonly clock?: () => number;
  readonly identities?: ImIdentityDirectory;
}

export class FeishuImChannel implements IMessageChannel {
  readonly platform = 'feishu' as const;

  private readonly config: FeishuImChannelConfig;
  private readonly transport: ImTransport;
  private readonly identities: ImIdentityDirectory;
  private readonly tokens: TransportTokenProvider<FeishuImChannelConfig>;

  constructor(deps: FeishuImChannelDeps) {
    this.config = deps.config;
    this.transport = deps.transport;
    this.identities = deps.identities ?? createInMemoryImIdentityDirectory();
    this.tokens = new TransportTokenProvider<FeishuImChannelConfig>({
      transport: deps.transport,
      clock: deps.clock ?? Date.now,
      config: deps.config,
      exchange: feishuTokenExchange,
      credentialRef: deps.config.appSecret,
      resolveSecret: deps.resolveSecret,
    });
  }

  async send(message: ImOutboundMessage): Promise<ImSendResult> {
    let tenantAccessToken: string;
    try {
      tenantAccessToken = await this.tokens.accessToken();
    } catch (error) {
      return failure('feishu.token-exchange-failed', error);
    }
    const payload = feishuOutboundToPayload(message);
    const url = `${this.config.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`;
    let response;
    try {
      response = await this.transport.send({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantAccessToken}` },
        body: payload,
      });
    } catch (error) {
      return failure('feishu.transport-error', error);
    }
    return mapFeishuSendResponse(response.status, response.body);
  }

  receive(rawCallback: unknown): ImInbound {
    if (!isRecord(rawCallback)) {
      return imInboundEvent({ eventType: 'feishu.unknown', payload: {}, from: undefined, raw: rawCallback });
    }
    if (rawCallback['type'] === 'url_verification' && typeof rawCallback['challenge'] === 'string') {
      return imInboundEvent({
        eventType: 'feishu.callback.verification',
        payload: { challenge: rawCallback['challenge'] },
        from: undefined,
        raw: rawCallback,
      });
    }
    const header = isRecord(rawCallback['header']) ? rawCallback['header'] : undefined;
    const eventType = header !== undefined && typeof header['event_type'] === 'string' ? header['event_type'] : undefined;
    const event = isRecord(rawCallback['event']) ? rawCallback['event'] : {};
    if (eventType === 'im.message.receive_v1') {
      const decoded = decodeFeishuTextMessage(event, rawCallback);
      if (decoded !== undefined) {
        return decoded;
      }
    }
    if (eventType !== undefined) {
      const openId = extractFeishuOpenId(event);
      return imInboundEvent({
        eventType: `feishu.event.${eventType}`,
        payload: event,
        from: openId === undefined ? undefined : imUserRef('feishu', openId),
        raw: rawCallback,
      });
    }
    return imInboundEvent({ eventType: 'feishu.unknown', payload: rawCallback, from: undefined, raw: rawCallback });
  }

  bindIdentity(binding: ImIdentityBinding): ImIdentityBinding {
    if (binding.platform !== 'feishu') {
      throw new Error(`integration-im: FeishuImChannel rejected a "${binding.platform}" binding`);
    }
    this.identities.bind(binding);
    return binding;
  }

  resolveIdentity(imUserId: string, tenantId: TenantIdType): ImIdentityBinding | undefined {
    return this.identities.resolve('feishu', tenantId, imUserId);
  }
}

function decodeFeishuTextMessage(event: Record<string, unknown>, raw: unknown): ImInbound | undefined {
  const message = isRecord(event['message']) ? event['message'] : undefined;
  if (message === undefined || message['message_type'] !== 'text' || typeof message['content'] !== 'string') {
    return undefined;
  }
  const openId = extractFeishuOpenId(event);
  if (openId === undefined) {
    return undefined;
  }
  const parsed = parseJsonObject(message['content']);
  if (parsed === undefined || !isRecord(parsed) || typeof parsed['text'] !== 'string') {
    return undefined;
  }
  const messageId = typeof message['message_id'] === 'string' ? message['message_id'] : undefined;
  return decodeImTextInbound({
    text: parsed['text'],
    from: imUserRef('feishu', openId),
    imMessageId: messageId,
    raw,
  });
}

function extractFeishuOpenId(event: Record<string, unknown>): string | undefined {
  if (!isRecord(event['sender']) || !isRecord(event['sender']['sender_id'])) {
    return undefined;
  }
  const openId = event['sender']['sender_id']['open_id'];
  return typeof openId === 'string' && openId.length > 0 ? openId : undefined;
}

function extractActionUrl(actions: readonly unknown[]): string | undefined {
  for (const action of actions) {
    if (isRecord(action) && typeof action['url'] === 'string' && action['url'].length > 0) {
      return action['url'];
    }
  }
  return undefined;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function mapFeishuSendResponse(status: number, body: unknown): ImSendResult {
  if (status !== 200) {
    return { ok: false, code: `feishu.http-${status}`, message: 'im/v1/messages returned non-200' };
  }
  if (isRecord(body) && body['code'] === 0) {
    const data = isRecord(body['data']) ? body['data'] : undefined;
    const messageId = data !== undefined && typeof data['message_id'] === 'string' ? data['message_id'] : undefined;
    return { ok: true, vendorMessageId: messageId };
  }
  if (isRecord(body) && typeof body['code'] === 'number') {
    const msg = typeof body['msg'] === 'string' ? body['msg'] : 'im/v1/messages rejected';
    return { ok: false, code: `feishu.${String(body['code'])}`, message: msg };
  }
  return { ok: false, code: 'feishu.unparseable-ack', message: 'im/v1/messages ack does not conform' };
}

function failure(code: string, error: unknown): ImSendResult {
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}
