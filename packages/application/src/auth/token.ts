/**
 * 会话令牌原语（M1 收尾波-③）：opaque token 生成 + 摘要。
 *
 * 形态取舍（写明）：opaque 随机令牌（256bit，base64url）而非 JWT——
 * 服务端会话表是唯一事实源，撤销 = 一行 UPDATE 立即生效；无签名密钥
 * 管理、无"签出即无法吊销"问题。库表只存 sha256 摘要（明文 token
 * 不落库：拖库不等于可冒用），摘要碰撞概率可忽略（sha256）。
 */
import { createHash, randomBytes } from 'node:crypto';

/** 生成 256bit 随机令牌（base64url，无填充，43 字符）。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 令牌摘要（sha256 hex，64 字符）——sessions.token_digest 存储值。 */
export function digestSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
