/**
 * 附件 id 与对象键生成（U3 A13，前缀 + uuid，跨模块引用一律 opaque 字符串）。
 *
 * id 前缀 `atc-`（attachment center）：与 workorder 线 WorkOrderAttachment 的
 * `att-` 前缀刻意区分——两表语义不同层（工作令域不可变事实 vs 通用附件元
 * 数据），前缀隔离防跨表误用（文档 §3「串附件」风险的结构性缓解之一）。
 * id 在各存储实现侧生成（内存/PG 各自实现同前缀策略）；仅模块内使用，不经
 * barrel 导出（与 workorder newAttachmentId 撞名的收敛面）。
 */
import { randomUUID } from 'node:crypto';

/** 附件中心行 id：atc-<uuid>（排序时序由 createdAt 承载，uuid 即可）。 */
export function newAttachmentId(): string {
  return `atc-${randomUUID()}`;
}

/**
 * 生成对象键（对象路径约定在存储侧，文档 §1.2：upload/yyyy/mm/dd/<名> 体例）。
 * slug 只取文件名安全字符（去路径、去空白、限长 80），键尾追加 uuid 保证唯一。
 */
export function newObjectKey(fileName: string): string {
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
