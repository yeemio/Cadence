import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  imSecretRef,
  imTextMessage,
  imCardMessage,
  imIdentityBinding,
  wecomImConfig,
  WecomImChannel,
  wecomOutboundToPayload,
  wecomPayloadToOutbound,
  type ImSecretResolver,
} from '../src/index.js';
import { mockImTransport } from './helpers/mock-transport.js';

const CONFIG = wecomImConfig({
  corpId: 'ww-corp-placeholder',
  agentId: 1000002,
  corpSecret: imSecretRef('secret://wecom/corp-secret'),
  callbackToken: imSecretRef('secret://wecom/callback-token'),
  apiBaseUrl: 'https://im-adapter.test',
});

const RESOLVE_SECRET: ImSecretResolver = async (ref) => `resolved(${ref.ref})`;
const CLOCK = () => 1_700_000_000_000;

const TEXT = imTextMessage({ to: 'wu-001', text: '工单 WO-1 已派工' });
const CARD_WITH_URL = imCardMessage({
  to: 'wu-002',
  title: '工单待报工',
  fields: [
    { name: '工单', value: 'WO-1' },
    { name: '备注', value: '配比：1:2' },
  ],
  url: 'https://work.example.com/wo/1',
});
const CARD_WITHOUT_URL = imCardMessage({ to: 'wu-003', title: '班次提醒', fields: [{ name: '班组', value: '甲班' }], url: undefined });

describe('企微消息映射：统一消息 ↔ 厂商载荷互为可逆（Done-when #3）', () => {
  it('文本：payload(outbound) → outbound(payload) 还原原消息', () => {
    expect(wecomPayloadToOutbound(wecomOutboundToPayload(TEXT, CONFIG.agentId))).toEqual(TEXT);
  });

  it('卡片（有/无 url）：两向还原；canonical 载荷双向编码稳定', () => {
    for (const card of [CARD_WITH_URL, CARD_WITHOUT_URL]) {
      const payload = wecomOutboundToPayload(card, CONFIG.agentId);
      expect(wecomPayloadToOutbound(payload)).toEqual(card);
      expect(wecomOutboundToPayload(wecomPayloadToOutbound(payload), CONFIG.agentId)).toEqual(payload);
    }
  });

  it('textcard 载荷形状符合企微公开形状（touser/msgtype/agentid/textcard）', () => {
    expect(wecomOutboundToPayload(CARD_WITH_URL, CONFIG.agentId)).toEqual({
      touser: 'wu-002',
      msgtype: 'textcard',
      agentid: 1000002,
      textcard: {
        title: '工单待报工',
        description: '工单：WO-1\n备注：配比：1:2',
        url: 'https://work.example.com/wo/1',
        btntxt: '详情',
      },
    });
  });
});

