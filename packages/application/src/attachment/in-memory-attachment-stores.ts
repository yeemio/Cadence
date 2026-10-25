/**
 * InMemoryAttachmentStore —— 附件元数据端口先行实现（U3 A13）。
 *
 * 重启即失；PG 实现在 business-store（`./attachment` 子路径，导出登记归合流）。
 * 与 InMemoryNotificationStore 同形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。createMany 原子：先整批构造再落
 * （内存形态无中途失败面）；一切读删按 tenant 收口。
 */
import { TenantId, UserId } from '@smes/business-core';
import { newAttachmentId } from './attachment-ids.js';
import type {
  Attachment,
  AttachmentStore,
  SaveAttachmentInput,
} from './attachment-stores.js';

interface AttachmentRow {
  readonly tenant: string;
  readonly id: string;
  fileName: string;
  contentType: string | null;
  storageKind: string;
  target: string;
  objectKey: string;
  fileUrl: string | null;
  bizType: string;
  bizId: string;
  createdBy: string | null;
  readonly createdAt: string;
  deletedAt: string | null;
}

export class InMemoryAttachmentStore implements AttachmentStore {
  private readonly rows = new Map<string, AttachmentRow>(); // key: `${tenant}|${id}`

  async create(input: SaveAttachmentInput): Promise<Attachment> {
    const rows = await this.createMany([input]);
    return rows[0]!;
  }

  async createMany(inputs: readonly SaveAttachmentInput[]): Promise<readonly Attachment[]> {
    // 原子：整批先构造后落（文档二.3 任一条失败整批回滚——内存形态无中途失败面）
    const batch: AttachmentRow[] = inputs.map((input) => ({
      tenant: input.tenant,
      id: newAttachmentId(),
      fileName: input.fileName,
      contentType: input.contentType ?? null,
      storageKind: input.storageKind,
      target: input.target,
      objectKey: input.objectKey,
      fileUrl: input.fileUrl ?? null,
      bizType: input.bizType,
      bizId: input.bizId,
      createdBy: input.createdBy ?? null,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    }));
    for (const row of batch) this.rows.set(`${row.tenant}|${row.id}`, row);
    return batch.map(toAttachment);
  }

  async findById(tenant: TenantId, id: string): Promise<Attachment | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toAttachment(row);
  }

  async listByBizId(tenant: TenantId, bizId: string): Promise<readonly Attachment[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.bizId === bizId && row.deletedAt === null)
      // 文档 §1.3 排序：create_time DESC, id ASC
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1))
      .map(toAttachment);
  }

  async softDelete(
    tenant: TenantId,
    ids: readonly string[],
    deletedAt: string,
  ): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const id of ids) {
      const row = this.rows.get(`${tenant}|${id}`);
      if (row !== undefined && row.deletedAt === null) {
        row.deletedAt = deletedAt; // 逻辑删除（不删物理对象——文档二.4）
        removed.push(id);
      }
    }
    return removed;
  }
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    fileName: row.fileName,
    contentType: row.contentType,
    storageKind: row.storageKind,
    target: row.target,
    objectKey: row.objectKey,
    fileUrl: row.fileUrl,
    bizType: row.bizType,
    bizId: row.bizId,
    createdBy: row.createdBy === null ? null : UserId.create(row.createdBy),
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}
