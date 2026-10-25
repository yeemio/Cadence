/**
 * 附件中心输入解析（HTTP body/query → 业务输入；U3 A13）。
 *
 * 与 notifications-input 同一纪律：违规抛 AttachmentInputError（组合根映射
 * 400），绝不静默丢弃。长度上限镜像文档 §1.3 列长（file_name 255 / file_url
 * 1000 / bucket_name→target 128 / object_key 500）。本期不做 URL 重复、文件
 * 名唯一、大小与类型白名单校验（文档 §1.2 已确认决策）；上传字节仅设传输
 * 量护栏（MAX_UPLOAD_BYTES，防 JSON+base64 传输面打爆内存——非业务白名单）。
 */
import { AttachmentInputError } from './attachment-errors.js';

/** 类型码形状：单段小写（同 notification source 形状；ADR-0010 晚绑定）。 */
const CODE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** 内容类型形状：type/subtype（RFC 6838 宽松子集，无参数段）。 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9!#$&^_.+-]{0,126}$/;
/** 上传字节护栏（32 MiB——传输面护栏，非业务大小白名单）。 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AttachmentInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AttachmentInputError(`字段 '${field}' 必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new AttachmentInputError(`字段 '${field}' 须为 1~${maxLength} 个非空白字符`);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AttachmentInputError(`字段 '${field}' 须为字符串或 null：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new AttachmentInputError(`字段 '${field}' 超长（>${maxLength}）`);
  }
  return trimmed;
}

function requireCode(value: unknown, field: string): string {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new AttachmentInputError(
      `字段 '${field}' '${JSON.stringify(value)}' 非法：须为单段小写形状（小写字母开头，仅小写字母/数字/连字符，1~32 字符）`,
    );
  }
  return value;
}

function optionalContentType(value: unknown): string | null | undefined {
  const text = optionalText(value, 'contentType', 127);
  if (text === undefined || text === null) return text;
  if (!CONTENT_TYPE_PATTERN.test(text)) {
    throw new AttachmentInputError(
      `字段 'contentType' '${JSON.stringify(text)}' 非法：须为 type/subtype 形状（无参数段）`,
    );
  }
  return text;
}

/** 对象键：不含目标名、不含前导 /、无反斜杠、无 ./.. 段（本地适配器路径安全）。 */
function requireObjectKey(value: unknown): string {
  const text = requireText(value, 'objectKey', 500);
  if (text.startsWith('/')) {
    throw new AttachmentInputError("字段 'objectKey' 非法：不含前导 '/'");
  }
  if (text.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(text)) {
    throw new AttachmentInputError("字段 'objectKey' 非法：不含反斜杠与 '.'/'..' 路径段");
  }
  return text;
}

/** 关联业务主键（opaque）：非空、无空白、≤128。 */
function requireBizId(value: unknown, field = 'bizId'): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128 || /\s/.test(value)) {
    throw new AttachmentInputError(`${field} 非法：${JSON.stringify(value)}`);
  }
  return value.trim();
}

function requireBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AttachmentInputError(`字段 'contentBase64' 必须是非空 base64 字符串`);
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.byteLength === 0) {
    throw new AttachmentInputError(`字段 'contentBase64' 解码为空`);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AttachmentInputError(
      `上传字节超传输护栏（${bytes.byteLength} > ${MAX_UPLOAD_BYTES}）`,
    );
  }
  return bytes;
}

export interface UploadAttachmentPayload {
  readonly fileName: string;
  readonly contentType?: string | null;
  readonly bytes: Uint8Array;
  readonly bizType: string;
  readonly bizId: string;
}

/** 解析 POST /attachment/upload（字节经端口 put——本波零对象存储基建）。 */
export function parseUploadAttachmentInput(input: unknown): UploadAttachmentPayload {
  const record = requireObject(input, '上传附件请求体');
  const payload: {
    fileName: string;
    bytes: Uint8Array;
    bizType: string;
    bizId: string;
    contentType?: string | null;
  } = {
    fileName: requireText(record['fileName'], 'fileName', 255),
    bytes: requireBytes(record['contentBase64']),
    bizType: requireCode(record['bizType'], 'bizType'),
    bizId: requireBizId(record['bizId']),
  };
  const contentType = optionalContentType(record['contentType']);
  if (contentType !== undefined) payload.contentType = contentType;
  return payload;
}

