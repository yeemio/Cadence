/**
 * 边缘 sink 适配测试（M2 后第一增量，接线清单 #10/#18）：
 *  - print sink：合法 pdf 文档族载荷 → makePrintJob 受理发回执（jobId 回传）；
 *    非法载荷拒绝（wiring 捕获后 printed:false——拒绝路径不抛出到调用方之外）。
 *  - IM 渠道装配：无配置/不完整配置 → undefined（降级不炸 boot）；
 *    渠道适配把卡片消息形状映射为 imCardMessage（可逆 codec 约束：换行压空格）。
 */
import { describe, expect, it } from 'vitest';
import type { ImCardMessage, IMessageChannel, ImSendResult } from '@smes/integration-im';
import {
  createImChannelFromEnv,
  createIntegrationEdgeSinks,
  createIntegrationImSink,
  createIntegrationPrintSink,
} from '../src/integration-edge-adapters.js';

/** 合法的 pdf 文档族载荷（integration-print PdfDefinition 形状）。 */
const PDF_PAYLOAD = {
  family: 'pdf',
  definition: {
    content: [
      { text: '外协加工单', style: 'header' },
      { table: { headerRows: 1, body: [[{ text: '工序' }, { text: '数量' }], [{ text: 'OP-10' }, { text: '5' }]] } },
    ],
    styles: { header: { bold: true, fontSize: 16 } },
  },
};

describe('integration-print sink（#10）', () => {
  it('合法 pdf 载荷 → 受理发回执（jobId/submittedAt 回传）', async () => {
    const sink = createIntegrationPrintSink();
    const receipt = await sink.submit({
      jobId: 'prn-test-001',
      kind: 'document',
      payload: PDF_PAYLOAD,
      copies: 1,
      createdAt: '2026-10-25T00:00:00.000Z',
    });
    expect(receipt.jobId).toBe('prn-test-001');
    expect(Number.isNaN(Date.parse(receipt.submittedAt))).toBe(false);
  });

  it('非法载荷（非 pdf 文档族）→ 抛错（wiring 捕获 → printed:false 拒绝口径）', async () => {
    const sink = createIntegrationPrintSink();
    await expect(
      sink.submit({ jobId: 'prn-bad', kind: 'document', payload: { family: 'tspl', program: 'PRINT' }, copies: 1, createdAt: '2026-10-25T00:00:00.000Z' }),
    ).rejects.toThrow();
  });
});

describe('integration-im 渠道装配（#18）', () => {
  it('无 SMES_IM_PLATFORM → undefined（console 降级，不炸 boot）', () => {
    expect(createImChannelFromEnv({})).toBeUndefined();
    expect(createImChannelFromEnv({ SMES_IM_PLATFORM: 'console' })).toBeUndefined();
  });

  it('wecom 配置不全 → undefined（部署错误降级可见，不抛出）', () => {
    const channel = createImChannelFromEnv({
      SMES_IM_PLATFORM: 'wecom',
      SMES_IM_WECOM_CORP_ID: 'corp',
      // 缺 AGENT_ID/CORP_SECRET/CALLBACK_TOKEN
    });
    expect(channel).toBeUndefined();
  });

  it('wecom 配置齐全 → 渠道装配成功', () => {
    const channel = createImChannelFromEnv({
      SMES_IM_PLATFORM: 'wecom',
      SMES_IM_WECOM_CORP_ID: 'corp',
      SMES_IM_WECOM_AGENT_ID: '1000002',
      SMES_IM_WECOM_CORP_SECRET: 's',
      SMES_IM_WECOM_CALLBACK_TOKEN: 't',
    });
    expect(channel?.platform).toBe('wecom');
  });

  it('未识别平台值 → undefined（降级）', () => {
    expect(createImChannelFromEnv({ SMES_IM_PLATFORM: 'sms' })).toBeUndefined();
  });

  it('createIntegrationEdgeSinks：print 恒受理面；IM 无配置 → undefined', () => {
    const sinks = createIntegrationEdgeSinks({});
    expect(sinks.printSink).toBeDefined();
    expect(sinks.imSink).toBeUndefined();
  });
});

describe('IM sink 渠道适配（卡片消息形状映射）', () => {
  it('卡片字段映射 + 换行压空格（可逆 codec 约束）；ok:false 透传', async () => {
    const sent: ImCardMessage[] = [];
    let result: ImSendResult = { ok: true, vendorMessageId: 'm-1' };
    const channel: IMessageChannel = {
      platform: 'wecom',
      send: async (message) => {
        sent.push(message as ImCardMessage);
        return result;
      },
      receive: () => {
        throw new Error('不在本测试面');
      },
      bindIdentity: (binding) => binding,
      resolveIdentity: () => undefined,
    };
    const sink = createIntegrationImSink(channel);

    const ok = await sink.send({
      kind: 'card',
      to: 'smes-ops',
      title: '质检不合格通知',
      fields: [
        { name: '正文', value: '不合格单 NC-1 待处置\n请及时复核' },
        { name: '租户', value: 'default' },
      ],
    });
    expect(ok).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('card');
    expect(sent[0]?.title).toBe('质检不合格通知');
    expect(sent[0]?.to.imUserId).toBe('smes-ops');
    expect(sent[0]?.fields[0]).toEqual({ name: '正文', value: '不合格单 NC-1 待处置 请及时复核' });

    result = { ok: false, code: 'wecom.transport-error', message: 'unreachable' };
    const failed = await sink.send({ kind: 'card', to: 'smes-ops', title: 't', fields: [] });
    expect(failed).toEqual({ ok: false });
  });
});
