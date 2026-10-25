/**
 * listing 工序×原材料关联存储端口的内存先行实现（U4）。
 *
 * 重启即失；PG 实现在 business-store `./listing` 子路径（总控合流接线）。
 * 体例同 in-memory-listing-stores：全部读按租户收口；replaceSet 原子整表
 * 替换（删旧行 + 按数组序插新行）；同工序 (sortOrder / rawMaterialId)
 * 唯一性守恒（跨清单行复用同一工序引用亦拒——与 PG (tenant, processId)
 * 组 UNIQUE 同口径）。
 */
import { TenantId } from '@smes/business-core';
import { ListingConflictError } from './listing-errors.js';
import type {
  ProcessMaterialLink,
  ProcessMaterialLinkStore,
  ReplaceProcessMaterialSetInput,
} from './process-material-stores.js';

interface LinkRow {
  readonly tenant: string;
  readonly id: string;
  listingLineId: string;
  readonly processId: string;
  sortOrder: number;
  readonly rawMaterialId: string;
  readonly quantity: number;
  unitPriceMinor: number | null;
  readonly measureType: ProcessMaterialLink['measureType'];
  readonly partLength: number;
  partWidth: number | null;
  partHeight: number | null;
  readonly cutSizeForm: ProcessMaterialLink['cutSizeForm'];
  readonly cutSizeUnit: ProcessMaterialLink['cutSizeUnit'];
  readonly createdAt: string;
  updatedAt: string;
}

function toLink(row: LinkRow): ProcessMaterialLink {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    listingLineId: row.listingLineId,
    processId: row.processId,
    sortOrder: row.sortOrder,
    rawMaterialId: row.rawMaterialId,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    measureType: row.measureType,
    partLength: row.partLength,
    partWidth: row.partWidth,
    partHeight: row.partHeight,
    cutSizeForm: row.cutSizeForm,
    cutSizeUnit: row.cutSizeUnit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryProcessMaterialLinkStore implements ProcessMaterialLinkStore {
  private readonly rows = new Map<string, LinkRow>(); // key: `${tenant}|${id}`

  async replaceSet(input: ReplaceProcessMaterialSetInput): Promise<readonly ProcessMaterialLink[]> {
    // 归属/唯一预检（PG 侧由 (tenant, processId, sortOrder|rawMaterialId) UNIQUE 兜底）：
    // ① 同工序引用不得挂在其他清单行；② 行集内 rawMaterialId 不重复（输入层已
    // 拒，此处守恒存储面直接调用）；③ id 不与现存行冲突。
    for (const row of this.rows.values()) {
      if (
        row.tenant === input.tenant &&
        row.processId === input.processId &&
        row.listingLineId !== input.listingLineId
      ) {
        throw new ListingConflictError(
          `工序引用 '${input.processId}' 已挂在零件清单行 '${row.listingLineId}'（一个工序引用只允许挂一个清单行）`,
        );
      }
    }
    const seen = new Set<string>();
    for (const row of input.rows) {
      if (this.rows.has(`${input.tenant}|${row.id}`)) {
        throw new ListingConflictError(`工序原材料关联行 '${row.id}' 已存在`);
      }
      if (seen.has(row.rawMaterialId)) {
        throw new ListingConflictError(
          `工序 '${input.processId}' 原材料 '${row.rawMaterialId}' 重复（同工序原材料不可重复）`,
        );
      }
      seen.add(row.rawMaterialId);
    }
    // 删旧插新（整表替换；同事务性由调用链单线程+原子替换语义承载）。
    for (const [key, row] of [...this.rows.entries()]) {
      if (
        row.tenant === input.tenant &&
        row.listingLineId === input.listingLineId &&
        row.processId === input.processId
      ) {
        this.rows.delete(key);
      }
    }
    const now = new Date().toISOString();
    const inserted: ProcessMaterialLink[] = [];
    for (const [sortOrder, row] of input.rows.entries()) {
      const linkRow: LinkRow = {
        tenant: input.tenant,
        id: row.id,
        listingLineId: input.listingLineId,
        processId: input.processId,
        sortOrder,
        rawMaterialId: row.rawMaterialId,
        quantity: row.quantity,
        unitPriceMinor: row.unitPriceMinor,
        measureType: row.measureType,
        partLength: row.partLength,
        partWidth: row.partWidth,
        partHeight: row.partHeight,
        cutSizeForm: row.cutSizeForm,
        cutSizeUnit: row.cutSizeUnit,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(`${input.tenant}|${row.id}`, linkRow);
      inserted.push(toLink(linkRow));
    }
    return inserted;
  }

  async listByProcess(
    tenant: TenantId,
    listingLineId: string,
    processId: string,
  ): Promise<readonly ProcessMaterialLink[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant && row.listingLineId === listingLineId && row.processId === processId,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toLink);
  }

  async listByLine(tenant: TenantId, listingLineId: string): Promise<readonly ProcessMaterialLink[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.listingLineId === listingLineId)
      .sort((a, b) => a.processId.localeCompare(b.processId) || a.sortOrder - b.sortOrder)
      .map(toLink);
  }

  async findByProcessId(tenant: TenantId, processId: string): Promise<readonly ProcessMaterialLink[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.processId === processId)
      .sort((a, b) => a.listingLineId.localeCompare(b.listingLineId) || a.sortOrder - b.sortOrder)
      .map(toLink);
  }
}
