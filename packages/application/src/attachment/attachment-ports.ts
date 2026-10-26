/**
 * ObjectStoragePort —— 对象存储端口（U3 A13 文件管理，依赖倒置）。
 *
 * 合同硬边界：本波只落内存 / 本地文件适配器，**不引入 MinIO/S3/任何对象存储
 * 运行时依赖**——基础设施接入归部署期（适配器换装不动业务面）。上传字节经
 * 端口 put、下载经端口签发**短时只读引用**（默认 TTL 60 秒，文档 1.6 参数表）。
 *
 * 口径重述（文档 §1.2 方案 B → 端口形态）：
 *  - 文档 storage_type（字典 1-MinIO/2-阿里云 OSS）→ `storageKind`：适配器
 *    自述串（'memory' / 'local-fs'，未来 'minio' 等）——字典 tinyint 是 legacy
 *    绑定，按 ADR-0010 重述为通用标识串；
 *  - 文档 bucket_name → `target`：存储目标标识（桶名 / 根目录名）。保存时
 *    由服务端按端口**当前启用目标**写入，调用方无需传（文档 1.4 同口径）；
 *  - 文档 object_key → `objectKey`：目标内对象键（不含桶名、不含前导 `/`）；
 *  - 文档 presign-download（Feign→mom-resource 预签名）→
 *    `issueReadReference`：由端口签发短时只读引用；零基建适配器（内存/本地
 *    文件）的引用 URL 指回本模块开门面（GET /attachment/storage/:token），
 *    token 即短时能力凭证——对应文档「桶策略 private + 仅带签名 GET」的本波
 *    等价物，签名校验/过期收敛在 `resolveReadReference`。
 *
 * 词汇纪律（ADR-0010 判定三问自证）：object / storage / reference / target
 * 均为跨行业通用词；行业语义只进数据行（bizType 取值由消费方定义）。
 */
import type { TenantId } from '@smes/business-core';

/** 端口内对象引用三字段（文档方案 B 存储三字段的通用化；列表 VO 不下发）。 */
export interface StoredObjectRef {
  /** 适配器自述存储类型（'memory' / 'local-fs' / 未来 'minio' 等）。 */
  readonly storageKind: string;
  /** 存储目标标识（桶名 / 本地根目录名）。 */
  readonly target: string;
  /** 目标内对象键（不含目标名、不含前导 `/`）。 */
  readonly objectKey: string;
}

/** 端口当前启用目标（save/save-batch 时 target 由服务端写入，调用方无需传）。 */
export interface StorageTargetDescriptor {
  readonly storageKind: string;
  readonly target: string;
}

/** 上传字节入参（对象键由端口侧生成——路径约定在存储侧，文档 §1.2）。 */
export interface PutObjectInput {
  /** 展示文件名（进对象键 slug 与签发下载名）。 */
  readonly fileName: string;
  readonly contentType?: string | null;
  readonly bytes: Uint8Array;
}

/** 签发选项：有效期秒数（服务层按文档参数表校验，缺省 60）+ 下载展示名。 */
export interface IssueReadReferenceOptions {
  readonly ttlSeconds: number;
  /** 浏览器下载展示名（文档 downloadName；缺省用附件 file_name）。 */
  readonly downloadName?: string | null;
}

/** 只读引用回执（文档 PresignDownloadVO：url + 过期时间点 + 有效秒数）。 */
export interface ObjectReadReference {
  /** 短时只读引用 URL（GET）。 */
  readonly url: string;
  /** 过期时间点（ISO-8601）。 */
  readonly expiresAt: string;
  /** 本次有效秒数（与签发读取结果一致）。 */
  readonly expiresInSeconds: number;
}

/** 开门面解析结果（本模块自身服务引用 URL 的零基建形态）。 */
export interface ResolvedReadReference {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly downloadName: string;
}

/**
 * 对象存储端口。实现方保证：
 *  - put 生成对象键（upload/日期/uuid 体例）并落字节，回执含三字段引用；
 *  - issueReadReference 对不存在的对象抛 AttachmentStorageError（文档：桶/Key
 *    非法返回明确业务错误，勿泄露凭据）；
 *  - resolveReadReference 校验签名与有效期——无效/过期/对象缺失一律返回
 *    null（404 语义由用例层翻译），不区分失败原因（不泄漏存在性）；
 *  - 只读引用令牌绑定签发租户：resolveReadReference 与传入 tenant 比对
 *    不一致（跨租户兑现）同样返回 null（D-4：同无效语义拒绝）；
 *  - 全部按租户收口（元数据/引用均按 tenant 形参收口；本波适配器对象
 *    落盘仍按实例隔离，桶级隔离归部署期）。
 */
export interface ObjectStoragePort {
  currentTarget(tenant: TenantId): Promise<StorageTargetDescriptor>;
  put(tenant: TenantId, input: PutObjectInput): Promise<StoredObjectRef>;
  issueReadReference(
    tenant: TenantId,
    object: StoredObjectRef,
    options: IssueReadReferenceOptions,
  ): Promise<ObjectReadReference>;
  resolveReadReference(tenant: TenantId, token: string): Promise<ResolvedReadReference | null>;
}