export interface SaveAttachmentPayload {
  readonly fileName: string;
  readonly contentType?: string | null;
  readonly storageKind: string;
  readonly objectKey: string;
  readonly fileUrl?: string | null;
  readonly bizType: string;
  readonly bizId: string;
}

/** 解析 POST /attachment/save（为已 put 对象登记元数据；target 服务端写入不收）。 */
export function parseSaveAttachmentInput(input: unknown): SaveAttachmentPayload {
  const record = requireObject(input, '保存附件请求体');
  const payload: {
    fileName: string;
    storageKind: string;
    objectKey: string;
    bizType: string;
    bizId: string;
    contentType?: string | null;
    fileUrl?: string | null;
  } = {
    fileName: requireText(record['fileName'], 'fileName', 255),
    storageKind: requireCode(record['storageKind'], 'storageKind'),
    objectKey: requireObjectKey(record['objectKey']),
    bizType: requireCode(record['bizType'], 'bizType'),
    bizId: requireBizId(record['bizId']),
  };
  const contentType = optionalContentType(record['contentType']);
  if (contentType !== undefined) payload.contentType = contentType;
  const fileUrl = optionalText(record['fileUrl'], 'fileUrl', 1000);
  if (fileUrl !== undefined) payload.fileUrl = fileUrl;
  return payload;
}

/** 解析 POST /attachment/save-batch（数组至少 1 条；逐条校验同单条）。 */
export function parseSaveAttachmentBatchInput(input: unknown): SaveAttachmentPayload[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AttachmentInputError('批量保存请求体必须是非空数组（至少 1 条）');
  }
  return input.map((item, index) => {
    try {
      return parseSaveAttachmentInput(item);
    } catch (error) {
      if (error instanceof AttachmentInputError) {
        throw new AttachmentInputError(`第 ${index + 1} 条：${error.message}`);
      }
      throw error;
    }
  });
}

/** 解析 GET /attachment/list-by-biz-id 的 bizId 查询参数。 */
export function parseBizIdQuery(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new AttachmentInputError("查询参数 'bizId' 必填");
  }
  return requireBizId(value, 'bizId');
}

/** 解析 POST /attachment/remove 请求体（{ ids: "id1,id2" } 逗号分隔——文档二.4）。 */
export function parseRemoveIdsInput(input: unknown): string[] {
  const record = requireObject(input, '删除附件请求体');
  const raw = record['ids'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AttachmentInputError(`字段 'ids' 必须是逗号分隔的非空字符串：${JSON.stringify(raw)}`);
  }
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id.length === 0 || id.length > 128 || /\s/.test(id)) {
      throw new AttachmentInputError(`ids 含非法附件 id：${JSON.stringify(part)}`);
    }
    if (!ids.includes(id)) ids.push(id); // 去重保序
  }
  if (ids.length === 0) {
    throw new AttachmentInputError("字段 'ids' 未含任何有效附件 id");
  }
  return ids;
}

export interface DownloadReferenceQuery {
  readonly id: string;
  readonly bizId: string;
  readonly downloadName?: string | null;
}

/** 解析 GET /attachment/download-reference 查询（id+bizId 必填，文档二.5）。 */
export function parseDownloadReferenceQuery(params: {
  id?: string | undefined;
  bizId?: string | undefined;
  downloadName?: string | undefined;
}): DownloadReferenceQuery {
  if (params.id === undefined || params.id.trim().length === 0 || params.id.length > 128 || /\s/.test(params.id)) {
    throw new AttachmentInputError(`查询参数 'id' 非法：${JSON.stringify(params.id)}`);
  }
  const query: { id: string; bizId: string; downloadName?: string | null } = {
    id: params.id.trim(),
    bizId: parseBizIdQuery(params.bizId),
  };
  const downloadName = optionalText(params.downloadName, 'downloadName', 255);
  if (downloadName !== undefined) query.downloadName = downloadName;
  return query;
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseAttachmentIdParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || /\s/.test(trimmed)) {
    throw new AttachmentInputError(`附件引用参数非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
