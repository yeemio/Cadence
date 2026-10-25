/**
 * 售后报销存储端口的内存先行实现（U5 A12）。重启即失；PG 实现在
 * business-store（src/dispatch/pg-aftercare-claim-stores.ts，`./dispatch`
 * 子路径）。体例同 in-memory-dispatch-stores：读按租户收口，create 冲突 /
 * updateFees 乐观检查与 PG 实现同一合同。
 */
import { TenantId, type UserId } from '@smes/business-core';
import { DispatchConflictError } from './dispatch-errors.js';
import type {
  AftercareClaim,
  AftercareClaimFeeUpdate,
  AftercareClaimLine,
  AftercareClaimStore,
  CreateAftercareClaimInput,
} from './aftercare-claim-stores.js';

interface ClaimRow {
  readonly tenant: string;
  readonly id: string;
  readonly dispatchId: string;
  objectVersion: number;
  readonly createdAt: string;
  updatedAt: string;
  lines: LineRow[];
}

interface LineRow {
  readonly tenant: string;
  readonly id: string;
  readonly claimId: string;
  lineNo: number;
  readonly reportId: string;
  readonly reportDate: string;
  readonly worker: UserId;
  readonly approvedBy: UserId | null;
  readonly approvedMinutes: number;
  lodgingMinor: number;
  trafficMinor: number;
  overtimeMinor: number;
  otherMinor: number;
  remark: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toLine(row: LineRow): AftercareClaimLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    claimId: row.claimId,
    lineNo: row.lineNo,
    reportId: row.reportId,
    reportDate: row.reportDate,
    worker: row.worker,
    approvedBy: row.approvedBy,
    approvedMinutes: row.approvedMinutes,
    lodgingMinor: row.lodgingMinor,
    trafficMinor: row.trafficMinor,
    overtimeMinor: row.overtimeMinor,
    otherMinor: row.otherMinor,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toClaim(row: ClaimRow): AftercareClaim {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    dispatchId: row.dispatchId,
    objectVersion: row.objectVersion,
    lines: [...row.lines].sort((a, b) => a.lineNo - b.lineNo).map(toLine),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryAftercareClaimStore implements AftercareClaimStore {
  private readonly rows = new Map<string, ClaimRow>(); // key: `${tenant}|${claimId}`

  async create(input: CreateAftercareClaimInput): Promise<AftercareClaim> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new DispatchConflictError(`报销单 '${input.id}' 已存在`);
    }
    const duplicate = [...this.rows.values()].some(
      (row) => row.tenant === input.tenant && row.dispatchId === input.dispatchId,
    );
    if (duplicate) {
      throw new DispatchConflictError(
        `派工单 '${input.dispatchId}' 已存在报销记录，请直接编辑（一单一报销）`,
      );
    }
    if (input.lines.length === 0) {
      throw new DispatchConflictError('报销单明细行集不可为空（须有审批通过报工才有行）');
    }
    const now = new Date().toISOString();
    const reportIds = new Set<string>();
    const lines: LineRow[] = input.lines.map((line, index) => {
      if (reportIds.has(line.reportId)) {
        throw new DispatchConflictError(`报销行明细键重复：reportId '${line.reportId}'`);
      }
      reportIds.add(line.reportId);
      return {
        tenant: input.tenant,
        id: line.id,
        claimId: input.id,
        lineNo: index + 1,
        reportId: line.reportId,
        reportDate: line.reportDate,
        worker: line.worker,
        approvedBy: line.approvedBy,
        approvedMinutes: line.approvedMinutes,
        lodgingMinor: line.lodgingMinor,
        trafficMinor: line.trafficMinor,
        overtimeMinor: line.overtimeMinor,
        otherMinor: line.otherMinor,
        remark: line.remark,
        createdAt: now,
        updatedAt: now,
      };
    });
    const row: ClaimRow = {
      tenant: input.tenant,
      id: input.id,
      dispatchId: input.dispatchId,
      objectVersion: 1,
      createdAt: now,
      updatedAt: now,
      lines,
    };
    this.rows.set(key, row);
    return toClaim(row);
  }

  async find(tenant: TenantId, id: string): Promise<AftercareClaim | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toClaim(row);
  }

  async findByDispatch(tenant: TenantId, dispatchId: string): Promise<AftercareClaim | null> {
    for (const row of this.rows.values()) {
      if (row.tenant === tenant && row.dispatchId === dispatchId) return toClaim(row);
    }
    return null;
  }

  async updateFees(
    tenant: TenantId,
    claimId: string,
    expectedObjectVersion: number,
    updates: readonly AftercareClaimFeeUpdate[],
  ): Promise<AftercareClaim | null> {
    const row = this.rows.get(`${tenant}|${claimId}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    const byReport = new Map(row.lines.map((line) => [line.reportId, line] as const));
    if (updates.length !== row.lines.length || updates.some((u) => !byReport.has(u.reportId))) {
      throw new DispatchConflictError(
        `报销单 '${claimId}' 费用重写与既有行集不一一对应（updates=${updates.length}，行=${row.lines.length}）`,
      );
    }
    const now = new Date().toISOString();
    for (const update of updates) {
      const line = byReport.get(update.reportId)!;
      line.lodgingMinor = update.lodgingMinor;
      line.trafficMinor = update.trafficMinor;
      line.overtimeMinor = update.overtimeMinor;
      line.otherMinor = update.otherMinor;
      line.remark = update.remark;
      line.updatedAt = now;
    }
    row.objectVersion = expectedObjectVersion + 1;
    row.updatedAt = now;
    return toClaim(row);
  }
}
