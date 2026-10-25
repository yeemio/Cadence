/**
 * InMemoryApprovalCaseStore —— 审批案件端口先行实现（M1 收尾波-①）。
 *
 * 重启即失；PG 实现在 business-store（`./approval` 子路径）。与
 * InMemoryTodoStore 同一形态：无 DATABASE_URL / 未注入存储时组合根回落
 * 到这里，保证零 DB boot 语义完整。全部读操作按租户收口；advance 带
 * 乐观版本检查（与 PG 实现同一合同）。
 */
import { TenantId, UserId } from '@smes/business-core';
import { ApprovalConflictError } from './approval-errors.js';
import type {
  ApprovalCase,
  ApprovalCaseStore,
  CreateApprovalCaseInput,
  ListApprovalCasesFilter,
} from './approval-stores.js';

interface CaseRow {
  readonly tenant: string;
  readonly id: string;
  flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly submitter: string;
  readonly createdAt: string;
}

function toCase(row: CaseRow): ApprovalCase {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    subjectRef: { type: row.subjectType, id: row.subjectId },
    submitter: UserId.create(row.submitter),
    createdAt: row.createdAt,
  };
}

export class InMemoryApprovalCaseStore implements ApprovalCaseStore {
  private readonly cases = new Map<string, CaseRow>(); // key: `${tenant}|${id}`

  async create(input: CreateApprovalCaseInput): Promise<ApprovalCase> {
    const key = `${input.tenant}|${input.id}`;
    if (this.cases.has(key)) {
      throw new ApprovalConflictError(`案件 '${input.id}' 已存在`);
    }
    const row: CaseRow = {
      tenant: input.tenant,
      id: input.id,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      subjectType: input.subjectRef.type,
      subjectId: input.subjectRef.id,
      submitter: input.submitter,
      createdAt: new Date().toISOString(),
    };
    this.cases.set(key, row);
    return toCase(row);
  }

  async find(tenant: TenantId, id: string): Promise<ApprovalCase | null> {
    const row = this.cases.get(`${tenant}|${id}`);
    return row === undefined ? null : toCase(row);
  }

  async list(
    tenant: TenantId,
    filter?: ListApprovalCasesFilter,
  ): Promise<readonly ApprovalCase[]> {
    return [...this.cases.values()]
      .filter(
        (row) =>
          row.tenant === tenant && (filter?.state === undefined || row.state === filter.state),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toCase);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<ApprovalCase> {
    const row = this.cases.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new ApprovalConflictError(
        `案件 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    return toCase(row);
  }
}
