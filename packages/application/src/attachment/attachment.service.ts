/**
 * AttachmentService —— 附件中心用例（U3 A13 文件管理）。
 *
 * 零框架业务类（不 import @nestjs/*）：统一附件元数据的追加/挂取/逻辑删除/
 * 只读引用签发。上传字节经 ObjectStoragePort.put、下载经端口签发**短时只读
 * 引用**（文档二.5 presign-download 的零基建重述）。身份一律从 AuthGuard
 * 写入的请求身份进（ADR-0005），createdAt/deletedAt 由服务端取当前时刻。
 *
 * 本期已确认决策（文档 §6，逐条镜像）：
 *  - 不做 URL 重复/文件名唯一/大小与类型白名单校验；同 bizId 允许多条追加；
 *  - 列表仅按 bizId 过滤（不按 bizType——跨表主键唯一由业务侧 id 生成保证）；
 *  - 删除只置逻辑删除，不删物理对象；
 *  - 下载引用：id+bizId 必填且须与记录一致（防误用他业务附件 id）、拒绝已删；
 *  - 引用有效期默认 60 秒（文档 1.6 参数表 trace.bizFile.presignTtlSeconds
 *    的模块配置化重述：未配置或非法回退 60）。
 */
import { UserId, type TenantId } from '@smes/business-core';
import { AttachmentConflictError, AttachmentNotFoundError } from './attachment-errors.js';
import {
  parseRemoveIdsInput,
  parseSaveAttachmentBatchInput,
  parseSaveAttachmentInput,
  parseUploadAttachmentInput,
  type DownloadReferenceQuery,
  type SaveAttachmentPayload,
} from './attachment-input.js';
import type { ObjectReadReference, ObjectStoragePort } from './attachment-ports.js';
import type { Attachment, AttachmentStore, SaveAttachmentInput } from './attachment-stores.js';

/** 下载引用默认有效期（秒）——文档 1.6 参数表默认值。 */
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 60;

/** 列表/详情 VO：不下发存储引用三字段（storageKind/target/objectKey——文档已确认决策）。 */
export interface AttachmentView {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string | null;
  readonly fileUrl: string | null;
  readonly bizType: string;
  readonly bizId: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** 下载引用回执（文档 PresignDownloadVO：url + 过期时间点 + 有效秒数 + 展示名）。 */
export interface DownloadReference extends ObjectReadReference {
  readonly attachmentId: string;
  readonly downloadName: string;
}

export interface AttachmentServiceOptions {
  /** 下载引用有效期秒数；非法（非正整数/>1 天）回退 60。 */
  readonly downloadTtlSeconds?: number | undefined;
  /** 时钟注入（测试用；缺省真实时间）。 */
  readonly clock?: (() => Date) | undefined;
}

function resolveTtl(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_DOWNLOAD_TTL_SECONDS;
  return Number.isInteger(raw) && raw >= 1 && raw <= 86_400 ? raw : DEFAULT_DOWNLOAD_TTL_SECONDS;
}

export class AttachmentService {
  private readonly downloadTtlSeconds: number;
  private readonly clock: () => Date;

