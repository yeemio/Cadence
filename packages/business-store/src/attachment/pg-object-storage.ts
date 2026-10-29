/**
 * PgObjectStorage —— ObjectStoragePort 的 PG bytea 适配器（fix-wave-4 W4-2 /
 * D-3：附件内容持久化）。附件字节存 PG 表 attachment_objects（bytea，TOAST
 * 行外，32MiB 护栏内），重启随 pg-data 卷存活——修复内存适配器重启即丢、
 * download-reference 502。引用 URL 仍指回本模块开门面（默认
 * /attachment/storage/<token>），token 为 HMAC 短时能力凭证——复用
 * application 的 read-reference-tokens 工具（租户绑定令牌语义自动继承，
 * D-4 波加固），本适配器零令牌实现。
 *
 * 与内存/本地文件适配器的取舍对照：
 *  - 对象键体例同源（upload/yyyy/mm/dd/<uuid>-<slug>，路径约定在存储侧，
 *    attachment-ports.ts 合同注释）；键生成器不进 application barrel
 *    （attachment-ids.ts 头注：与 workorder newAttachmentId 撞名收敛），
 *    本包自带同体例实现（object_key 库内唯一，uuid 保证）。
 *  - 签发密钥实例自持随机（重启轮换，与短时 TTL 语义一致——重启后旧引用
 *    失效不属持久化回归：download-reference 每次重新签发）。
 *  - 无流式读写（put/resolve 全量进出 Node 内存，Prisma Bytes ↔ Uint8Array）
 *    ——与既有适配器同阶非回归（预研 R2）；附件字节计入 DB 容量（R3，
 *    归 deploy/README 容量口径，本波不展开）。
 *
 * RLS 租户收口（双层）：
 *  - 端口层：一切读写 where 恒含 tenantId（与 PgAttachmentStore 同纪律）；
 *  - 数据库层：attachment_objects 已登 RLS_TABLES（tenant_isolation 谓词，
 *    全仓 102 表一致）；走 Prisma 模型操作 → SMES_RLS_SESSION=on 时自动
 *    经 withRlsTenantSession 包事务 SET app.current_tenant（无 raw SQL，
 *    不触碰 rls-session 已知边界的 raw 面）。
 *
 * 性能纪律（预研 R4）：issueReadReference 只验存在性 + 取 contentType
 * （select 显式排除 bytes 列）——签发永不触发 bytea 解 TOAST；字节列仅
 * resolveReadReference（开门面兑现）按需读取。
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TenantId } from '@smes/business-core';
import {
  AttachmentStorageError,
  MAX_UPLOAD_BYTES,
  encodeReadReferenceToken,
  newReadReferenceSigningKey,
  verifyReadReferenceToken,
} from '@smes/application';
import type {
  IssueReadReferenceOptions,
  ObjectReadReference,
  ObjectStoragePort,
  PutObjectInput,
  ResolvedReadReference,
  StorageTargetDescriptor,
  StoredObjectRef,
} from '@smes/application';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';

export const PG_STORAGE_KIND = 'pg';

export interface PgObjectStorageOptions {
  /** 存储目标标识（默认 'pg'）。 */
  readonly target?: string | undefined;
  /** 签发密钥（默认随机 32 字节——重启后旧引用失效，与短时效语义一致）。 */
  readonly signingKey?: Uint8Array | undefined;
  /** 引用 URL 基址（默认 '/attachment/storage'，即本模块开门面路由）。 */
  readonly referenceBaseUrl?: string | undefined;
}

/**
 * Uint8Array<ArrayBufferLike> → Prisma Bytes 入参（Uint8Array<ArrayBuffer>，
 * TS 5.7+ 泛型数组面）：ArrayBuffer 底座零拷贝直传（上传链 Buffer.from 解码
 * 即此形态）；其余罕见底座（SharedArrayBuffer 等）一次拷贝收敛。
 */
function toPrismaBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/**
 * 生成对象键（upload/yyyy/mm/dd/<uuid>-<slug> 体例，同 application
 * attachment-ids.ts newObjectKey——存储侧路径约定的本包实现，见文件头注）。
 * slug 只取文件名安全字符（去路径、去空白、限长 80），键尾追加 uuid 保证唯一。
 */
function newObjectKey(fileName: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const slug =
    fileName
      .split(/[\\/]/)
      .pop()!
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '-')
      .replace(/^[-.]+|[-]+$/g, '')
      .slice(0, 80) || 'file';
  return `upload/${yyyy}/${mm}/${dd}/${randomUUID()}-${slug}`;
}

