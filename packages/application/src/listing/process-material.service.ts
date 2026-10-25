/**
 * ProcessMaterialService —— 工序×原材料关联用例编排（U4，S10 数据面）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令走 smes.command.v1 CommandEnvelope
 * （operationId 幂等）；整表替换是唯一写面（原文 §三、8「整表覆盖写入」——
 * 有选料按序写 N 行、空行集显式清空），无状态机故无机器事件账本。
 *
 * 命令面一个：listing.process-material.replace.v1（expectedRevision 恒
 * 'initial'——每次整表替换都是新操作，重放幂等由 operationId 承担；并发整表
 * 替换后写胜出，与原文 Java 覆盖写口径一致）。
 *
 * 门禁取舍（写明）：原文「该下料/激光工序已派工时不改关联行」「仅激光空列表
 * 不覆盖」依赖工序行派工态与下单编排——listing 域工序面尚未落库，本波不接
 * （接线波落工序面后由调用方在编排层把门；本服务只守数据面不变量）。
 * 数据面不变量三件：① 挂零件清单行（kind='part'，不存在/他类目拒）；
 * ② 工序引用归属唯一（同 processId 已挂其他清单行拒）；③ 同工序原材料不
 * 重复（输入层 + 存储/DB 唯一守恒）。
 */
import {
  EventId,
  type CommandEnvelope,
  type CommittedOutcome,
  type RejectedOutcome,
  type TenantId,
} from '@smes/business-core';
import { ListingInputError } from './listing-errors.js';
import type { ListingLineStore } from './listing-stores.js';
import type { ListingDomainEventStore, ListingOperationStore } from './listing-stores.js';
import {
  PROCESS_MATERIAL_AGGREGATE_TYPE,
  makeProcessMaterialReplacedEvent,
} from './process-material-events.js';
import {
  parseProcessMaterialReplacePayload,
  type ProcessMaterialCommand,
} from './process-material-input.js';
import { newProcessMaterialLinkId } from './process-material-ids.js';
import { newDomainEventId } from './listing-ids.js';
import type {
  ProcessMaterialLink,
  ProcessMaterialLinkStore,
} from './process-material-stores.js';

// ---- 结果形状 ----

export interface ProcessMaterialCommitted extends CommittedOutcome {
  /** 替换后的整行集（空行集 = 空）。 */
  readonly rows: readonly ProcessMaterialLink[];
}

export type ProcessMaterialCommandResult = ProcessMaterialCommitted | RejectedOutcome;

export interface ProcessMaterialServiceOptions {
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

export class ProcessMaterialService {
  private readonly options: ProcessMaterialServiceOptions;

  constructor(
    private readonly materials: ProcessMaterialLinkStore,
    private readonly lines: ListingLineStore,
    private readonly operations: ListingOperationStore,
    private readonly domainEvents: ListingDomainEventStore,
    options: ProcessMaterialServiceOptions = {},
  ) {
    this.options = options;
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(envelope: CommandEnvelope<ProcessMaterialCommand>): Promise<ProcessMaterialCommandResult> {
    const kind = envelope.command.kind;
    if (kind !== 'listing.process-material.replace.v1') {
      throw new ListingInputError(
        `命令 ${kind} 不属于工序×原材料关联命令面（本服务只接受 listing.process-material.replace.v1）`,
      );
    }
    if (envelope.expectedRevision !== 'initial') {
      return rejected(
        `命令 ${kind} 是整表替换操作（无对象版本锚）：expectedRevision 须为 'initial'，幂等由 operationId 承担`,
      );
    }
    return this.replaceSet(envelope);
  }

  private async replaceSet(envelope: CommandEnvelope<ProcessMaterialCommand>): Promise<ProcessMaterialCommandResult> {
    const payload = parseProcessMaterialReplacePayload(envelope.command.payload);
    const tenant = envelope.tenantId;

    // ① 归属锚：零件清单行须存在且为零件类目（kind='part'）。
    const line = await this.lines.find(tenant, payload.listingLineId);
    if (line === null) {
      return rejected(`零件清单行 '${payload.listingLineId}' 不存在（工序×原材料关联须挂零件清单行）`);
    }
    if (line.kind !== 'part') {
      return rejected(
        `清单行 '${payload.listingLineId}' 类目为 ${line.kind}：原材料关联仅挂零件清单（kind='part'）行`,
      );
    }

    // ② 工序引用归属唯一：同 processId 已挂其他清单行即拒（防跨行漂移）。
    const existing = await this.materials.findByProcessId(tenant, payload.processId);
    const stray = existing.find((row) => row.listingLineId !== payload.listingLineId);
    if (stray !== undefined) {
      return rejected(
        `工序引用 '${payload.processId}' 已挂在零件清单行 '${stray.listingLineId}'（一个工序引用只允许挂一个清单行）`,
      );
    }

    // ③ 幂等记账（成功提交前 record：已落账 → 拒绝重复执行）。
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: PROCESS_MATERIAL_AGGREGATE_TYPE,
      aggregateId: payload.processId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const rows = await this.materials.replaceSet({
      tenant,
      listingLineId: payload.listingLineId,
      processId: payload.processId,
      rows: payload.materials.map((row) => ({ id: newProcessMaterialLinkId(), ...row })),
    });
    const event = makeProcessMaterialReplacedEvent(
      {
        eventId: EventId.create(newDomainEventId()), // evt-<uuidv7>（与 listing 命令族同一事件 id 口径）
        tenant,
        occurredAt: this.now(),
        provenance: {
          operationId: envelope.operationId,
          command: envelope.command.kind,
          actor: envelope.issuedBy,
        },
      },
      {
        listingLineId: payload.listingLineId,
        processId: payload.processId,
        previousCount: existing.length,
        replacedCount: rows.length,
        actor: envelope.issuedBy,
      },
    );
    await this.domainEvents.append(event);

    return { status: 'committed', newRevision: rows.length, events: [event], rows };
  }

  // ---- 查询面（下单弹窗回填 / A5 项目成本取数源） ----

  /** 单工序关联行集（sortOrder 升序；原文 materialList 回填口径）。 */
  async listByProcess(
    tenant: TenantId,
    listingLineId: string,
    processId: string,
  ): Promise<readonly ProcessMaterialLink[]> {
    return this.materials.listByProcess(tenant, listingLineId, processId);
  }

  /** 清单行全工序关联行集（processId → sortOrder 稳定序；成本/发料聚合读）。 */
  async listByLine(tenant: TenantId, listingLineId: string): Promise<readonly ProcessMaterialLink[]> {
    return this.materials.listByLine(tenant, listingLineId);
  }
}
