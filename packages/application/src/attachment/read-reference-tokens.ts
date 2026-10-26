/**
 * 只读引用令牌（U3 A13）：零基建适配器（内存/本地文件）的短时能力凭证。
 *
 * 形状：`v1.<b64url(claims JSON)>.<b64url(HMAC-SHA256)>`——对象键/目标/过期
 * 时刻/下载展示名/内容类型/租户标识全部入 claims，HMAC 防篡改，常数时间比较。
 * 租户标识（tenantId）随 claims 签名：兑现方（resolveReadReference）与请求解析
 * 出的当前租户比对一致才放行——同一令牌换租户 Host 兑现即无效（D-4）。
 * 过期即失效（verifyReadReference 返回 null）。等价文档语义：私有桶 + 仅带签名
 * GET + response-content-disposition（downloadName 随令牌下发）。
 *
 * 密钥取舍：适配器实例自持（构造注入或随机生成）——重启后旧引用失效，与
 * 60 秒级 TTL 的短时效语义一致；部署期接入真实对象存储后由其 SDK 签名取代。
 */
import { createHmac, getRandomValues, timingSafeEqual } from 'node:crypto';

/** 令牌载荷（只读面：不含可写字段）。 */
export interface ReadReferenceClaims {
  /** 签发租户标识（兑现方与当前租户比对一致才放行）。 */
  readonly tenantId: string;
  readonly target: string;
  readonly objectKey: string;
  /** 过期时刻（epoch 毫秒）。 */
  readonly expiresAtMs: number;
  readonly downloadName: string;
  readonly contentType: string | null;
}

/** 新签发密钥（32 字节随机）。 */
export function newReadReferenceSigningKey(): Uint8Array {
  return getRandomValues(new Uint8Array(32));
}

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function signature(key: Uint8Array, payloadEncoded: string): Uint8Array {
  const mac = createHmac('sha256', key);
  mac.update(payloadEncoded, 'utf8');
  return new Uint8Array(mac.digest());
}

/** 编码只读引用令牌。 */
export function encodeReadReferenceToken(key: Uint8Array, claims: ReadReferenceClaims): string {
  const payload = toBase64Url(JSON.stringify(claims));
  const sig = signature(key, payload);
  const sigEncoded = Buffer.from(sig).toString('base64url');
  return `v1.${payload}.${sigEncoded}`;
}

/**
 * 验证令牌：签名不符 / 结构非法 / 已过期 → null（不区分原因，不泄漏存在性）。
 * 时间判断用传入 now（服务层时钟可注入）。
 */
export function verifyReadReferenceToken(
  key: Uint8Array,
  token: string,
  now: Date,
): ReadReferenceClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let claims: ReadReferenceClaims;
  try {
    claims = JSON.parse(fromBase64Url(parts[1]!)) as ReadReferenceClaims;
  } catch {
    return null;
  }
  if (
    typeof claims?.tenantId !== 'string' ||
    typeof claims?.target !== 'string' ||
    typeof claims?.objectKey !== 'string' ||
    typeof claims?.expiresAtMs !== 'number' ||
    typeof claims?.downloadName !== 'string'
  ) {
    return null;
  }
  let expected: Uint8Array;
  try {
    expected = new Uint8Array(Buffer.from(parts[2]!, 'base64url'));
  } catch {
    return null;
  }
  const actual = signature(key, parts[1]!);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (!(now.getTime() < claims.expiresAtMs)) return null; // 过期即失效
  return claims;
}