export class PgObjectStorage implements ObjectStoragePort {
  private readonly target: string;
  private readonly signingKey: Uint8Array;
  private readonly referenceBaseUrl: string;

  constructor(
    private readonly prisma: PrismaClient,
    options: PgObjectStorageOptions = {},
  ) {
    this.target = options.target ?? 'pg';
    this.signingKey = options.signingKey ?? newReadReferenceSigningKey();
    this.referenceBaseUrl = (options.referenceBaseUrl ?? '/attachment/storage').replace(/\/+$/, '');
  }

  async currentTarget(_tenant: TenantId): Promise<StorageTargetDescriptor> {
    return { storageKind: PG_STORAGE_KIND, target: this.target };
  }

  async put(tenant: TenantId, input: PutObjectInput): Promise<StoredObjectRef> {
    // 32MiB 护栏（纵深防御：传输面护栏在 attachment-input，此处为存储面硬上界）
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new AttachmentStorageError(
        `对象字节超存储护栏（${input.bytes.byteLength} > ${MAX_UPLOAD_BYTES}）`,
      );
    }
    const objectKey = newObjectKey(input.fileName);
    await this.prisma.attachmentObjectRecord.create({
      data: {
        tenantId: tenant,
        objectKey,
        bytes: toPrismaBytes(input.bytes),
        contentType: input.contentType ?? null,
      },
    });
    return { storageKind: PG_STORAGE_KIND, target: this.target, objectKey };
  }

  async issueReadReference(
    tenant: TenantId,
    object: StoredObjectRef,
    options: IssueReadReferenceOptions,
  ): Promise<ObjectReadReference> {
    if (object.target !== this.target) {
      // 非 PG 目标的引用（历史遗留 memory/local-fs 元数据行等）——明确业务
      // 错误，不静默串目标（消息形态同内存适配器；不带凭据）
      throw new AttachmentStorageError(
        `对象存储内不存在目标 '${object.target}' 的对象 '${object.objectKey}'`,
      );
    }
    // 存在性验证 + contentType（select 显式排除 bytes 列——签发永不解 TOAST，R4）
    const row = await this.prisma.attachmentObjectRecord.findFirst({
      where: { tenantId: tenant, objectKey: object.objectKey },
      select: { contentType: true },
    });
    if (row === null) {
      // 文档二.5：桶/Key 非法返回明确业务错误（不区分原因细节，不带凭据）
      throw new AttachmentStorageError(
        `对象存储内不存在目标 '${object.target}' 的对象 '${object.objectKey}'`,
      );
    }
    const expiresAtMs = Date.now() + options.ttlSeconds * 1000;
    const token = encodeReadReferenceToken(this.signingKey, {
      tenantId: tenant,
      target: object.target,
      objectKey: object.objectKey,
      expiresAtMs,
      downloadName: options.downloadName ?? '',
      contentType: row.contentType,
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
    if (claims.target !== this.target) return null; // 令牌属其他适配器实例
    if (claims.tenantId !== tenant) return null; // 令牌非本租户签发（D-4：同无效语义拒绝）
    const row = await this.prisma.attachmentObjectRecord.findFirst({
      where: { tenantId: tenant, objectKey: claims.objectKey },
      select: { bytes: true, contentType: true },
    });
    if (row === null) return null; // 对象已不在（清理/迁移缺失）——不区分原因
    return {
      bytes: row.bytes,
      contentType: row.contentType ?? claims.contentType,
      downloadName: claims.downloadName,
    };
  }
}

export interface AttachmentObjectStorageOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
  /**
   * 签发密钥透传（M2 安全前置批 SP-3）：main.ts 读 SMES_ATTACHMENT_REF_SECRET
   * 注入——env 固化后引用跨重启/跨实例可用；缺省随机 32 字节（重启后旧引用
   * 失效，与短时 TTL 语义一致——取舍同文件头注）。
   */
  readonly signingKey?: Uint8Array | undefined;
}

/** 组合根装配句柄：附件对象存储端口实现 + 优雅断连。 */
export interface AttachmentObjectStorageHandle {
  readonly objectStorage: ObjectStoragePort;
  disconnect(): Promise<void>;
}

/** 构造附件对象字节 PG 存储装配（惰性连接：同 connectAttachmentStore 先例）。 */
export function connectAttachmentObjectStorage(
  options: AttachmentObjectStorageOptions = {},
): AttachmentObjectStorageHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    // SP-3：signingKey 透传进 PgObjectStorage（此前构造未透传——env 固化形态
    // 经组合根注入；undefined 同缺省 = 随机密钥，零 DB/未设 env 行为不变）。
    objectStorage: new PgObjectStorage(client, { signingKey: options.signingKey }),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
