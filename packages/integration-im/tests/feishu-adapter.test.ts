import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  feishuImConfig,
  feishuOutboundToPayload,
  feishuPayloadToOutbound,
  FeishuImChannel,
  imCardMessage,
  imIdentityBinding,
  imSecretRef,
  imTextMessage,
  type ImSecretResolver,
} from '../src/index.js';
import { mockImTransport } from './helpers/mock-transport.js';

const CONFIG = feishuImConfig({
  appId: 'cli-app-placeholder',
  appSecret: imSecretRef('secret://feishu/app-secret'),
  verificationToken: imSecretRef('secret://feishu/verify-token'),
  apiBaseUrl: 'https://im-adapter.test',
});

const RESOLVE_SECRET: ImSecretResolver = async (ref) => `resolved(${ref.ref})`;
const CLOCK = () => 1_700_000_000_000;

const TEXT = imTextMessage({ to: 'ou-open-placeholder', text: '工单 WO-1 已派工' });
const CARD_WITH_URL = imCardMessage({
  to: 'ou-open-placeholder',
  title: '工单待报工',
  fields: [
    { name: '工单', value: 'WO-1' },
    { name: '备注', value: '配比：1:2' },
  ],
  url: 'https://work.example.com/wo/1',
});
const CARD_WITHOUT_URL = imCardMessage({ to: 'ou-open-2', title: '班次提醒', fields: [{ name: '班组', value: '甲班' }], url: undefined });

describe('飞书消息映射：统一消息 ↔ 厂商载荷互为可逆（Done-when #3）', () => {
  it('文本：content 为 JSON 字符串，两向还原', () => {
    const payload = feishuOutboundToPayload(TEXT);
    expect(payload).toEqual({ receive_id: 'ou-open-placeholder', msg_type: 'text', content: JSON.stringify({ text: '工单 WO-1 已派工' }) });
    expect(feishuPayloadToOutbound(payload)).toEqual(TEXT);
  });

  it('卡片（有/无 url）：interactive 卡两向还原，canonical 载荷双向编码稳定', () => {
    for (const card of [CARD_WITH_URL, CARD_WITHOUT_URL]) {
      const payload = feishuOutboundToPayload(card);
      expect(feishuPayloadToOutbound(payload)).toEqual(card);
      expect(feishuOutboundToPayload(feishuPayloadToOutbound(payload))).toEqual(payload);
    }
  });

  it('卡片载荷形状符合飞书公开形状（header.title + div.fields + action 按钮）', () => {
    const payload = feishuOutboundToPayload(CARD_WITH_URL);
    const card = JSON.parse(payload.content) as Record<string, unknown>;
    expect(card['header']).toEqual({ template: 'blue', title: { tag: 'plain_text', content: '工单待报工' } });
    expect(card['elements']).toEqual([
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: '工单：WO-1' } },
          { is_short: true, text: { tag: 'lark_md', content: '备注：配比：1:2' } },
        ],
      },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '详情' }, type: 'primary', url: 'https://work.example.com/wo/1' },
        ],
      },
    ]);
  });

  it('非法 content 抛错（不静默吞）', () => {
    expect(() => feishuPayloadToOutbound({ receive_id: 'ou', msg_type: 'text', content: 'not-json' })).toThrow();
    expect(() => feishuPayloadToOutbound({ receive_id: 'ou', msg_type: 'interactive', content: '{}' })).toThrow();
  });
});

