/**
 * 统一入站模型（Done-when #2）：命令 / 事件两类回调投影。
 *
 * raw 保留厂商回调原文（不冻结、不改写——宿主证据原样引用，ADR-0003 #4 只冻结自有结构）。
 * decodeImTextInbound 是两适配器共享的文本命令口径：'/' 前缀 → 命令，其余 → 文本事件。
 */
import { assertImPlatform } from './config.js';
import type { ImPlatform } from './config.js';

export interface ImUserRef {
  readonly platform: ImPlatform;
  readonly imUserId: string;
}

export interface ImInboundCommand {
  readonly kind: 'command';
  readonly command: string;
  readonly arguments: readonly string[];
  readonly from: ImUserRef;
  readonly imMessageId: string | undefined;
  readonly raw: unknown;
}

export interface ImInboundEvent {
  readonly kind: 'event';
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly from: ImUserRef | undefined;
  readonly raw: unknown;
}

export type ImInbound = ImInboundCommand | ImInboundEvent;

/** 统一文本事件名（非命令文本的入站投影）。 */
export const IM_TEXT_EVENT_TYPE = 'im.message.text';

export function imUserRef(platform: ImPlatform, imUserId: string): ImUserRef {
  assertImPlatform(platform);
  requireNonEmptyStringInbound(imUserId, 'ImUserRef.imUserId');
  return Object.freeze({ platform, imUserId });
}

export function imInboundCommand(input: {
  command: string;
  arguments: readonly string[];
  from: ImUserRef;
  imMessageId: string | undefined;
  raw: unknown;
}): ImInboundCommand {
  requireNonEmptyStringInbound(input.command, 'ImInboundCommand.command');
  if (!Array.isArray(input.arguments)) {
    throw new Error('integration-im: ImInboundCommand.arguments must be an array of strings');
  }
  return Object.freeze({
    kind: 'command' as const,
    command: input.command,
    arguments: Object.freeze([...input.arguments]),
    from: Object.freeze({ ...input.from }),
    imMessageId: input.imMessageId,
    raw: input.raw,
  });
}

export function imInboundEvent(input: {
  eventType: string;
  payload: Record<string, unknown>;
  from: ImUserRef | undefined;
  raw: unknown;
}): ImInboundEvent {
  requireNonEmptyStringInbound(input.eventType, 'ImInboundEvent.eventType');
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) {
    throw new Error('integration-im: ImInboundEvent.payload must be a record');
  }
  return Object.freeze({
    kind: 'event' as const,
    eventType: input.eventType,
    payload: Object.freeze({ ...input.payload }),
    from: input.from === undefined ? undefined : Object.freeze({ ...input.from }),
    raw: input.raw,
  });
}

/** 共享文本命令解码：'/' 前缀 → 命令；其余（含孤 '/'）→ im.message.text 事件。 */
export function decodeImTextInbound(input: {
  text: string;
  from: ImUserRef;
  imMessageId: string | undefined;
  raw: unknown;
}): ImInbound {
  if (input.text.startsWith('/')) {
    const parts = input.text.split(/\s+/);
    const head = parts[0] ?? '';
    const command = head.slice(1);
    if (command.length > 0) {
      return imInboundCommand({
        command,
        arguments: parts.slice(1),
        from: input.from,
        imMessageId: input.imMessageId,
        raw: input.raw,
      });
    }
  }
  return imInboundEvent({
    eventType: IM_TEXT_EVENT_TYPE,
    payload: { text: input.text },
    from: input.from,
    raw: input.raw,
  });
}

function requireNonEmptyStringInbound(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`integration-im: ${label} must be a non-empty string`);
  }
}
