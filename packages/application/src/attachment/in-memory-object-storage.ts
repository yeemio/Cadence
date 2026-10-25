/**
 * InMemoryObjectStorage —— ObjectStoragePort 内存适配器（U3 A13）。
 *
 * 重启即失（与 InMemoryAttachmentStore 同取舍：零 DB boot 语义完整）。引用
 * URL 指回本模块开门面（默认 /attachment/storage/<token>），token 为 HMAC
 * 短时能力凭证（见 read-reference-tokens.ts）。签发密钥默认随机——重启后
 * 旧引用全部失效，与短时效语义一致。
 */
import type { TenantId } from '@smes/business-core';
import { AttachmentStorageError } from './attachment-errors.js';
import { newObjectKey } from './attachment-ids.js';
import type {
  IssueReadReferenceOptions,
  ObjectReadReference,
  ObjectStoragePort,
  PutObjectInput,
  ResolvedReadReference,
  StorageTargetDescriptor,
  StoredObjectRef,
} from './attachment-ports.js';
import {
  encodeReadReferenceToken,
  newReadReferenceSigningKey,
  verifyReadReferenceToken,
} from './read-reference-tokens.js';

export const IN_MEMORY_STORAGE_KIND = 'memory';

export interface InMemoryObjectStorageOptions {
  /** 存储目标标识（默认 'memory'）。 */
  readonly target?: string | undefined;
  /** 签发密钥（默认随机 32 字节——重启后旧引用失效）。 */
  readonly signingKey?: Uint8Array | undefined;
  /** 引用 URL 基址（默认 '/attachment/storage'，即本模块开门面路由）。 */
  readonly referenceBaseUrl?: string | undefined;
}

export class InMemoryObjectStorage implements ObjectStoragePort {
  private readonly target: string;
  private readonly signingKey: Uint8Array;
  private readonly referenceBaseUrl: string;
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>();

  constructor(options: InMemoryObjectStorageOptions = {}) {
    this.target = options.target ?? 'memory';
    this.signingKey = options.signingKey ?? newReadReferenceSigningKey();
    this.referenceBaseUrl = (options.referenceBaseUrl ?? '/attachment/storage').replace(/\/+$/, '');
  }

  async currentTarget(_tenant: TenantId): Promise<StorageTargetDescriptor> {
    return { storageKind: IN_MEMORY_STORAGE_KIND, target: this.target };
  }

  async put(
    _tenant: TenantId,
    input: PutObjectInput,
  ): Promise<StoredObjectRef> {
    const objectKey = newObjectKey(input.fileName);
    this.objects.set(`${this.target}|${objectKey}`, {
      bytes: input.bytes,
      contentType: input.contentType ?? null,
    });
    return { storageKind: IN_MEMORY_STORAGE_KIND, target: this.target, objectKey };
  }

  async issueReadReference(
    _tenant: TenantId,
    object: StoredObjectRef,
    options: IssueReadReferenceOptions,
  ): Promise<ObjectReadReference> {
    const stored = this.objects.get(`${object.target}|${object.objectKey}`);
    if (stored === undefined) {
      // 文档二.5：桶/Key 非法返回明确业务错误（不区分原因细节，不带凭据）
      throw new AttachmentStorageError(`对象存储内不存在目标 '${object.target}' 的对象 '${object.objectKey}'`);
    }
    return this.encodeReference(object, stored.contentType, options);
  }

  async resolveReadReference(_tenant: TenantId, token: string): Promise<ResolvedReadReference | null> {
    const claims = verifyReadReferenceToken(this.signingKey, token, new Date());
    if (claims === null) return null;
    if (claims.target !== this.target) return null; // 令牌属其他适配器实例
    const stored = this.objects.get(`${claims.target}|${claims.objectKey}`);
    if (stored === undefined) return null;
    return {
      bytes: stored.bytes,
      contentType: stored.contentType ?? claims.contentType,
      downloadName: claims.downloadName,
    };
  }

  private encodeReference(
    object: StoredObjectRef,
    contentType: string | null,
    options: IssueReadReferenceOptions,
  ): ObjectReadReference {
    const expiresAtMs = Date.now() + options.ttlSeconds * 1000;
    const token = encodeReadReferenceToken(this.signingKey, {
      target: object.target,
      objectKey: object.objectKey,
      expiresAtMs,
      downloadName: options.downloadName ?? '',
      contentType,
    });
    return {
      url: `${this.referenceBaseUrl}/${token}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresInSeconds: options.ttlSeconds,
    };
  }
}