describe('企微渠道编排（mock transport，不触真实 fetch）', () => {
  it('send：先 gettoken 再 message/send，令牌命中缓存', async () => {
    const transport = mockImTransport([
      { status: 200, body: { errcode: 0, errmsg: 'ok', access_token: 'TOKEN-A', expires_in: 7200 } },
      { status: 200, body: { errcode: 0, errmsg: 'ok' } },
      { status: 200, body: { errcode: 0, errmsg: 'ok' } },
    ]);
    const channel = new WecomImChannel({ transport, config: CONFIG, resolveSecret: RESOLVE_SECRET, clock: CLOCK });

    const first = await channel.send(TEXT);
    const second = await channel.send(CARD_WITH_URL);
    expect(first).toEqual({ ok: true, vendorMessageId: undefined });
    expect(second).toEqual({ ok: true, vendorMessageId: undefined });
    expect(transport.requests).toHaveLength(3); // 第二次 send 复用缓存令牌

    const [getToken, sendText, sendCard] = transport.requests;
    expect(getToken?.method).toBe('GET');
    expect(getToken?.url).toBe(
      'https://im-adapter.test/cgi-bin/gettoken?corpid=ww-corp-placeholder&corpsecret=resolved(secret%3A%2F%2Fwecom%2Fcorp-secret)',
    );
    expect(sendText?.url).toBe('https://im-adapter.test/cgi-bin/message/send?access_token=TOKEN-A');
    expect(sendText?.body).toEqual({ touser: 'wu-001', msgtype: 'text', agentid: 1000002, text: { content: '工单 WO-1 已派工' } });
    expect(sendCard?.body).toEqual(wecomOutboundToPayload(CARD_WITH_URL, CONFIG.agentId));
  });

  it('send 失败路径：厂商 errcode / 非 200 / 传输异常 / 令牌交换失败', async () => {
    const rejected = new WecomImChannel({
      transport: mockImTransport([
        { status: 200, body: { errcode: 0, errmsg: 'ok', access_token: 'TOKEN-B', expires_in: 7200 } },
        { status: 200, body: { errcode: 42001, errmsg: 'access_token expired' } },
      ]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await rejected.send(TEXT)).toEqual({ ok: false, code: 'wecom.42001', message: 'access_token expired' });

    const httpError = new WecomImChannel({
      transport: mockImTransport([
        { status: 200, body: { errcode: 0, errmsg: 'ok', access_token: 'TOKEN-C', expires_in: 7200 } },
        { status: 502, body: {} },
      ]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await httpError.send(TEXT)).toMatchObject({ ok: false, code: 'wecom.http-502' });

    const transportCrash = new WecomImChannel({
      transport: mockImTransport([
        { status: 200, body: { errcode: 0, errmsg: 'ok', access_token: 'TOKEN-D', expires_in: 7200 } },
        { failure: new Error('connection reset') },
      ]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await transportCrash.send(TEXT)).toMatchObject({ ok: false, code: 'wecom.transport-error' });

    const tokenCrash = new WecomImChannel({
      transport: mockImTransport([{ status: 200, body: { errcode: 40001, errmsg: 'invalid credential' } }]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    expect(await tokenCrash.send(TEXT)).toMatchObject({ ok: false, code: 'wecom.token-exchange-failed' });
  });

  it('receive：文本命令 / 文本事件 / 事件推送 / 校验回显 / 未知形状', () => {
    const channel = new WecomImChannel({
      transport: mockImTransport([]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });

    const rawText = {
      ToUserName: 'ww-corp-placeholder',
      FromUserName: 'wu-009',
      CreateTime: 1_700_000_000,
      MsgType: 'text',
      Content: '/停线 设备异响',
      MsgId: 123,
      AgentID: 1000002,
    };
    expect(channel.receive(rawText)).toMatchObject({
      kind: 'command',
      command: '停线',
      arguments: ['设备异响'],
      from: { platform: 'wecom', imUserId: 'wu-009' },
      imMessageId: '123',
    });

    expect(channel.receive({ ...rawText, Content: '收到', MsgId: undefined })).toMatchObject({
      kind: 'event',
      eventType: 'im.message.text',
    });

    const rawEvent = { MsgType: 'event', Event: 'change_contact', ChangeType: 'create_user', UserID: 'wu-010' };
    expect(channel.receive(rawEvent)).toMatchObject({ kind: 'event', eventType: 'wecom.event.change_contact' });

    expect(channel.receive({ echostr: 'ECHO-1' })).toMatchObject({
      kind: 'event',
      eventType: 'wecom.callback.verification',
      payload: { echostr: 'ECHO-1' },
    });

    expect(channel.receive('garbage')).toMatchObject({ kind: 'event', eventType: 'wecom.unknown' });
  });

  it('身份绑定：经渠道端口绑入目录，拒绝异平台绑定', () => {
    const channel = new WecomImChannel({
      transport: mockImTransport([]),
      config: CONFIG,
      resolveSecret: RESOLVE_SECRET,
      clock: CLOCK,
    });
    const binding = imIdentityBinding({ platform: 'wecom', imUserId: 'wu-001', tenantId: 't-001', userId: 'u-001' });
    expect(channel.bindIdentity(binding)).toEqual(binding);
    expect(channel.resolveIdentity('wu-001', TenantId.create('t-001'))).toEqual(binding);
    expect(channel.resolveIdentity('wu-001', TenantId.create('t-999'))).toBeUndefined();
    expect(() =>
      channel.bindIdentity(imIdentityBinding({ platform: 'feishu', imUserId: 'ou-1', tenantId: 't-001', userId: 'u-002' })),
    ).toThrow();
  });
});
