/**
 * 统一出站消息模型（厂商中立，Done-when #2）：文本 / 卡片。
 *
 * 卡片字段行 codec（encodeCardFieldLine / decodeCardFieldLine）是两适配器共享的
 * 可逆编码基础（Done-when #3）：字段行以全角冒号分隔、以首个分隔符切分，
 * name 不得含分隔符/换行，value 可含分隔符——约束在构造期校验，保证映射互逆成立。
 */
import { deepFreeze } from './internal/freeze.js';
import { requireNonEmptyString } from './internal/guards.js';

/** 收件人：企微 userid / 飞书 open_id（按渠道口径；与系统身份的绑定见 identity.ts）。 */
export interface ImRecipient {
  readonly imUserId: string;
}

export interface ImCardField {
  readonly name: string;
  readonly value: string;
}

export interface ImTextMessage {
  readonly kind: 'text';
  readonly to: ImRecipient;
  readonly text: string;
}

export interface ImCardMessage {
  readonly kind: 'card';
  readonly to: ImRecipient;
  readonly title: string;
  readonly fields: readonly ImCardField[];
  readonly url: string | undefined;
}

export type ImOutboundMessage = ImTextMessage | ImCardMessage;

export function imRecipient(imUserId: string): ImRecipient {
  requireNonEmptyString(imUserId, 'ImRecipient.imUserId');
  return Object.freeze({ imUserId });
}

export function imTextMessage(input: { to: string; text: string }): ImTextMessage {
  const to = imRecipient(input.to);
  requireNonEmptyString(input.text, 'ImTextMessage.text');
  return deepFreeze({ kind: 'text' as const, to, text: input.text });
}

export function imCardMessage(input: {
  to: string;
  title: string;
  fields: readonly ImCardField[];
  /** exactOptionalPropertyTypes：显式 undefined 与缺省等价。 */
  url?: string | undefined;
}): ImCardMessage {
  const to = imRecipient(input.to);
  requireNonEmptyString(input.title, 'ImCardMessage.title');
  if (input.url !== undefined) {
    requireNonEmptyString(input.url, 'ImCardMessage.url');
  }
  if (!Array.isArray(input.fields)) {
    throw new Error('integration-im: ImCardMessage.fields must be an array of ImCardField');
  }
  const fields = input.fields.map((field) => {
    requireNonEmptyString(field.name, 'ImCardField.name');
    if (typeof field.value !== 'string') {
      throw new Error('integration-im: ImCardField.value must be a string');
    }
    if (field.name.includes(CARD_FIELD_SEPARATOR) || field.name.includes('\n')) {
      throw new Error(
        `integration-im: ImCardField.name must not contain line breaks or "${CARD_FIELD_SEPARATOR}" (reversible codec constraint)`,
      );
    }
    if (field.value.includes('\n')) {
      throw new Error('integration-im: ImCardField.value must not contain line breaks (reversible codec constraint)');
    }
    return Object.freeze({ name: field.name, value: field.value });
  });
  return deepFreeze({ kind: 'card' as const, to, title: input.title, fields, url: input.url });
}

/** 卡片字段行分隔符：编解码以首个分隔符切分——name 禁含，value 可含。 */
export const CARD_FIELD_SEPARATOR = '：';

export function encodeCardFieldLine(field: ImCardField): string {
  return `${field.name}${CARD_FIELD_SEPARATOR}${field.value}`;
}

export function decodeCardFieldLine(line: string): ImCardField {
  const index = line.indexOf(CARD_FIELD_SEPARATOR);
  if (index <= 0) {
    throw new Error(
      `integration-im: card field line is not decodable (missing "${CARD_FIELD_SEPARATOR}" or empty name)`,
    );
  }
  return Object.freeze({ name: line.slice(0, index), value: line.slice(index + CARD_FIELD_SEPARATOR.length) });
}
