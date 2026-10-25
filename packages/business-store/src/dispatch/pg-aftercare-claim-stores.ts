/**
 * AftercareClaimStore 的 PG 实现（U5 A12）。表 = aftercare_claims /
 * aftercare_claim_lines（建表迁移 20261026160500；RLS 全表 tenant_id 收口，
 * 策略见 20261026161000 重放）。经 `./dispatch` 子路径导出；组合根经
 * connectDispatchStore（本族装配工厂，pg-dispatch-stores.ts）取实例——
 * 与派工单投影共享同一 PrismaClient。
 *
 * 端口合同（application aftercare-claim-stores.ts）：
 *  - create：单 + 整批行单事务原子落；(tenant, dispatchId) 唯一 = 一单一报销
 *    （P2002 → DispatchConflictError「已存在报销记录，请直接编辑」）；
 *  - find / findByDispatch：单 + 行集（lineNo 升序）；
 *  - updateFees：object_version 条件更新 + 行费用整批重写（同事务），零行命中
 *    → null（不存在/版本不符；updates 与既有行集不一一对应 → ConflictError
 *    数据级守卫）。
 *
 * 数据级过滤合同：一切读写按 (tenant_id) 收口——跨租户报销单对当事人表现为
 * "不存在"（null）。行无独立版本（随报销单批量推进，体例同表注）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantId, UserId } from '@smes/business-core';
import { DispatchConflictError, type AftercareClaim } from '@smes/application';
import type {
  AftercareClaimFeeUpdate,
  AftercareClaimLine,
  CreateAftercareClaimInput,
  AftercareClaimStore,
} from '@smes/application';

// ---- 行 <-> 领域形状映射 ----

interface AftercareClaimDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly dispatchId: string;
  readonly objectVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface AftercareClaimLineDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly claimId: string;
  readonly lineNo: number;
  readonly reportId: string;
  readonly reportDate: Date;
  readonly worker: string;
  readonly approvedBy: string | null;
  readonly approvedMinutes: number;
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  readonly remark: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToAftercareClaimLine(row: AftercareClaimLineDbRow): AftercareClaimLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    claimId: row.claimId,
    lineNo: row.lineNo,
    reportId: row.reportId,
    reportDate: row.reportDate.toISOString(),
    worker: UserId.create(row.worker),
    approvedBy: row.approvedBy === null ? null : UserId.create(row.approvedBy),
    approvedMinutes: row.approvedMinutes,
    lodgingMinor: row.lodgingMinor,
    trafficMinor: row.trafficMinor,
    overtimeMinor: row.overtimeMinor,
    otherMinor: row.otherMinor,
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 单头 + 行集组装（行 lineNo 升序）。 */
function toAftercareClaim(row: AftercareClaimDbRow, lines: readonly AftercareClaimLineDbRow[]): AftercareClaim {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    dispatchId: row.dispatchId,
    objectVersion: row.objectVersion,
    lines: [...lines].sort((a, b) => a.lineNo - b.lineNo).map(rowToAftercareClaimLine),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- PG 实现 ----

export class PgAftercareClaimStore implements AftercareClaimStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAftercareClaimInput): Promise<AftercareClaim> {
    if (input.lines.length === 0) {
      throw new DispatchConflictError('报销单明细行集不可为空（须有审批通过报工才有行）');
    }
    try {
      // 交互式事务：单 + 整批行原子落（端口合同）；唯一冲突（一单一报销 /
      // 行号 / 明细键）整批回滚。
      return await this.prisma.$transaction(async (tx) => {
        const head = await tx.aftercareClaimRecord.create({
          data: {
            id: input.id,
            tenantId: input.tenant,
            dispatchId: input.dispatchId,
            objectVersion: 1,
          },
        });
        const lineRows: AftercareClaimLineDbRow[] = [];
        for (const [index, line] of input.lines.entries()) {
          const row = await tx.aftercareClaimLineRecord.create({
            data: {
              id: line.id,
              tenantId: input.tenant,
              claimId: input.id,
              lineNo: index + 1,
              reportId: line.reportId,
              reportDate: new Date(line.reportDate),
              worker: line.worker,
              approvedBy: line.approvedBy,
              approvedMinutes: line.approvedMinutes,
              lodgingMinor: line.lodgingMinor,
              trafficMinor: line.trafficMinor,
              overtimeMinor: line.overtimeMinor,
              otherMinor: line.otherMinor,
              remark: line.remark,
            },
          });
          lineRows.push(row);
        }
        return toAftercareClaim(head, lineRows);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DispatchConflictError(
          `派工单 '${input.dispatchId}' 已存在报销记录，请直接编辑（一单一报销）`,
        );
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<AftercareClaim | null> {
    const head = await this.prisma.aftercareClaimRecord.findFirst({ where: { tenantId: tenant, id } });
    if (head === null) return null;
    const lines = await this.prisma.aftercareClaimLineRecord.findMany({
      where: { tenantId: tenant, claimId: id },
      orderBy: { lineNo: 'asc' },
    });
    return toAftercareClaim(head, lines);
  }

  async findByDispatch(tenant: TenantId, dispatchId: string): Promise<AftercareClaim | null> {
    const head = await this.prisma.aftercareClaimRecord.findFirst({ where: { tenantId: tenant, dispatchId } });
    if (head === null) return null;
    const lines = await this.prisma.aftercareClaimLineRecord.findMany({
      where: { tenantId: tenant, claimId: head.id },
      orderBy: { lineNo: 'asc' },
    });
    return toAftercareClaim(head, lines);
  }

  async updateFees(
    tenant: TenantId,
    claimId: string,
    expectedObjectVersion: number,
    updates: readonly AftercareClaimFeeUpdate[],
  ): Promise<AftercareClaim | null> {
    return this.prisma.$transaction(async (tx) => {
      const head = await tx.aftercareClaimRecord.findFirst({
        where: { tenantId: tenant, id: claimId },
      });
      if (head === null || head.objectVersion !== expectedObjectVersion) return null;

      const lines = await tx.aftercareClaimLineRecord.findMany({
        where: { tenantId: tenant, claimId },
        orderBy: { lineNo: 'asc' },
      });
      const byReport = new Map(lines.map((line) => [line.reportId, line] as const));
      if (updates.length !== lines.length || updates.some((u) => !byReport.has(u.reportId))) {
        throw new DispatchConflictError(
          `报销单 '${claimId}' 费用重写与既有行集不一一对应（updates=${updates.length}，行=${lines.length}）`,
        );
      }

      const now = new Date();
      for (const update of updates) {
        await tx.aftercareClaimLineRecord.updateMany({
          where: { tenantId: tenant, id: byReport.get(update.reportId)!.id },
          data: {
            lodgingMinor: update.lodgingMinor,
            trafficMinor: update.trafficMinor,
            overtimeMinor: update.overtimeMinor,
            otherMinor: update.otherMinor,
            remark: update.remark,
            updatedAt: now,
          },
        });
      }
      const advanced = await tx.aftercareClaimRecord.updateMany({
        where: { tenantId: tenant, id: claimId, objectVersion: expectedObjectVersion },
        data: { objectVersion: expectedObjectVersion + 1, updatedAt: now },
      });
      if (advanced.count === 0) return null; // 并发窗口：版本在他事务推进——乐观拒绝

      const nextHead = await tx.aftercareClaimRecord.findFirstOrThrow({
        where: { tenantId: tenant, id: claimId },
      });
      const nextLines = await tx.aftercareClaimLineRecord.findMany({
        where: { tenantId: tenant, claimId },
        orderBy: { lineNo: 'asc' },
      });
      return toAftercareClaim(nextHead, nextLines);
    });
  }
}
