/**
 * ai-query 模块 id 生成器（前缀 + uuidv7，与 reporting-ids / listing-ids 同口径）。
 *
 * 会话/回答不作品牌化聚合 id（只读消费面，无跨模块锚定需求），但保持
 * 「前缀 + 时间有序」形状：aiq-s-（session）/ aiq-a-（answer）。
 */
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 会话 id：aiq-s-<uuidv7>。 */
export function newAiQuerySessionId(): string {
  return `aiq-s-${uuidv7()}`;
}

/** 回答 id：aiq-a-<uuidv7>。 */
export function newAiQueryAnswerId(): string {
  return `aiq-a-${uuidv7()}`;
}
