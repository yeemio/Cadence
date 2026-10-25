import { describe, expect, it } from 'vitest';
import {
  CARD_FIELD_SEPARATOR,
  decodeCardFieldLine,
  decodeImTextInbound,
  encodeCardFieldLine,
  imCardMessage,
  imTextMessage,
  imUserRef,
  IM_TEXT_EVENT_TYPE,
  imSecretRef,
  wecomImConfig,
  feishuImConfig,
} from '../src/index.js';

describe('统一消息模型（Done-when #2）', () => {
  it('构造并冻结文本消息', () => {
    const message = imTextMessage({ to: 'wu-001', text: '工单 WO-1 已派工' });
    expect(message.kind).toBe('text');
    expect(message.to.imUserId).toBe('wu-001');
    expect(Object.isFrozen(message)).toBe(true);
    expect(() => {
      (message as { text: string }).text = 'x';
    }).toThrow();
  });

  it('构造并冻结卡片消息（含空 url 归一）', () => {
    const message = imCardMessage({
      to: 'ou-open-placeholder',
      title: '工单待报工',
      fields: [
        { name: '工单', value: 'WO-1' },
        { name: '备注', value: `配比${CARD_FIELD_SEPARATOR}1:2` },
      ],
      url: undefined,
    });
    expect(message.kind).toBe('card');
    expect(message.fields).toHaveLength(2);
    expect(message.url).toBeUndefined();
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.fields)).toBe(true);
  });

  it('拒绝破坏可逆 codec 的卡片字段（name 含分隔符/换行、value 含换行、空标题）', () => {
    expect(() => imCardMessage({ to: 'u', title: 't', fields: [{ name: `坏${CARD_FIELD_SEPARATOR}名`, value: 'v' }] })).toThrow();
    expect(() => imCardMessage({ to: 'u', title: 't', fields: [{ name: '坏\n名', value: 'v' }] })).toThrow();
    expect(() => imCardMessage({ to: 'u', title: 't', fields: [{ name: '名', value: '坏\n值' }] })).toThrow();
    expect(() => imCardMessage({ to: 'u', title: '', fields: [] })).toThrow();
    expect(() => imTextMessage({ to: 'u', text: '' })).toThrow();
  });

  it('卡片字段行 codec：以首个分隔符切分，value 可含分隔符', () => {
    const field = { name: '备注', value: `配比${CARD_FIELD_SEPARATOR}1:2` };
    const line = encodeCardFieldLine(field);
    expect(decodeCardFieldLine(line)).toEqual(field);
    expect(() => decodeCardFieldLine('没有分隔符')).toThrow();
    expect(() => decodeCardFieldLine(`${CARD_FIELD_SEPARATOR}空名`)).toThrow();
  });
});

describe('入站文本命令共享口径', () => {
  const from = imUserRef('wecom', 'wu-001');

  it("'/报工 WO-1 3' → 命令 + 参数", () => {
    const inbound = decodeImTextInbound({ text: '/报工 WO-1 3', from, imMessageId: 'm-1', raw: {} });
    expect(inbound).toMatchObject({ kind: 'command', command: '报工', arguments: ['WO-1', '3'] });
    expect(Object.isFrozen(inbound)).toBe(true);
  });

  it("普通文本与孤 '/' → im.message.text 事件", () => {
    expect(decodeImTextInbound({ text: '收到', from, imMessageId: undefined, raw: {} })).toMatchObject({
      kind: 'event',
      eventType: IM_TEXT_EVENT_TYPE,
    });
    expect(decodeImTextInbound({ text: '/', from, imMessageId: undefined, raw: {} })).toMatchObject({
      kind: 'event',
      eventType: IM_TEXT_EVENT_TYPE,
    });
  });
});

describe('配置形状：凭据占位（Done-when #2，禁硬编码密钥样例）', () => {
  it('企微/飞书配置只接受 ImSecretRef 占位，拒绝裸字符串', () => {
    const config = wecomImConfig({
      corpId: 'ww-corp-placeholder',
      agentId: 1000002,
      corpSecret: imSecretRef('secret://wecom/corp-secret'),
      callbackToken: imSecretRef('secret://wecom/callback-token'),
      apiBaseUrl: 'https://im-adapter.test',
    });
    expect(config.platform).toBe('wecom');
    expect(config.corpSecret.kind).toBe('secret-ref');
    expect(Object.isFrozen(config)).toBe(true);
    expect(() =>
      wecomImConfig({
        corpId: 'ww-corp-placeholder',
        agentId: 1000002,
        corpSecret: 'raw-secret-forbidden' as never,
        callbackToken: imSecretRef('secret://wecom/callback-token'),
      }),
    ).toThrow();

    const feishu = feishuImConfig({
      appId: 'cli-app-placeholder',
      appSecret: imSecretRef('secret://feishu/app-secret'),
      verificationToken: imSecretRef('secret://feishu/verify-token'),
    });
    expect(feishu.apiBaseUrl).toBe('https://open.feishu.cn');
    expect(() => feishuImConfig({
      appId: 'cli-app-placeholder',
      appSecret: { kind: 'secret-ref', ref: '' } as never,
      verificationToken: imSecretRef('secret://feishu/verify-token'),
    })).toThrow();
  });
});