  constructor(
    private readonly store: AttachmentStore,
    private readonly objectStorage: ObjectStoragePort,
    options: AttachmentServiceOptions = {},
  ) {
    this.downloadTtlSeconds = resolveTtl(options.downloadTtlSeconds);
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * 上传并登记（Cadence 增量面——文档体系上传在他处完成，本波经端口收口）：
   * 字节经端口 put（对象键由端口生成），成功后落元数据行。put 成功而登记
   * 失败会留下孤儿对象（无引用不可达，容忍——物理清理归存储侧运维）。
   */
  async upload(tenant: TenantId, actor: UserId, input: unknown): Promise<AttachmentView> {
    const payload = parseUploadAttachmentInput(input);
    const stored = await this.objectStorage.put(tenant, {
      fileName: payload.fileName,
      ...(payload.contentType === undefined ? {} : { contentType: payload.contentType }),
      bytes: payload.bytes,
    });
    const created = await this.store.create({
      tenant,
      fileName: payload.fileName,
      ...(payload.contentType === undefined ? {} : { contentType: payload.contentType }),
      storageKind: stored.storageKind,
      target: stored.target,
      objectKey: stored.objectKey,
      bizType: payload.bizType,
      bizId: payload.bizId,
      createdBy: actor,
    });
    return toView(created);
  }

  /** 单条登记（文档二.2 save：为已 put 对象挂元数据；target 服务端按端口当前目标写入）。 */
  async save(tenant: TenantId, actor: UserId, input: unknown): Promise<AttachmentView> {
    const rows = await this.saveParsed(tenant, actor, [parseSaveAttachmentInput(input)]);
    return rows[0]!; // 载荷 ≥1 → 行 ≥1
  }

  /** 批量登记（文档二.3 save-batch：至少 1 条、逐条校验、原子整批、顺序一致）。 */
  async saveBatch(tenant: TenantId, actor: UserId, input: unknown): Promise<readonly AttachmentView[]> {
    return this.saveParsed(tenant, actor, parseSaveAttachmentBatchInput(input));
  }

  /**
   * 已解析载荷的共用落行面：target 一律取端口当前目标（文档 1.4：桶名服务端
   * 写入，调用方无需传）；createMany 原子整批（任一条失败全不落）。
   */
  private async saveParsed(
    tenant: TenantId,
    actor: UserId,
    payloads: readonly SaveAttachmentPayload[],
  ): Promise<readonly AttachmentView[]> {
    const current = await this.objectStorage.currentTarget(tenant);
    const rows = await this.store.createMany(
      payloads.map((payload): SaveAttachmentInput => ({
        tenant,
        fileName: payload.fileName,
        ...(payload.contentType === undefined ? {} : { contentType: payload.contentType }),
        storageKind: payload.storageKind,
        target: current.target,
        objectKey: payload.objectKey,
        ...(payload.fileUrl === undefined ? {} : { fileUrl: payload.fileUrl }),
        bizType: payload.bizType,
        bizId: payload.bizId,
        createdBy: actor,
      })),
    );
    return rows.map(toView);
  }

  /** 按业务主键列有效附件（文档二.1：仅按 bizId 过滤，序 createdAt DESC, id ASC）。 */
  async listByBizId(tenant: TenantId, bizId: string): Promise<readonly AttachmentView[]> {
    return (await this.store.listByBizId(tenant, bizId)).map(toView);
  }

  /** 逻辑删除（文档二.4 remove：逗号分隔多 id；不删物理对象）。 */
  async remove(tenant: TenantId, input: unknown): Promise<{ readonly removedIds: readonly string[] }> {
    const ids = parseRemoveIdsInput(input);
    const removedIds = await this.store.softDelete(tenant, ids, this.clock().toISOString());
    return { removedIds };
  }

  /**
   * 签发下载引用（文档二.5 presign-download）：
   * 记录须存在且未删（否则 404 语义）；bizId 须与记录一致（否则 409——防误用
   * 其他业务的附件 id）；downloadName 缺省用 file_name；TTL 取模块配置。
   */
  async issueDownloadReference(
    tenant: TenantId,
    query: DownloadReferenceQuery,
  ): Promise<DownloadReference> {
    const record = await this.store.findById(tenant, query.id);
    if (record === null || record.deletedAt !== null) {
      throw new AttachmentNotFoundError(`租户 '${tenant}' 内不存在有效附件 '${query.id}'`);
    }
    if (record.bizId !== query.bizId) {
      throw new AttachmentConflictError(
        `附件 '${query.id}' 的业务主键与请求不一致（防误用其他业务的附件）`,
      );
    }
    const downloadName = query.downloadName ?? record.fileName; // 文档：不传则用 file_name
    const reference = await this.objectStorage.issueReadReference(
      tenant,
      { storageKind: record.storageKind, target: record.target, objectKey: record.objectKey },
      { ttlSeconds: this.downloadTtlSeconds, downloadName },
    );
    return { attachmentId: record.id, downloadName, ...reference };
  }

  /** 开门面：解析短时只读引用（无效/过期/对象缺失 → 404 语义，不区分原因）。 */
  async resolveReadReference(tenant: TenantId, token: string): Promise<{
    readonly bytes: Uint8Array;
    readonly contentType: string | null;
    readonly downloadName: string;
  }> {
    const resolved = await this.objectStorage.resolveReadReference(tenant, token);
    if (resolved === null) {
      throw new AttachmentNotFoundError('附件只读引用无效或已过期');
    }
    return resolved;
  }
}

function toView(record: Attachment): AttachmentView {
  // 不下发 storageKind/target/objectKey（文档已确认决策：减少暴露，预签名仅走后端）
  return {
    id: record.id,
    fileName: record.fileName,
    contentType: record.contentType,
    fileUrl: record.fileUrl,
    bizType: record.bizType,
    bizId: record.bizId,
    createdBy: record.createdBy === null ? null : `${record.createdBy}`,
    createdAt: record.createdAt,
  };
}
