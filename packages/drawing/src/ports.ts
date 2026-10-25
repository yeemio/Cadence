/**
 * drawing 跨模块端口（M3，m3-drafts/03-drawing.md v1.0 §4；预热草案差异表
 * 定稿后的最小形状适配——payroll 先例）。
 *
 * 依赖方向（ADR-0004 专业包 / pro-pack-tier-edges）：
 *  - 仅依赖 business-core（UserId/TenantId）；v1 无 engine 依赖；
 *  - **被消费方向裁定（差异表 #3）**：workorder/dispatch/reporting/inspection
 *    等环节模块持钉版引用时**不 import 本包**（application-only-core 禁止
 *    application→专业包）——各模块以结构同形字段 `{ drawingId: string;
 *    version: number }` 进自己版本化 schema；引用存在性校验与通知投递归
 *    组合根（apps/server 粘合，本包只出查询面 drawingsForWorkOrder 供粘合）；
 *  - 变更通知端口（差异表 #1）：发布修订=领域命令，通知为**发布联动事实**
 *    （非独立入口）；端口从草案的"实施层通知通道"收口为**通知事实存储端口**
 *    （publish 返回落账行供事件溯源，readByDrawing 增租户参数），由存储层
 *    实现、组合根接线。
 *
 * 词汇纪律（ADR-0010）：revision / notice / ref / classification 全通用词；
 * "图号"作为 DrawingId 的数据值出现，不是类型。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { DrawingChangeNoticeId, DrawingId } from './drawing-ids.js';

/**
 * 业务对象挂图纸的引用形状：**钉住修订号**（合同 §2）。
 * 挂在 v3 的派工/报工/检验不随 v4 漂移；需感知新版走变更通知读取。
 * 消费模块以结构同形字段镜像（不 import 本包，差异表 #3）。
 */
export interface DrawingRef {
  readonly drawingId: DrawingId;
  readonly version: number;
}

/**
 * 查看者形状：查看动作的必经入参（保密两不变量的载体，合同 §2）。
 *   - drawing:read 权限在边缘 casbin 过滤（本包不验角色）；
 *   - clearance = 查看者保密许可等级（值集数据值，组合根按租户权限配置装配；
 *     未知值 fail-fast 拒绝，不默认放行）。
 * 无 viewer 的读路径不返回内容指针（fileRef）——查看必过门禁、必留痕。
 */
export interface DrawingViewer {
  readonly userId: UserId;
  readonly clearance: string;
}

/**
 * 图纸变更通知：新修订发布时的事实（from → to + 变更说明 + 发布时点）。
 * 首发修订 fromVersion=0（无 → v1）。发布联动=终端 append-only 事实，
 * supersedes 恒缺省。
 */
export interface DrawingChangeNotice {
  /** dnc-<uuidv7>（实现方生成）。 */
  readonly noticeId: DrawingChangeNoticeId;
  readonly tenant: TenantId;
  readonly drawingId: DrawingId;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changeNote: string;
  /** ISO 8601（= 修订发布时点）。 */
  readonly publishedAt: string;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

/** 按图纸读通知的可选游标：只取 toVersion 大于该值的通知（缺省全量）。 */
export interface DrawingChangeQuery {
  /** 只返回 toVersion 大于该值的通知。 */
  readonly sinceVersion?: number;
}

/** 通知落账入参（noticeId/createdAt 由实现方生成）。 */
export type AppendDrawingChangeNoticeInput = Omit<DrawingChangeNotice, 'noticeId' | 'createdAt'>;

/**
 * 变更通知端口（发布联动事实的存储面）：publish 在发布命令事务链上落通知行
 * （(tenant, drawingId, toVersion) 冲突抛 DrawingConflictError——实现方合同）；
 * readByDrawing 返回 toVersion 升序，供消费方轮询/对账（"我引用的 v3 是否
 * 已有更新"）。由实施层（内存先行 / business-store PG 结构同形镜像）实现、
 * 组合根接线。
 */
export interface DrawingChangeNoticePort {
  publish(input: AppendDrawingChangeNoticeInput): Promise<DrawingChangeNotice>;
  readByDrawing(
    tenant: TenantId,
    drawingId: DrawingId,
    query?: DrawingChangeQuery,
  ): Promise<readonly DrawingChangeNotice[]>;
}
