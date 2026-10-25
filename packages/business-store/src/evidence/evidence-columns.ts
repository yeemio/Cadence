/**
 * 证据标准公共列 —— 存储侧构造器与行形状
 * （architecture/contracts/evidence-columns.v1.md；核心形状见
 *  business-core/src/evidence/evidence-columns.ts，本模块不改其公共 API）。
 *
 * 复用模式：Prisma 无 mixin。证据列以约定字段块在每个事实模型重复（prisma/schema.prisma），
 * 本模块提供唯一的构造入口，schema 漂移由 tests/schema-conformance.test.ts 机器校验。
 *
 * 时间口径：domain/core 层一律 ISO 8601 字符串（EvidenceColumns / BusinessEvent 均如此），
 * Prisma 层一律 Date（@db.Timestamptz）——本模块是唯一换算点。
 *
 * 多租户（ADR-0005）：入参 tenantId 为品牌化 TenantId（由 TenantContext.current()
 * 解析而来）——存储入口不接受裸 string，租户身份从命令信封进、贯穿到行。
 */
import type { EvidenceColumns, TenantId } from '@smes/business-core';
import { isUuid, isUuidv7, uuidv7 } from '../ids/uuidv7.js';

/** 事实表证据公共列的插入形状（可整体展开进 Prisma create()）。 */
export interface EvidenceColumnsRow {
  /** uuidv7 主键（时间有序） */
  readonly id: string;
  readonly tenantId: TenantId;
  /** 乐观锁版本 >= 1；expectedRevision 对账锚点 */
  readonly objectVersion: number;
  /** 审核状态；合法值集合由领域规格（M2）定义，这里只要求非空 */
  readonly auditStatus: string;
  /** JSONB 溯源（operationId、命令信封摘要、来源系统等） */
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** 本记录取代的前任记录 id（append-only 修正链） */
  readonly supersedes?: string;
  readonly businessTime?: Date;
  readonly availableTime?: Date;
}

/** buildEvidenceColumns 入参（时间为 ISO 8601 字符串——领域口径）。 */
export interface EvidenceColumnsInput {
  readonly tenantId: TenantId;
  readonly auditStatus: string;
  /** 缺省 1（首版） */
  readonly objectVersion?: number;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
  /** 显式注入 id（测试 / 数据迁移导入）；缺省生成 uuidv7 */
  readonly id?: string;
}

function toDbTime(value: string, column: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ${column}: expected an ISO 8601 date-time string, got "${value}"`);
  }
  return parsed;
}

/**
 * 构造事实表证据公共列（冻结）。
 * 校验：auditStatus 非空；objectVersion 整数 >= 1；id/supersedes 须为合法 UUID；
 * 时间须可解析。auditStatus 的合法值集合不在本层判断（M2 领域规格职责）。
 */
export function buildEvidenceColumns(input: EvidenceColumnsInput): EvidenceColumnsRow {
  const { tenantId, auditStatus } = input;

  if (typeof auditStatus !== 'string' || auditStatus.trim().length === 0) {
    throw new Error('invalid auditStatus: expected a non-empty string (legal values come from M2 domain specs)');
  }
  const objectVersion = input.objectVersion ?? 1;
  if (!Number.isInteger(objectVersion) || objectVersion < 1) {
    throw new Error(`invalid objectVersion: expected an integer >= 1, got ${String(input.objectVersion)}`);
  }
  const id = input.id ?? uuidv7();
  if (!isUuidv7(id)) {
    throw new Error(`invalid id: expected a uuidv7 string, got "${id}"`);
  }
  if (input.supersedes !== undefined && !isUuid(input.supersedes)) {
    throw new Error(`invalid supersedes: expected a uuid string, got "${String(input.supersedes)}"`);
  }

  return Object.freeze({
    id,
    tenantId,
    objectVersion,
    auditStatus,
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    ...(input.businessTime === undefined ? {} : { businessTime: toDbTime(input.businessTime, 'businessTime') }),
    ...(input.availableTime === undefined ? {} : { availableTime: toDbTime(input.availableTime, 'availableTime') }),
  });
}

/** DB 行 → 领域形状（EvidenceColumns，ISO 字符串）；Date 不可用时字段省略。 */
export function fromEvidenceRow(row: EvidenceColumnsRow): EvidenceColumns {
  return Object.freeze({
    id: row.id,
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === undefined || row.provenance === null ? {} : { provenance: row.provenance }),
    ...(row.supersedes === undefined || row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.businessTime === undefined || row.businessTime === null
      ? {}
      : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === undefined || row.availableTime === null
      ? {}
      : { availableTime: row.availableTime.toISOString() }),
  });
}
