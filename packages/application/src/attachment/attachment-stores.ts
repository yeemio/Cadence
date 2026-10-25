/**
 * AttachmentStore / Attachment —— 统一附件元数据存储端口（U3 A13 文件管理，
 * 文档 mes_biz_file 的 Cadence 重述）。
 *
 * 与 notifications 同一模式：端口在本包定义（业务形状），内存实现先行，PG
 * adapter 由 business-store 按 `./attachment` 子路径接入（子路径导出登记归
 * 合流）。
 *
 * 取舍（表形态，schema.prisma attachment 节同文）：附件元数据是轻量运营
 * 状态（追加 + 逻辑删除），不是业务事实——不套证据公共列、不设 append-only
 * 触发器（workorder 线的 work_order_attachments 是工作令域的**不可变业务
 * 事实表**，与本通用附件元数据模块不同层，互不替代；文档 §3 消费方接线归
 * 后续波）。
 *
 * 口径重述（文档 §1.3/§1.4 → 端口形状）：
 *  - biz_module（字典 1-工作令…7-售后派工验收单）→ `bizType`：通用类型码
 *    （单段小写形状，如 'workorder'；取值由消费方定义——ADR-0010 晚绑定，
 *    字典 tinyint 是 legacy 绑定不进内核）；
 *  - is_deleted（tinyint）→ `deletedAt`（null = 有效）；列表固定过滤已删；
 *  - status（框架占位）→ 不落（文档：不参与本模块业务含义）；
 *  - create_dept/update_user/update_time → 不设独立更新面（本期仅追加/删除，
 *    文档 §1.4「更新字段可按项目惯例仅删除时触发展开」→ PG 形态 updatedAt
 *    触发器列承载）；
 *  - 排序：createdAt DESC, id ASC（文档 §1.3 全局约定）。
 *
 * 数据级过滤合同（同 notifications）：一切读写按 (tenant) 收口——跨租户附件
 * 对当事人表现为"不存在"（null / 空列表），不泄漏存在性。
 */
import { TenantId, UserId } from '@smes/business-core';

/**
 * 关联业务对象类型码：单段小写形状（如 'workorder'），语义由消费方定义
 * （文档 file_biz_module 字典的通用化；形状校验在输入解析层）。
 */
export type AttachmentBizType = string;

/** 附件元数据行（全量形态，含存储引用三字段——仅签发只读引用时用）。 */
export interface Attachment {
  readonly id: string;
  readonly tenant: TenantId;
  /** 展示文件名（可与存储名不一致；≤255）。 */
  readonly fileName: string;
  readonly contentType: string | null;
  /** 存储引用三字段（文档 storage_type/bucket_name/object_key 的通用化）。
   * 列表 VO 不下发（文档已确认决策：减少暴露）。 */
  readonly storageKind: string;
  readonly target: string;
  readonly objectKey: string;
  /** 展示/兼容地址（可空——下载不以它为准，以签发只读引用为准）。 */
  readonly fileUrl: string | null;
  readonly bizType: AttachmentBizType;
  /** 关联业务主键（opaque；跨表主键唯一由业务侧 id 生成保证——文档 §3 风险）。 */
  readonly bizId: string;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  /** 逻辑删除时刻（null = 有效；删除不删物理对象——文档二.4）。 */
  readonly deletedAt: string | null;
}

export interface SaveAttachmentInput {
  readonly tenant: TenantId;
  readonly fileName: string;
  readonly contentType?: string | null;
  readonly storageKind: string;
  readonly target: string;
  readonly objectKey: string;
  readonly fileUrl?: string | null;
  readonly bizType: AttachmentBizType;
  readonly bizId: string;
  readonly createdBy?: UserId | null;
}

/**
 * 附件元数据存储端口。实现方保证：
 *  - create/createMany 落行并服务端生成 id/createdAt（deletedAt=null）；
 *  - createMany **原子**：任一条失败整批不落（文档二.3 同一事务逐条插入）；
 *  - findById 返回含已删行（是否可用由用例层裁定——文档：预签名拒绝已删）；
 *  - listByBizId 仅按 (tenant, bizId) 过滤有效行（不按 bizType 过滤——文档
 *    二.1「通过 id 即可」），序 = createdAt DESC, id ASC；
 *  - softDelete 置逻辑删除并返回**实际置删**的 id（不存在/已删忽略）。
 */
export interface AttachmentStore {
  create(input: SaveAttachmentInput): Promise<Attachment>;
  createMany(inputs: readonly SaveAttachmentInput[]): Promise<readonly Attachment[]>;
  findById(tenant: TenantId, id: string): Promise<Attachment | null>;
  listByBizId(tenant: TenantId, bizId: string): Promise<readonly Attachment[]>;
  softDelete(
    tenant: TenantId,
    ids: readonly string[],
    deletedAt: string,
  ): Promise<readonly string[]>;
}