describe('飞书渠道编排（mock transport，不触真实 fetch）', () => {
  it('send：tenant_access_token 交换 + Bearer 调 messages，回传 message_id', async () => {
    const transport = mockImTransport([
      { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: 'TENANT-TOKEN', expire: 7200 } },
      { status: 200, body: { code: 0, msg: 'success', data: { message_id: 'om_1' } } },
      { status: 200, body: { code: 0, msg: 'success', data: { message_id: 'om_2' } } },
    ]);
    const channel = new FeishuImChannel({ transport, config: CONFIG, resolveSecret: RESOLVE_SECRET, clock: CLOCK });

    expect(await channel.send(TEXT)).toEqual({ ok: true, vendorMessageId: 'om_1' });
    expect(await channel.send(CARD_WITHOUT_URL)).toEqual({ ok: true, vendorMessageId: 'om_2' });
    expect(transport.requests).toHaveLength(3); // 令牌缓存生效

    const [tokenReq, textReq] = transport.requests;
    expect(tokenReq?.method).toBe('POST');
    expect(tokenReq?.url).toBe('https://im-adapter.test/open-apis/auth/v3/tenant_access_token/internal');
    expect(tokenReq?.body).toEqual({ app_id: 'cli-app-placeholder', app_secret: 'resolved(secret://feishu/app-secret)' });
    expect(textReq?.url).toBe('https://im-adapter.test/open-apis/im/v1/messages?receive_id_type=open_id');
    expect(textReq?.headers['authorization']).toBe('Bearer TENANT-TOKEN');
    expect(textReq?.body).toEqual(feishuOutboundToPayload(TEXT));
  });

  it('send 失败路径：厂商 code / 非 200 / 传输异常 / 令牌交换失败', async () => {
    const rejected = new FeishuImChannel({
      transport: mockImTransport([
        { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: 'T1', expire: 7200 } },
        { status: 200, body: { code: 99991663, msg: 'token is invalid' } },
      ]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await rejected.send(TEXT)).toEqual({ ok: false, code: 'feishu.99991663', message: 'token is invalid' });

    const httpError = new FeishuImChannel({
      transport: mockImTransport([
        { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: 'T2', expire: 7200 } },
        { status: 500, body: {} },
      ]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await httpError.send(TEXT)).toMatchObject({ ok: false, code: 'feishu.http-500' });

    const transportCrash = new FeishuImChannel({
      transport: mockImTransport([
        { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: 'T3', expire: 7200 } },
        { failure: new Error('connection reset') },
      ]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await transportCrash.send(TEXT)).toMatchObject({ ok: false, code: 'feishu.transport-error' });

    const tokenCrash = new FeishuImChannel({
      transport: mockImTransport([{ status: 200, body: { code: 10003, msg: 'invalid app_secret' } }]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await tokenCrash.send(TEXT)).toMatchObject({ ok: false, code: 'feishu.token-exchange-failed' });
  });

  it('receive：文本命令 / 文本事件 / 透传事件 / url_verification / 未知形状', () => {
    const channel = new FeishuImChannel({
      transport: mockImTransport([]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });

    const rawMessage = {
      schema: '2.0',
      header: { event_id: 'e-1', event_type: 'im.message.receive_v1', create_time: '1700000000', token: 'v-token', app_id: 'cli-app-placeholder' },
      event: {
        sender: { sender_id: { open_id: 'ou-open-placeholder' }, sender_type: 'user' },
        message: { message_id: 'om_9', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: '/报工 WO-1 3' }) },
      },
    };
    expect(channel.receive(rawMessage)).toMatchObject({
      kind: 'command',
      command: '报工',
      arguments: ['WO-1', '3'],
      from: { platform: 'feishu', imUserId: 'ou-open-placeholder' },
      imMessageId: 'om_9',
    });

    expect(
      channel.receive({
        ...rawMessage,
        event: { ...rawMessage.event, message: { ...rawMessage.event.message, content: JSON.stringify({ text: '收到' }) } },
      }),
    ).toMatchObject({ kind: 'event', eventType: 'im.message.text' });

    const rawEvent = {
      schema: '2.0',
      header: { event_id: 'e-2', event_type: 'contact.user.created_v3', app_id: 'cli-app-placeholder' },
      event: { object_type: 'user_id', user_id: 'ou-new' },
    };
    expect(channel.receive(rawEvent)).toMatchObject({
      kind: 'event',
      eventType: 'feishu.event.contact.user.created_v3',
      payload: { object_type: 'user_id', user_id: 'ou-new' },
    });

    expect(channel.receive({ type: 'url_verification', challenge: 'ch-1', token: 'v-token' })).toMatchObject({
      kind: 'event',
      eventType: 'feishu.callback.verification',
      payload: { challenge: 'ch-1' },
    });

    expect(channel.receive(42)).toMatchObject({ kind: 'event', eventType: 'feishu.unknown' });
  });

  it('身份绑定：经渠道端口绑入目录，拒绝异平台绑定', () => {
    const channel = new FeishuImChannel({
      transport: mockImTransport([]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    const binding = imIdentityBinding({ platform: 'feishu', imUserId: 'ou-open-placeholder', tenantId: 't-001', userId: 'u-001' });
    expect(channel.bindIdentity(binding)).toEqual(binding);
    expect(channel.resolveIdentity('ou-open-placeholder', TenantId.create('t-001'))).toEqual(binding);
    expect(() =>
      channel.bindIdentity(imIdentityBinding({ platform: 'wecom', imUserId: 'wu-1', tenantId: 't-001', userId: 'u-002' })),
    ).toThrow();
  });
});
