/**
 * LocalFileSystemObjectStorage —— ObjectStoragePort 本地文件适配器（U3 A13）。
 *
 * 对象落在本地目录树（对象键即相对路径，upload/yyyy/mm/dd/ 体例），不引入
 * 任何对象存储运行时依赖（合同硬边界：MinIO/S3 接入归部署期换装）。引用 URL
 * 指回本模块开门面（默认 /attachment/storage/<token>），HMAC 短时能力凭证
 * 同内存适配器（见 read-reference-tokens.ts）。
 *
 * 路径安全：对象键在输入解析层已拒前导 `/`、反斜杠与 `.`/`..` 段（save 面）；
 * 本适配器落盘前再收敛 resolve 结果必须仍在根目录内（双保险，防令牌载荷被
 * 构造）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
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

export const LOCAL_FILE_STORAGE_KIND = 'local-fs';

export interface LocalFileSystemObjectStorageOptions {
  /** 本地根目录（对象键相对该目录落盘）。 */
  readonly rootDirectory: string;
  /** 存储目标标识（默认 'local'）。 */
  readonly target?: string | undefined;
  /** 签发密钥（默认随机 32 字节——重启后旧引用失效）。 */
  readonly signingKey?: Uint8Array | undefined;
  /** 引用 URL 基址（默认 '/attachment/storage'，即本模块开门面路由）。 */
  readonly referenceBaseUrl?: string | undefined;
}

export class LocalFileSystemObjectStorage implements ObjectStoragePort {
  private readonly rootDirectory: string;
  private readonly target: string;
  private readonly signingKey: Uint8Array;
  private readonly referenceBaseUrl: string;

  constructor(options: LocalFileSystemObjectStorageOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.target = options.target ?? 'local';
    this.signingKey = options.signingKey ?? newReadReferenceSigningKey();
    this.referenceBaseUrl = (options.referenceBaseUrl ?? '/attachment/storage').replace(/\/+$/, '');
  }

  async currentTarget(_tenant: TenantId): Promise<StorageTargetDescriptor> {
    return { storageKind: LOCAL_FILE_STORAGE_KIND, target: this.target };
  }

  async put(_tenant: TenantId, input: PutObjectInput): Promise<StoredObjectRef> {
    const objectKey = newObjectKey(input.fileName);
    const filePath = this.pathOf(objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.bytes);
    if (input.contentType !== undefined && input.contentType !== null && input.contentType !== '') {
      // 内容类型不入文件系统侧（随令牌载荷签发）；此处仅为端口面完整性保留分支
      await this.writeSidecar(filePath, input.contentType);
    }
    return { storageKind: LOCAL_FILE_STORAGE_KIND, target: this.target, objectKey };
  }

  async issueReadReference(
    tenant: TenantId,
    object: StoredObjectRef,
    options: IssueReadReferenceOptions,
  ): Promise<ObjectReadReference> {
    const filePath = this.pathOf(object.objectKey);
    try {
      await stat(filePath); // 存在性验证（内容经开门面按需读取）
    } catch {
      // 文档二.5：桶/Key 非法返回明确业务错误（不带凭据）
      throw new AttachmentStorageError(`对象存储内不存在目标 '${object.target}' 的对象 '${object.objectKey}'`);
    }
    const contentType = await this.readSidecar(filePath);
    const expiresAtMs = Date.now() + options.ttlSeconds * 1000;
    const token = encodeReadReferenceToken(this.signingKey, {
      tenantId: tenant,
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

  async resolveReadReference(tenant: TenantId, token: string): Promise<ResolvedReadReference | null> {
    const claims = verifyReadReferenceToken(this.signingKey, token, new Date());
    if (claims === null) return null;
    if (claims.target !== this.target) return null;
    if (claims.tenantId !== tenant) return null; // 令牌非本租户签发（D-4：同无效语义拒绝）
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(this.pathOf(claims.objectKey)));
    } catch {
      return null; // 对象已不在（删除/清理）——不区分原因
    }
    const sidecar = await this.readSidecar(this.pathOf(claims.objectKey));
    return {
      bytes,
      contentType: sidecar ?? claims.contentType,
      downloadName: claims.downloadName,
    };
  }

  /** 对象键 → 根目录内绝对路径（越界即拒——双保险）。 */
  private pathOf(objectKey: string): string {
    const fullPath = resolve(this.rootDirectory, ...objectKey.split('/'));
    if (fullPath !== this.rootDirectory && !fullPath.startsWith(this.rootDirectory + sep)) {
      throw new AttachmentStorageError('对象键越界（不在存储根目录内）');
    }
    return fullPath;
  }

  private sidecarPath(filePath: string): string {
    return `${filePath}.content-type`;
  }

  private async writeSidecar(filePath: string, contentType: string): Promise<void> {
    await writeFile(this.sidecarPath(filePath), contentType, 'utf8');
  }

  private async readSidecar(filePath: string): Promise<string | null> {
    try {
      return (await readFile(this.sidecarPath(filePath), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }
}
