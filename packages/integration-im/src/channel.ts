/**
 * IMessageChannel 端口（Done-when #2）：企微/飞书双生态统一消息渠道。
 *
 * 三能力：send（文本/卡片）、receive（命令/事件回调投影）、身份绑定（IM 用户 ↔ UserId）。
 * 实现（adapters/*）只依赖 ImTransport 与 ImIdentityDirectory 注入端口，纯域可测。
 */
import type { TenantIdType } from '@smes/business-core';
import type { ImPlatform } from './config.js';
import type { ImIdentityBinding } from './identity.js';
import type { ImInbound } from './inbound.js';
import type { ImOutboundMessage } from './message.js';

export type ImSendResult =
  | { readonly ok: true; readonly vendorMessageId: string | undefined }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface IMessageChannel {
  readonly platform: ImPlatform;
  send(message: ImOutboundMessage): Promise<ImSendResult>;
  receive(rawCallback: unknown): ImInbound;
  bindIdentity(binding: ImIdentityBinding): ImIdentityBinding;
  resolveIdentity(imUserId: string, tenantId: TenantIdType): ImIdentityBinding | undefined;
}
