/**
 * issue 模块 id 生成器（前缀 + uuidv7，与 workorder/listing/dispatch/inventory
 * 同口径：人读可辨聚合类型，跨模块引用一律 opaque 字符串）。
 */

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 inventory-ids.ts 同实现口径——
 * business-store 的 uuid 工具不可用（依赖方向），毫秒级时间序满足排序口径。
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

/** 发料任务 id：itk-<uuidv7>。 */
export function newIssueTaskId(): string {
  return `itk-${uuidv7()}`;
}

/** 发料任务明细行 id：itl-<uuidv7>。 */
export function newIssueTaskLineId(): string {
  return `itl-${uuidv7()}`;
}

/** 发料记录 id：irc-<uuidv7>。 */
export function newIssueRecordId(): string {
  return `irc-${uuidv7()}`;
}

/** 快递单（发货头）id：iex-<uuidv7>。 */
export function newIssueExpressId(): string {
  return `iex-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与 engine-flow 事件 id 同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
