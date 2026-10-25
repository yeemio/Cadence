import { describe, expect, it } from 'vitest';
import { createJsSdkSignatureService, imSecretRef, type ImSecretRef } from '../src/index.js';

const TICKET_REF: ImSecretRef = imSecretRef('secret://wecom/jsapi-ticket');

/** 伪算法：把规范化输入拼成可断言的串——算法钩子契约的可见性。 */
const FAKE_ALGORITHM = (resolved: { url: string; nonceStr: string; timestamp: number; ticketValue: string }) =>
  `SIG(${resolved.ticketValue}|${resolved.nonceStr}|${resolved.timestamp}|${resolved.url})`;

describe('JsSdkSignatureService 默认实现形状（Done-when #4，算法为 TODO 钩子）', () => {
  it('校验输入 → 解析 ticket → 调算法钩子 → 冻结签名组', async () => {
    const resolvedRefs: ImSecretRef[] = [];
    const service = createJsSdkSignatureService({
      algorithm: FAKE_ALGORITHM,
      resolveTicket: async (ref) => {
        resolvedRefs.push(ref);
        return 'ticket-value-placeholder';
      },
    });

    const output = await service.sign({
      url: 'https://work.example.com/mobile/report',
      nonceStr: 'nonce-1',
      timestamp: 1_700_000_000,
      ticket: TICKET_REF,
    });

    expect(resolvedRefs).toEqual([TICKET_REF]);
    expect(output).toEqual({
      signature: 'SIG(ticket-value-placeholder|nonce-1|1700000000|https://work.example.com/mobile/report)',
      nonceStr: 'nonce-1',
      timestamp: 1_700_000_000,
    });
    expect(Object.isFrozen(output)).toBe(true);
  });

  it('拒绝非法输入：空 url / 空 nonce / 非正整数时间戳 / 裸字符串 ticket', async () => {
    const service = createJsSdkSignatureService({
      algorithm: FAKE_ALGORITHM,
      resolveTicket: async () => 'ticket-value-placeholder',
    });
    const base = { url: 'https://work.example.com/x', nonceStr: 'n', timestamp: 1_700_000_000, ticket: TICKET_REF };
    await expect(service.sign({ ...base, url: '' })).rejects.toThrow('url');
    await expect(service.sign({ ...base, nonceStr: '' })).rejects.toThrow('nonceStr');
    await expect(service.sign({ ...base, timestamp: 0 })).rejects.toThrow('timestamp');
    await expect(service.sign({ ...base, timestamp: 1.5 })).rejects.toThrow('timestamp');
    await expect(service.sign({ ...base, ticket: 'raw-ticket-forbidden' as never })).rejects.toThrow('ImSecretRef');
  });
});
