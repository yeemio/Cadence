/**
 * AttachmentStore 的 PG 实现 + 组合根装配工厂（U3 A13，经本包 `./attachment`
 * 子路径导出——与 `./notifications` 同模式：主入口保持零 @prisma/client 依赖；
 * 子路径登记归总控合流）。启动零 DB 依赖：connectAttachmentStore 只构造
 * PrismaClient（惰性连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 数据级过滤合同（application 端口）：一切读写按 (tenant_id) 收口——跨租户
 * 附件对当事人不可见（findById 不命中 → null）。createMany 走单事务逐条插入
 * （文档二.3：任一条失败整批回滚）。逻辑删除 = deleted_at 置位（不删物理
 * 对象——物理字节在 ObjectStoragePort 适配器侧）。
 */
import { PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, UserId } from '@smes/business-core';
import type {
  Attachment,
  AttachmentStore,
  SaveAttachmentInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

interface AttachmentDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly fileName: string;
  readonly contentType: string | null;
  readonly storageKind: string;
  readonly target: string;
  readonly objectKey: string;
  readonly fileUrl: string | null;
  readonly bizType: string;
  readonly bizId: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

function toAttachment(row: AttachmentDbRow): Attachment {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    fileName: row.fileName,
    contentType: row.contentType,
    storageKind: row.storageKind,
    target: row.target,
    objectKey: row.objectKey,
    fileUrl: row.fileUrl,
    bizType: row.bizType,
    bizId: row.bizId,
    createdBy: row.createdBy === null ? null : UserId.create(row.createdBy),
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

function toData(input: SaveAttachmentInput) {
  return {
    // 应用侧权威生成（本包 id 策略）：atc-<uuidv7> 前缀族同 application 内存
    // 实现（attachment-ids.ts——两表前缀 att-/atc- 刻意区分，见该文件头注）
    id: `atc-${uuidv7()}`,
    tenantId: input.tenant,
    fileName: input.fileName,
    contentType: input.contentType ?? null,
    storageKind: input.storageKind,
    target: input.target,
    objectKey: input.objectKey,
    fileUrl: input.fileUrl ?? null,
    bizType: input.bizType,
    bizId: input.bizId,
    createdBy: input.createdBy ?? null,
  };
}

export class PgAttachmentStore implements AttachmentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: SaveAttachmentInput): Promise<Attachment> {
    const row = await this.prisma.attachmentRecord.create({ data: toData(input) });
    return toAttachment(row);
  }

  async createMany(inputs: readonly SaveAttachmentInput[]): Promise<readonly Attachment[]> {
    if (inputs.length === 0) return [];
    // 单事务逐条插入：任一条失败整批回滚（文档二.3）；返回序与入参一致
    const rows = await this.prisma.$transaction(
      inputs.map((input) => this.prisma.attachmentRecord.create({ data: toData(input) })),
    );
    return rows.map(toAttachment);
  }

  async findById(tenant: TenantId, id: string): Promise<Attachment | null> {
    const row = await this.prisma.attachmentRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toAttachment(row);
  }

  async listByBizId(tenant: TenantId, bizId: string): Promise<readonly Attachment[]> {
    const rows = await this.prisma.attachmentRecord.findMany({
      where: { tenantId: tenant, bizId, deletedAt: null }, // 仅有效数据（文档二.1）
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], // 文档 §1.3 全局排序约定
    });
    return rows.map(toAttachment);
  }

  async softDelete(
    tenant: TenantId,
    ids: readonly string[],
    deletedAt: string,
  ): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    const at = new Date(deletedAt);
    const uniqueIds = [...new Set(ids)];
    return this.prisma.$transaction(async (tx) => {
      const hits = await tx.attachmentRecord.findMany({
        where: { tenantId: tenant, id: { in: uniqueIds }, deletedAt: null },
        select: { id: true },
      });
      const hitIds = new Set(hits.map((row) => row.id));
      if (hitIds.size > 0) {
        await tx.attachmentRecord.updateMany({
          where: { tenantId: tenant, id: { in: [...hitIds] } },
          data: { deletedAt: at },
        });
      }
      return ids.filter((id) => hitIds.has(id)); // 实际置删序 = 入参序（去重前保持）
    });
  }
}

export interface AttachmentStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：附件元数据端口实现 + 优雅断连。 */
export interface AttachmentStoreHandle {
  readonly attachmentStore: AttachmentStore;
  disconnect(): Promise<void>;
}

/** 构造附件中心 PG 存储装配（惰性连接：同 `./notifications`）。 */
export function connectAttachmentStore(
  options: AttachmentStoreOptions = {},
): AttachmentStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    attachmentStore: new PgAttachmentStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
