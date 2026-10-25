/**
 * InventoryService —— 库存环节用例编排（M2-W5，07-inventory.md v1.0）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分。七件事：
 *
 * 1. 主数据：warehouse.define 建仓库+库位（R4：主数据归本模块；第一个
 *    库位 = 默认库位）；
 * 2. 三类入库 stock.receive：质检放行（InspectionRelease 咬合——放行登记
 *    Σ − 已入 ≥ 本次才放行）/ 采购收货（receiptKey 幂等去重）/ 完工入库；
 * 3. 出库 stock.issue：预占核销（reservationKey）或直扣可用量——负库存
 *    策略默认硬拒绝（合同 §8，服务选项配置化）；
 * 4. 调拨/移库 stock.transfer：跨仓双流水 + 仓内移库换位（台账恒等：
 *    Σ库位余额 = 仓库现存量）；
 * 5. 盘点 stocktake.open/record/approve-adjust：实盘-审核-调账三段（四态机
 *    经 engine-flow 驱动）；调账把账面校到实盘（movement=实盘−当前账面；
 *    审计差异=实盘−开单快照），StocktakeAdjusted 留痕；
 * 6. 发货 shipping.execute/confirm：执行即出库（行级预占核销）、确认发
 *    ShippingConfirmed（→workorder 待发货→已发货联动锚点）；
 * 7. 预占端口 reserve/release：派工/发料创建即预占、出库核销、未用释放
 *    ——可用量恒等式（可用量=总量−预占）全程机器校验。
 *
 * 落账顺序（与 workorder/listing 同取舍）：幂等记账（口径统一：载荷解析与
 * 业务校验通过后、首个持久写之前落 operationId——被拒不占用 id，同 id 修正
 * 重发可重新评估；receive/issue 的深校验提取为 validate*Stock 与
 * transfer/stocktake/approve 原有次序对齐）→ 机器事件账本 → 投影
 * 乐观推进 → 域事件发布（BusinessEvent + Outbox）。建单类命令（盘点开单/
 * 发货执行）先落初始态投影行（draft@v1 无机器事件）再驱动首次迁移——投影
 * 行先在是机器事件 append 的前置（PG 账本按投影行解析租户，孤儿聚合拒写）。
 */
import {
  EventId,
  OperationId,
  UserId,
  makeCommandEnvelope,
  type BusinessEvent,
  type CommandEnvelope,
  type CommittedOutcome,
  type IndeterminateOutcome,
  type RejectedOutcome,
  type TenantId,
} from '@smes/business-core';
import {
  startApprovalFlow,
  type ApprovalEvent,
  type ApprovalEventStore,
  type ApprovalFlowConfig,
  type ApprovalFlowRuntime,
} from '@smes/engine-flow';
import {
  DEFAULT_NEGATIVE_STOCK_POLICY,
  DEFAULT_SHIPPING_FLOW_CONFIG,
  DEFAULT_STOCKTAKE_FLOW_CONFIG,
  type NegativeStockPolicy,
  type ReceiptSourceKind,
  type StockMovementKind,
} from './inventory-config.js';
import {
  SHIPPING_ORDER_AGGREGATE_TYPE,
  STOCKTAKE_AGGREGATE_TYPE,
  makeShippingConfirmedEvent,
  makeStockIssuedEvent,
  makeStockReceivedEvent,
  makeStockTransferredEvent,
  makeStocktakeAdjustedEvent,
  provenanceOf,
  type InventoryEventProvenance,
  type StocktakeAdjustedPayload,
} from './inventory-events.js';
import {
  InventoryInputError,
  InventoryNotFoundError,
  InventoryStateError,
} from './inventory-errors.js';
import {
  parseShippingConfirmPayload,
  parseShippingExecutePayload,
  parseStockIssuePayload,
  parseStockReceivePayload,
  parseStockTransferPayload,
  parseStocktakeApprovePayload,
  parseStocktakeOpenPayload,
  parseStocktakeRecordPayload,
  parseWarehouseDefinePayload,
  type InventoryCommand,
  type InventoryCommandKind,
} from './inventory-input.js';
import type {
  InventoryDomainEventStore,
  InventoryOperationStore,
  ListLocationBalancesFilter,
  ListStockAccountsFilter,
  ListStockMovementsFilter,
  ReleaseFactStore,
  ShippingLine,
  ShippingOrder,
  ShippingOrderStore,
  StockAccountStore,
  StockAdjustLine,
  StockLocationBalanceStore,
  StockMovement,
  StockMovementStore,
  StockReservationStore,
  Stocktake,
  StocktakeLine,
  StocktakeStore,
  Warehouse,
  WarehouseStore,
} from './inventory-stores.js';
import {
  newDomainEventId,
  newLocationId,
  newShippingOrderId,
  newStockMovementId,
  newStocktakeId,
  newTransferId,
  newWarehouseId,
  uuidv7,
} from './inventory-ids.js';

// ---- 结果形状 ----

/** 实时库存视图行（可用量口径：available = qtyOnHand − qtyReserved）。 */
export interface StockLevelView {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly availableQty: number;
}

export interface InventoryCommitted extends CommittedOutcome {
  readonly warehouse?: Warehouse;
  readonly movement?: StockMovement;
  readonly movements?: readonly StockMovement[];
  /** receiptKey/issueKey 幂等命中（不重复入账，回执首次结果）。 */
  readonly duplicate?: boolean;
  readonly stocktake?: Stocktake;
  readonly shippingOrder?: ShippingOrder;
  readonly stockLevel?: StockLevelView;
}

export type InventoryCommandResult = InventoryCommitted | RejectedOutcome | IndeterminateOutcome;

/** 收货统一入账输入（stock.receive 命令面与 receivePurchaseStock 端口面共用形状）。 */
interface ReceiveStockInput {
  readonly kind: ReceiptSourceKind;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  readonly inspectionId: string | null;
  readonly purchaseOrderId: string | null;
  readonly workOrderId: string | null;
  readonly receiptKey: string | null;
  readonly remark: string | null;
}

/** 出库统一入账输入（stock.issue 命令面 / shipping 行 / issuePartsStock 端口面共用形状）。 */
interface IssueStockInput {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  readonly purpose: string;
  readonly movementKind: 'issue-out' | 'shipping-out';
  readonly workOrderId: string | null;
  readonly reservationKey: string | null;
  readonly issueKey: string | null;
  readonly shipmentId: string | null;
  readonly sourceRefType: string | null;
  readonly sourceRefId: string | null;
  readonly remark: string | null;
}

export interface InventoryServiceOptions {
  /** 盘点四态配置（缺省 DEFAULT_STOCKTAKE_FLOW_CONFIG；整体替换 = 换合法集）。 */
  readonly stocktakeConfig: ApprovalFlowConfig;
  /** 发货三态配置（缺省 DEFAULT_SHIPPING_FLOW_CONFIG）。 */
  readonly shippingConfig: ApprovalFlowConfig;
  /** 负库存策略（合同 §8 配置化；缺省硬拒绝）。 */
  readonly negativeStockPolicy: NegativeStockPolicy;
  /** 默认仓（收货/配件出库/发货行未带仓时的落位；null = 必须显式给仓）。 */
  readonly defaultWarehouseId: string | null;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

export class InventoryService {
  private readonly options: InventoryServiceOptions;

  constructor(
    private readonly warehouses: WarehouseStore,
    private readonly accounts: StockAccountStore,
    private readonly balances: StockLocationBalanceStore,
    private readonly movements: StockMovementStore,
    private readonly reservations: StockReservationStore,
    private readonly stocktakes: StocktakeStore,
    private readonly shippings: ShippingOrderStore,
    private readonly releaseFacts: ReleaseFactStore,
    private readonly operations: InventoryOperationStore,
    private readonly domainEvents: InventoryDomainEventStore,
    private readonly machineEvents: ApprovalEventStore,
    options: Partial<InventoryServiceOptions> = {},
  ) {
    this.options = {
      stocktakeConfig: options.stocktakeConfig ?? DEFAULT_STOCKTAKE_FLOW_CONFIG,
      shippingConfig: options.shippingConfig ?? DEFAULT_SHIPPING_FLOW_CONFIG,
      negativeStockPolicy: options.negativeStockPolicy ?? DEFAULT_NEGATIVE_STOCK_POLICY,
      defaultWarehouseId: options.defaultWarehouseId ?? null,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  private get allowNegative(): boolean {
    return this.options.negativeStockPolicy === 'allow';
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(
    envelope: CommandEnvelope<InventoryCommand>,
    pathId?: string,
  ): Promise<InventoryCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly InventoryCommandKind[] = [
      'warehouse.define.v1',
      'stock.receive.v1',
      'stock.issue.v1',
      'stock.transfer.v1',
      'stocktake.open.v1',
      'shipping.execute.v1',
    ];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'warehouse.define.v1':
        return this.defineWarehouse(envelope);
      case 'stock.receive.v1':
        return this.receive(envelope);
      case 'stock.issue.v1':
        return this.issue(envelope);
      case 'stock.transfer.v1':
        return this.transfer(envelope);
      case 'stocktake.open.v1':
        return this.openStocktake(envelope);
      case 'stocktake.record.v1':
        return this.recordStocktake(envelope, this.requirePathId(pathId, kind));
      case 'stocktake.approve-adjust.v1':
        return this.approveAdjust(envelope, this.requirePathId(pathId, kind));
      case 'shipping.execute.v1':
        return this.executeShipping(envelope);
      case 'shipping.confirm.v1':
        return this.confirmShipping(envelope, this.requirePathId(pathId, kind));
    }
  }

  private requirePathId(pathId: string | undefined, kind: InventoryCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new InventoryInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- warehouse.define ----

  private async defineWarehouse(
    envelope: CommandEnvelope<InventoryCommand>,
  ): Promise<InventoryCommandResult> {
    const payload = parseWarehouseDefinePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const duplicate = await this.warehouses.findByCode(tenant, payload.code);
    if (duplicate !== null) {
      return rejected(`仓库编码 '${payload.code}' 已存在（${duplicate.id}）`);
    }

    const warehouseId = newWarehouseId();
    const locationIds = payload.locations.map(() => newLocationId());
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: 'warehouse',
      aggregateId: warehouseId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const created = await this.warehouses.create({
      tenant,
      id: warehouseId,
      code: payload.code,
      name: payload.name,
      defaultLocationId: locationIds[0] as string,
      locations: payload.locations.map((location, index) => ({
        id: locationIds[index] as string,
        code: location.code,
        name: location.name,
      })),
    });
    // 主数据无状态机/无域事件（合同事件面最小集 5 个不含仓库定义——投影事实
    // 由投影行承载，流水/事件从首笔收发存开始）。
    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      warehouse: created,
    };
  }

  // ---- stock.receive（三类入库；放行咬合 + receiptKey 幂等） ----

  private async receive(envelope: CommandEnvelope<InventoryCommand>): Promise<InventoryCommandResult> {
    const payload = parseStockReceivePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const input: ReceiveStockInput = {
      kind: payload.kind,
      itemId: payload.itemId,
      warehouseId: payload.warehouseId,
      locationId: payload.locationId,
      quantity: payload.quantity,
      inspectionId: payload.inspectionId,
      purchaseOrderId: payload.purchaseOrderId,
      workOrderId: payload.workOrderId,
      receiptKey: payload.receiptKey,
      remark: payload.remark,
    };

    // sourceKey（receiptKey）幂等先于深校验与记账：命中即回首次结果——重发
    // 指令不因库存已变被误拒（Wave-2 低危 #4 契约保持）；不落新账、不占用
    // 新 operationId。
    const dedup = await this.duplicateOutcomeOf(tenant, input.receiptKey);
    if (dedup !== null) return dedup;

    // 先解析校验后记账（口径统一，与 transfer/stocktake/approve 对齐）：深校验
    // （仓库/库位/放行咬合）通过后才落 operationId——被拒不占用 id，同 id 修正
    // 载荷重发可重新评估（committed 后同 id 重发若前置状态已变则按状态拒）。
    const checked = await this.validateReceiveStock(tenant, input);
    if ('status' in checked) return checked;

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: 'stock-movement',
      aggregateId: 'receive',
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    return this.receiveStock(envelope, input);
  }

  /** sourceKey（receiptKey/issueKey）幂等命中 → 回首次结果的 committed 回执（duplicate=true，无新事件）。 */
  private async duplicateOutcomeOf(tenant: TenantId, sourceKey: string | null): Promise<InventoryCommandResult | null> {
    if (sourceKey === null) return null;
    const existing = await this.movements.findBySourceKey(tenant, sourceKey);
    if (existing === null) return null;
    const account = await this.accounts.find(tenant, existing.itemId, existing.warehouseId);
    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      movement: existing,
      duplicate: true,
      stockLevel: this.levelOf(existing.itemId, existing.warehouseId, account),
    };
  }

  /**
   * 收货深校验（stock.receive 命令面 pre-record 前置 + receiveStock 复用）：
   * 仓库存在、库位存在、放行咬合（inspection 来源）。返回 null = 通过并给出
   * 落位库位；否则拒绝回执。纯读校验（无落账副作用），重跑结果一致。
   */
  private async validateReceiveStock(
    tenant: TenantId,
    input: ReceiveStockInput,
  ): Promise<RejectedOutcome | { readonly locationId: string }> {
    const warehouse = await this.warehouses.find(tenant, input.warehouseId);
    if (warehouse === null) {
      return rejected(`租户 '${tenant}' 内不存在仓库 '${input.warehouseId}'`);
    }
    const locationId = input.locationId ?? warehouse.defaultLocationId;
    if (await this.warehouses.findLocation(tenant, input.warehouseId, locationId) === null) {
      return rejected(`仓库 '${input.warehouseId}' 内不存在库位 '${locationId}'`);
    }

    // 放行咬合（inspection 来源）：放行登记总量 − 已入量 ≥ 本次。
    if (input.kind === 'inspection') {
      const inspectionId = input.inspectionId as string;
      const facts = await this.releaseFacts.listByInspection(tenant, inspectionId);
      if (facts.length === 0) {
        return rejected(
          `质检单 '${inspectionId}' 无放行事实（inspection 来源入库须先经放行——放行事实由 StockReleasePort 登记）`,
        );
      }
      const releasedTotal = facts.reduce((sum, fact) => sum + fact.quantity, 0);
      const receivedRows = await this.movements.list(tenant, {
        itemId: input.itemId,
        kind: 'inspection-in',
        sourceRefId: inspectionId,
      });
      const receivedTotal = receivedRows.reduce((sum, row) => sum + row.quantity, 0);
      if (input.quantity > releasedTotal - receivedTotal) {
        return rejected(
          `放行余量不足：质检单 '${inspectionId}' 放行 ${releasedTotal} − 已入 ${receivedTotal} = ${releasedTotal - receivedTotal} < 本次 ${input.quantity}`,
        );
      }
      const mismatched = facts.some((fact) => fact.itemId !== null && fact.itemId !== input.itemId);
      if (mismatched) {
        return rejected(`质检单 '${inspectionId}' 放行事实的物料与入库物料不符（放行 itemId 锚点不匹配）`);
      }
    }
    return { locationId };
  }

  /**
   * 三类入库统一入账（命令面与 receivePurchaseStock 端口面共用）。
   *
   * 幂等：receiptKey（sourceKey）命中既有流水 → 不重复入账，幂等返回首次
   * 结果（duplicate=true，无新事件——Wave-2 验收低危 #4 兑现点）。
   * 放行咬合（kind=inspection）：放行登记 Σ − 已入 ≥ 本次，否则拒绝
   * （07-inventory.md Done-when：三类入库需质检放行才可执行）。
   */
  private async receiveStock(
    envelope: CommandEnvelope<InventoryCommand>,
    input: ReceiveStockInput,
  ): Promise<InventoryCommandResult> {
    const tenant = envelope.tenantId;
    const movementKind = `${input.kind}-in` as StockMovementKind;

    // receiptKey 幂等去重：命中即回首次结果（不重复入账）。
    const dedup = await this.duplicateOutcomeOf(tenant, input.receiptKey);
    if (dedup !== null) return dedup;

    const checked = await this.validateReceiveStock(tenant, input);
    if ('status' in checked) return checked;
    const locationId = checked.locationId;

    const movementId = newStockMovementId();
    const occurredAt = this.now();
    const { movement } = await this.movements.append({
      tenant,
      id: movementId,
      kind: movementKind,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      locationId,
      quantity: input.quantity,
      sourceRefType:
        input.kind === 'inspection' ? 'inspection' : input.kind === 'purchase' ? 'purchase-order' : 'work-order',
      sourceRefId:
        input.kind === 'inspection'
          ? input.inspectionId
          : input.kind === 'purchase'
            ? input.purchaseOrderId
            : input.workOrderId,
      sourceKey: input.receiptKey,
      transferId: null,
      workOrderId: input.workOrderId,
      remark: input.remark,
      occurredAt,
      recordedBy: envelope.issuedBy,
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    });
    const account = await this.accounts.adjust(
      tenant,
      input.itemId,
      input.warehouseId,
      input.quantity,
      0,
    );
    await this.balances.adjust(tenant, input.warehouseId, locationId, input.itemId, input.quantity);

    const event = makeStockReceivedEvent(
      this.domainEventBase(envelope),
      {
        movementKind: movementKind as Extract<StockMovementKind, `${string}-in`>,
        source: input.kind,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        locationId,
        quantity: input.quantity,
        workOrderId: input.workOrderId,
        sourceRefId:
          input.kind === 'inspection'
            ? input.inspectionId
            : input.kind === 'purchase'
              ? input.purchaseOrderId
              : input.workOrderId,
        receiptKey: input.receiptKey,
        duplicate: false,
        qtyOnHand: account.qtyOnHand,
        qtyReserved: account.qtyReserved,
        actor: envelope.issuedBy,
      },
      movementId,
    );
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1, // 入库是新流水事实组，不推进任何状态机版本（无状态机）
      events: [event],
      movement,
      stockLevel: this.levelOf(input.itemId, input.warehouseId, account),
    };
  }

  // ---- stock.issue（出库：核销预占 or 直扣可用量） ----

  private async issue(envelope: CommandEnvelope<InventoryCommand>): Promise<InventoryCommandResult> {
    const payload = parseStockIssuePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const input: IssueStockInput = {
      itemId: payload.itemId,
      warehouseId: payload.warehouseId,
      locationId: payload.locationId,
      quantity: payload.quantity,
      purpose: payload.purpose,
      movementKind: 'issue-out',
      workOrderId: payload.workOrderId,
      reservationKey: payload.reservationKey,
      issueKey: payload.issueKey,
      shipmentId: null,
      sourceRefType: null,
      sourceRefId: null,
      remark: payload.remark,
    };

    // sourceKey（issueKey）幂等先于深校验与记账：命中即回首次结果——重发指令
    // 不因库存已变被误拒；不落新账、不占用新 operationId。
    const dedup = await this.duplicateOutcomeOf(tenant, input.issueKey);
    if (dedup !== null) return dedup;

    // 先解析校验后记账（口径统一，与 transfer/stocktake/approve 对齐）：深校验
    // （仓库/预占核销或直扣可用量/库位扣减计划）通过后才落 operationId——被拒
    // 不占用 id，同 id 修正载荷重发可重新评估（committed 后同 id 重发若前置
    // 状态已变则按状态拒）。
    const checked = await this.validateIssueStock(tenant, input);
    if ('status' in checked) return checked;

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: 'stock-movement',
      aggregateId: 'issue',
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    return this.issueStock(envelope, input);
  }

  /**
   * 出库深校验（stock.issue 命令面 pre-record 前置 + issueStock 复用）：
   * 恒等式机器校验（可用量=总量−预占）与库位扣减计划。
   *  - 核销路径（reservationKey 给出）：预占行 active 且 remaining ≥ q 才放行；
   *  - 直扣路径：可用量 ≥ q 才放行（负库存 allow 策略放开守卫，合同 §8）。
   * 返回 null = 通过并给出核销量与库位扣减计划；否则拒绝回执。纯读校验，
   * 重跑结果一致。
   */
  private async validateIssueStock(
    tenant: TenantId,
    input: IssueStockInput,
  ): Promise<RejectedOutcome | { readonly consumedQty: number; readonly deduction: Map<string, number> }> {
    const warehouse = await this.warehouses.find(tenant, input.warehouseId);
    if (warehouse === null) {
      return rejected(`租户 '${tenant}' 内不存在仓库 '${input.warehouseId}'`);
    }

    let consumedQty = 0;
    if (input.reservationKey !== null) {
      const reservation = await this.reservations.findByKey(tenant, input.reservationKey);
      if (reservation === null) {
        return rejected(`预占 '${input.reservationKey}' 不存在（核销出库须先创建预占）`);
      }
      if (reservation.status !== 'active') {
        return rejected(`预占 '${input.reservationKey}' 已 ${reservation.status}（不可核销）`);
      }
      if (reservation.itemId !== input.itemId || reservation.warehouseId !== input.warehouseId) {
        return rejected(
          `预占 '${input.reservationKey}' 锚定 ${reservation.itemId}@${reservation.warehouseId}，与出库 ${input.itemId}@${input.warehouseId} 不符`,
        );
      }
      if (reservation.remaining < input.quantity) {
        return rejected(`预占余量不足：'${input.reservationKey}' 剩 ${reservation.remaining} < 出库 ${input.quantity}`);
      }
      consumedQty = input.quantity;
    } else {
      // 直扣路径：可用量守卫（allow 策略放开）。
      const account = await this.accounts.find(tenant, input.itemId, input.warehouseId);
      const onHand = account?.qtyOnHand ?? 0;
      const reserved = account?.qtyReserved ?? 0;
      const available = onHand - reserved;
      if (!this.allowNegative && available < input.quantity) {
        return rejected(
          `可用量不足：物料 '${input.itemId}' @仓库 '${input.warehouseId}' 可用量 ${available}（总量 ${onHand} − 预占 ${reserved}）< 出库 ${input.quantity}`,
        );
      }
    }

    // 库位扣减计划（指定库位单点扣；未指定按库位余额 FIFO）——先校验足额再落账。
    const deduction = await this.planLocationDeduction(
      tenant,
      input.warehouseId,
      input.itemId,
      input.locationId,
      input.quantity,
      warehouse.defaultLocationId,
      { allowNegative: this.allowNegative },
    );
    if (deduction === null) {
      const where = input.locationId === null ? '（FIFO 全仓）' : `（库位 '${input.locationId}'）`;
      return rejected(`库位余额不足：物料 '${input.itemId}' @仓库 '${input.warehouseId}' ${where}无法足额扣 ${input.quantity}`);
    }
    return { consumedQty, deduction };
  }

  /**
   * 出库统一入账（stock.issue 命令面 / shipping 行 / issuePartsStock 端口面共用）。
   *
   * 恒等式机器校验（可用量=总量−预占）：
   *  - 核销路径（reservationKey 给出）：预占行 active 且 remaining ≥ q 才放行
   *    ——账面 (−q 总量, −q 预占)，可用量不变；
   *  - 直扣路径：可用量 ≥ q 才放行（负库存 allow 策略放开守卫，合同 §8）。
   * issueKey（sourceKey）命中既有流水 → 幂等返回首次结果不重复扣减。
   */
  private async issueStock(
    envelope: CommandEnvelope<InventoryCommand>,
    input: IssueStockInput,
  ): Promise<InventoryCommandResult> {
    const tenant = envelope.tenantId;

    if (input.issueKey !== null) {
      const dedup = await this.duplicateOutcomeOf(tenant, input.issueKey);
      if (dedup !== null) return dedup;
    }

    const checked = await this.validateIssueStock(tenant, input);
    if ('status' in checked) return checked;
    const { consumedQty, deduction } = checked;

    const movementId = newStockMovementId();
    const occurredAt = this.now();
    const { movement } = await this.movements.append({
      tenant,
      id: movementId,
      kind: input.movementKind,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      locationId: input.locationId,
      quantity: input.quantity,
      sourceRefType: input.sourceRefType,
      sourceRefId: input.sourceRefId,
      sourceKey: input.issueKey,
      transferId: null,
      workOrderId: input.workOrderId,
      remark: input.remark,
      occurredAt,
      recordedBy: envelope.issuedBy,
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    });
    const account = await this.accounts.adjust(
      tenant,
      input.itemId,
      input.warehouseId,
      -input.quantity,
      -consumedQty,
      { allowNegativeHand: this.allowNegative },
    );
    for (const [locationId, qty] of deduction) {
      await this.balances.adjust(
        tenant,
        input.warehouseId,
        locationId,
        input.itemId,
        -qty,
        { allowNegativeHand: this.allowNegative },
      );
    }
    if (consumedQty > 0) {
      const consumed = await this.reservations.consume(tenant, input.reservationKey as string, consumedQty);
      if (consumed === null) {
        // 预校验后竞态窗口（并发核销）：账已动、预占未销——上抛数据级冲突由组合根映射。
        throw new InventoryStateError(
          `预占 '${input.reservationKey}' 核销竞态失败（并发核销窗口），须人工对账`,
        );
      }
    }

    const event = makeStockIssuedEvent(
      this.domainEventBase(envelope),
      {
        movementKind: input.movementKind,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        locationId: input.locationId,
        quantity: input.quantity,
        purpose: input.purpose,
        workOrderId: input.workOrderId,
        reservationKey: input.reservationKey,
        consumedReservationQty: consumedQty,
        shipmentId: input.shipmentId,
        issueKey: input.issueKey,
        duplicate: false,
        qtyOnHand: account.qtyOnHand,
        qtyReserved: account.qtyReserved,
        actor: envelope.issuedBy,
      },
      movementId,
    );
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1,
      events: [event],
      movement,
      stockLevel: this.levelOf(input.itemId, input.warehouseId, account),
    };
  }

  /**
   * 库位扣减计划：返回 Map<locationId, qty>（扣减分配）。
   * 指定库位 → 单点扣（allow 足额放开时可扣成负）；未指定 → 按库位余额
   * createdAt 升序（FIFO）逐位分配，Σ余额不足且 allow → 差额挂默认库位
   * （defaultLocationId）；否则返回 null（拒绝）。调拨/移库调用方不放开
   * （实物移动不可凭空——与出库的账面负数暂存语义不同）。
   */
  private async planLocationDeduction(
    tenant: TenantId,
    warehouseId: string,
    itemId: string,
    locationId: string | null,
    quantity: number,
    defaultLocationId: string,
    opts?: { readonly allowNegative?: boolean },
  ): Promise<Map<string, number> | null> {
    const allowNegative = opts?.allowNegative ?? false;
    if (locationId !== null) {
      const balance = await this.balances.find(tenant, warehouseId, locationId, itemId);
      const available = balance?.qty ?? 0;
      if (available < quantity && !allowNegative) return null;
      return new Map([[locationId, quantity]]);
    }
    const rows = (await this.balances.list(tenant, { warehouseId, itemId })).filter(
      (row) => row.qty > 0,
    );
    const plan = new Map<string, number>();
    let remaining = quantity;
    for (const row of rows) {
      if (remaining <= 0) break;
      const take = Math.min(row.qty, remaining);
      plan.set(row.locationId, (plan.get(row.locationId) ?? 0) + take);
      remaining -= take;
    }
    if (remaining > 0) {
      if (!allowNegative) return null;
      plan.set(defaultLocationId, (plan.get(defaultLocationId) ?? 0) + remaining);
    }
    return plan;
  }

  // ---- stock.transfer（调拨/移库） ----

  private async transfer(envelope: CommandEnvelope<InventoryCommand>): Promise<InventoryCommandResult> {
    const payload = parseStockTransferPayload(envelope.command.payload);
    const tenant = envelope.tenantId;

    const from = await this.warehouses.find(tenant, payload.fromWarehouseId);
    if (from === null) {
      return rejected(`租户 '${tenant}' 内不存在源仓库 '${payload.fromWarehouseId}'`);
    }
    const to = await this.warehouses.find(tenant, payload.toWarehouseId);
    if (to === null) {
      return rejected(`租户 '${tenant}' 内不存在目的仓库 '${payload.toWarehouseId}'`);
    }
    const fromLocationId = payload.fromLocationId ?? from.defaultLocationId;
    const toLocationId = payload.toLocationId ?? to.defaultLocationId;
    if ((await this.warehouses.findLocation(tenant, payload.fromWarehouseId, fromLocationId)) === null) {
      return rejected(`源仓库 '${payload.fromWarehouseId}' 内不存在库位 '${fromLocationId}'`);
    }
    if ((await this.warehouses.findLocation(tenant, payload.toWarehouseId, toLocationId)) === null) {
      return rejected(`目的仓库 '${payload.toWarehouseId}' 内不存在库位 '${toLocationId}'`);
    }

    const intra = payload.fromWarehouseId === payload.toWarehouseId;
    if (!intra) {
      // 跨仓调拨吃可用量（reject 策略守卫）；仓内移库不动仓库账。
      const account = await this.accounts.find(tenant, payload.itemId, payload.fromWarehouseId);
      const onHand = account?.qtyOnHand ?? 0;
      const reserved = account?.qtyReserved ?? 0;
      if (!this.allowNegative && onHand - reserved < payload.quantity) {
        return rejected(
          `调拨可用量不足：物料 '${payload.itemId}' @源仓 '${payload.fromWarehouseId}' 可用量 ${onHand - reserved} < 调拨 ${payload.quantity}`,
        );
      }
    }
    const deduction = await this.planLocationDeduction(
      tenant,
      payload.fromWarehouseId,
      payload.itemId,
      payload.fromLocationId,
      payload.quantity,
      from.defaultLocationId,
    );
    if (deduction === null) {
      return rejected(
        `源库位余额不足：物料 '${payload.itemId}' @仓库 '${payload.fromWarehouseId}' 无法足额调出 ${payload.quantity}`,
      );
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: 'stock-movement',
      aggregateId: 'transfer',
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const transferId = newTransferId();
    const occurredAt = this.now();
    const provenance = provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy);
    const outMovement = await this.movements.append({
      tenant,
      id: newStockMovementId(),
      kind: 'transfer-out',
      itemId: payload.itemId,
      warehouseId: payload.fromWarehouseId,
      locationId: fromLocationId,
      quantity: payload.quantity,
      sourceRefType: 'transfer',
      sourceRefId: transferId,
      sourceKey: null,
      transferId,
      workOrderId: null,
      remark: payload.remark,
      occurredAt,
      recordedBy: envelope.issuedBy,
      provenance,
    });
    const inMovement = await this.movements.append({
      tenant,
      id: newStockMovementId(),
      kind: 'transfer-in',
      itemId: payload.itemId,
      warehouseId: payload.toWarehouseId,
      locationId: toLocationId,
      quantity: payload.quantity,
      sourceRefType: 'transfer',
      sourceRefId: transferId,
      sourceKey: null,
      transferId,
      workOrderId: null,
      remark: payload.remark,
      occurredAt,
      recordedBy: envelope.issuedBy,
      provenance,
    });

    for (const [locationId, qty] of deduction) {
      await this.balances.adjust(
        tenant,
        payload.fromWarehouseId,
        locationId,
        payload.itemId,
        -qty,
        { allowNegativeHand: this.allowNegative },
      );
    }
    await this.balances.adjust(tenant, payload.toWarehouseId, toLocationId, payload.itemId, payload.quantity);
    if (!intra) {
      await this.accounts.adjust(
        tenant,
        payload.itemId,
        payload.fromWarehouseId,
        -payload.quantity,
        0,
        { allowNegativeHand: this.allowNegative },
      );
      await this.accounts.adjust(tenant, payload.itemId, payload.toWarehouseId, payload.quantity, 0);
    }

    const event = makeStockTransferredEvent(this.domainEventBase(envelope), {
      transferId,
      itemId: payload.itemId,
      fromWarehouseId: payload.fromWarehouseId,
      toWarehouseId: payload.toWarehouseId,
      fromLocationId,
      toLocationId,
      quantity: payload.quantity,
      intraWarehouse: intra,
      actor: envelope.issuedBy,
    });
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1,
      events: [event],
      movements: [outMovement.movement, inMovement.movement],
    };
  }

  // ---- stocktake.open（建单 + START：先落 draft@v1 投影再驱动迁移） ----

  private async openStocktake(
    envelope: CommandEnvelope<InventoryCommand>,
  ): Promise<InventoryCommandResult> {
    const payload = parseStocktakeOpenPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const warehouse = await this.warehouses.find(tenant, payload.warehouseId);
    if (warehouse === null) {
      return rejected(`租户 '${tenant}' 内不存在仓库 '${payload.warehouseId}'`);
    }

    const startRule = this.options.stocktakeConfig.transitions.find(
      (candidate) => candidate.from === this.options.stocktakeConfig.initial && candidate.event === 'START',
    );
    if (startRule === undefined) {
      return rejected(`初始态 '${this.options.stocktakeConfig.initial}' 不支持开单（配置无 START 规则）`);
    }

    // 开单快照：scope 内物料的当前账面（缺省 = 该仓全部有账物料）。
    const accounts = await this.accounts.list(tenant, { warehouseId: payload.warehouseId });
    const scopeItems =
      payload.itemIds === null
        ? accounts.map((account) => account.itemId)
        : payload.itemIds;
    const systemQtyOf = new Map(accounts.map((account) => [account.itemId, account.qtyOnHand]));
    const lines: StocktakeLine[] = [...scopeItems]
      .sort((a, b) => a.localeCompare(b))
      .map((itemId) => ({
        itemId,
        systemQty: systemQtyOf.get(itemId) ?? 0,
        countedQty: null,
        countedAt: null,
        countedBy: null,
      }));

    const stocktakeId = newStocktakeId();
    // 落账顺序（Wave-2 返工结论）：先落 draft@v1 投影行（初始态无机器事件），
    // 再驱动 START、append 机器账本、乐观推进至 counting@v2——投影行先在是
    // 机器事件 append 的前置（PG 账本按投影行解析租户，孤儿聚合拒写）。
    const runtime = startApprovalFlow({
      config: this.options.stocktakeConfig,
      subject: { aggregate: { id: stocktakeId, type: STOCKTAKE_AGGREGATE_TYPE }, initialObjectVersion: 1 },
      now: () => this.now(),
      newEventId: () => EventId.create(newDomainEventId()),
    });
    try {
      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: STOCKTAKE_AGGREGATE_TYPE,
        aggregateId: stocktakeId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      const created = await this.stocktakes.create({
        tenant,
        id: stocktakeId,
        warehouseId: payload.warehouseId,
        flowConfigId: this.options.stocktakeConfig.flowId,
        state: this.options.stocktakeConfig.initial, // draft：初始态落库，无机器事件
        objectVersion: 1,
        lines,
        openedBy: envelope.issuedBy,
        remark: payload.remark,
      });
      void created;
      const outcome = runtime.send('START', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '盘点开单',
        objectVersion: 1,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`盘点开单失败：draft 对 START 返回 ${outcome.status}`);
      }
      await this.machineEvents.append(outcome.event);
      const advanced = await this.stocktakes.advance(
        tenant,
        stocktakeId,
        1,
        runtime.state(),
        runtime.objectVersion(),
      );
      // 开单无域事件（StocktakeAdjusted 在调账时发——合同事件面最小集）。
      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [],
        stocktake: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- stocktake.record（实盘录入；complete=true 提交差异进审核） ----

  private async recordStocktake(
    envelope: CommandEnvelope<InventoryCommand>,
    stocktakeId: string,
  ): Promise<InventoryCommandResult> {
    const payload = parseStocktakeRecordPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const stocktake = await this.stocktakes.find(tenant, stocktakeId);
    if (stocktake === null) {
      return rejected(`租户 '${tenant}' 内不存在盘点单 '${stocktakeId}'`);
    }
    if (stocktake.flowConfigId !== this.options.stocktakeConfig.flowId) {
      return rejected(
        `盘点单由配置 '${stocktake.flowConfigId}' 驱动，与当前装配配置 '${this.options.stocktakeConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== stocktake.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，盘点单当前 objectVersion=${stocktake.objectVersion}`,
      );
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: STOCKTAKE_AGGREGATE_TYPE,
      aggregateId: stocktakeId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 实盘行合并（多轮录入覆盖同物料行；scope 外物料拒绝）。
    const scopeItems = new Set(stocktake.lines.map((line) => line.itemId));
    for (const line of payload.lines) {
      if (!scopeItems.has(line.itemId)) {
        return rejected(`实盘行 '${line.itemId}' 不在盘点单 scope 内（开单范围外物料）`);
      }
    }
    const countedAt = this.now();
    const countedMap = new Map(payload.lines.map((line) => [line.itemId, line]));
    const merged: StocktakeLine[] = stocktake.lines.map((line) => {
      const counted = countedMap.get(line.itemId);
      return counted === undefined
        ? line
        : {
            ...line,
            countedQty: counted.countedQty,
            countedAt,
            countedBy: envelope.issuedBy,
          };
    });
    const updated = await this.stocktakes.updateLines(tenant, stocktakeId, stocktake.objectVersion, merged);
    if (updated === null) {
      return rejected(
        `盘点单 '${stocktakeId}' 行写入冲突：期望 objectVersion=${stocktake.objectVersion}（可能存在并发录入）`,
      );
    }

    if (!payload.complete) {
      return {
        status: 'committed',
        newRevision: updated.objectVersion, // 录行不推状态机版本（行载荷事实，非迁移）
        events: [],
        stocktake: updated,
      };
    }

    // complete=true：全部行已盘才可提交差异（counting → reconciled）。
    const uncounted = updated.lines.filter((line) => line.countedQty === null);
    if (uncounted.length > 0) {
      return rejected(
        `盘点未完成：仍有 ${uncounted.length} 行未录实盘（complete=true 须全部行已盘），盘点单保持 counting`,
      );
    }
    const runtime = await this.replayStocktake(updated);
    try {
      const outcome = runtime.send('RECONCILE', {
        by: envelope.issuedBy,
        reason: '实盘完成提交差异',
        objectVersion: updated.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`盘点提交失败：counting 对 RECONCILE 返回 ${outcome.status}`);
      }
      await this.machineEvents.append(outcome.event);
      const advanced = await this.stocktakes.advance(
        tenant,
        stocktakeId,
        updated.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );
      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [],
        stocktake: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- stocktake.approve-adjust（审核调账：账面校到实盘 + 留痕） ----

  private async approveAdjust(
    envelope: CommandEnvelope<InventoryCommand>,
    stocktakeId: string,
  ): Promise<InventoryCommandResult> {
    const payload = parseStocktakeApprovePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const stocktake = await this.stocktakes.find(tenant, stocktakeId);
    if (stocktake === null) {
      return rejected(`租户 '${tenant}' 内不存在盘点单 '${stocktakeId}'`);
    }
    if (stocktake.flowConfigId !== this.options.stocktakeConfig.flowId) {
      return rejected(
        `盘点单由配置 '${stocktake.flowConfigId}' 驱动，与当前装配配置 '${this.options.stocktakeConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== stocktake.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，盘点单当前 objectVersion=${stocktake.objectVersion}`,
      );
    }

    const runtime = await this.replayStocktake(stocktake);
    try {
      const from = runtime.state();
      const rule = this.options.stocktakeConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'ADJUST',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持审核调账（仅 reconciled 态，配置无 ADJUST 规则）`);
      }
      const outcome = runtime.send('ADJUST', {
        by: envelope.issuedBy,
        reason: payload.remark,
        objectVersion: stocktake.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 的审核调账未迁移（${outcome.status}）`);
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: STOCKTAKE_AGGREGATE_TYPE,
        aggregateId: stocktakeId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      // 调账：把账面校到实盘（movement = counted − 当前账面；账实校正放开
      // 负守卫——实盘为准）。审计差异行 = counted − 开单快照（StocktakeAdjusted
      // 载荷留痕）。库位侧差异全部落默认库位（初版口径：库位级盘点差异归对账
      // 阶段校正）。
      const warehouse = await this.warehouses.find(tenant, stocktake.warehouseId);
      if (warehouse === null) {
        throw new InventoryStateError(
          `盘点单 '${stocktakeId}' 锚定的仓库 '${stocktake.warehouseId}' 已不存在（主数据与盘点账不一致）`,
        );
      }
      const adjustments: StockAdjustLine[] = [];
      const movements: StockMovement[] = [];
      const occurredAt = this.now();
      const provenance = provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy);
      let totalBefore = 0;
      let totalAfter = 0;
      for (const line of stocktake.lines) {
        const counted = line.countedQty as number;
        totalAfter += counted;
        totalBefore += line.systemQty;
        if (counted !== line.systemQty) {
          adjustments.push({
            itemId: line.itemId,
            systemQty: line.systemQty,
            countedQty: counted,
            diffQty: counted - line.systemQty,
          });
        }
        const account = await this.accounts.find(tenant, line.itemId, stocktake.warehouseId);
        const currentOnHand = account?.qtyOnHand ?? 0;
        if (counted === currentOnHand) continue; // 账面已等于实盘：无需调账流水
        const delta = counted - currentOnHand;
        const kind: StockMovementKind = delta > 0 ? 'stocktake-gain' : 'stocktake-loss';
        const { movement } = await this.movements.append({
          tenant,
          id: newStockMovementId(),
          kind,
          itemId: line.itemId,
          warehouseId: stocktake.warehouseId,
          locationId: warehouse.defaultLocationId,
          quantity: Math.abs(delta),
          sourceRefType: 'stocktake',
          sourceRefId: stocktakeId,
          sourceKey: null,
          transferId: null,
          workOrderId: null,
          remark: payload.remark,
          occurredAt,
          recordedBy: envelope.issuedBy,
          provenance,
        });
        movements.push(movement);
        await this.accounts.adjust(tenant, line.itemId, stocktake.warehouseId, delta, 0, {
          allowNegativeHand: true, // 账实校正以实盘为准（counted ≥ 0 恒非负）
        });
        await this.balances.adjust(
          tenant,
          stocktake.warehouseId,
          warehouse.defaultLocationId,
          line.itemId,
          delta,
          { allowNegativeHand: true },
        );
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.stocktakes.advance(
        tenant,
        stocktakeId,
        stocktake.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { approvedBy: envelope.issuedBy, remark: payload.remark },
      );

      const eventPayload: StocktakeAdjustedPayload = {
        stocktakeId,
        warehouseId: stocktake.warehouseId,
        adjustments,
        totalBefore,
        totalAfter,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeStocktakeAdjustedEvent(this.domainEventBase(envelope), eventPayload);
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        movements,
        stocktake: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- shipping.execute（建任务 + EXECUTE + 行级出库） ----

  private async executeShipping(
    envelope: CommandEnvelope<InventoryCommand>,
  ): Promise<InventoryCommandResult> {
    const payload = parseShippingExecutePayload(envelope.command.payload);
    const tenant = envelope.tenantId;

    // 行落仓解析 + 两阶段预校验的第一阶段（逐行仓库/库位/预占 + 按物料×仓
    // 合并校验可用量与库位余额——多行同物料按合计判定，任一不满足整单不落账）。
    const resolvedLines: ShippingLine[] = [];
    const directTotals = new Map<string, number>(); // `${itemId}|${warehouseId}` → 直扣合计
    for (const [index, line] of payload.lines.entries()) {
      const warehouseId = line.warehouseId ?? this.options.defaultWarehouseId;
      if (warehouseId === null || warehouseId === undefined) {
        return rejected(`发货行 ${index + 1} 未指定仓库且未配置默认仓（服务选项 defaultWarehouseId）`);
      }
      const warehouse = await this.warehouses.find(tenant, warehouseId);
      if (warehouse === null) {
        return rejected(`发货行 ${index + 1}：租户 '${tenant}' 内不存在仓库 '${warehouseId}'`);
      }
      const locationId = line.locationId ?? warehouse.defaultLocationId;
      if ((await this.warehouses.findLocation(tenant, warehouseId, locationId)) === null) {
        return rejected(`发货行 ${index + 1}：仓库 '${warehouseId}' 内不存在库位 '${locationId}'`);
      }
      resolvedLines.push({
        itemId: line.itemId,
        quantity: line.quantity,
        warehouseId,
        locationId,
        reservationKey: line.reservationKey,
      });
      if (line.reservationKey !== null) {
        const check = await this.precheckReservation(tenant, line.itemId, warehouseId, line.quantity, line.reservationKey);
        if (check !== null) {
          return rejected(`发货行 ${index + 1}（${line.itemId}×${line.quantity}）不可出库：${check}`);
        }
      } else {
        const key = `${line.itemId}|${warehouseId}`;
        directTotals.set(key, (directTotals.get(key) ?? 0) + line.quantity);
      }
    }
    for (const [key, total] of directTotals) {
      const [itemId, warehouseId] = key.split('|') as [string, string];
      const check = await this.precheckAvailability(tenant, itemId, warehouseId, total);
      if (check !== null) {
        return rejected(`发货（${itemId}×${total}）不可出库：${check}`);
      }
    }

    const executeRule = this.options.shippingConfig.transitions.find(
      (candidate) => candidate.from === this.options.shippingConfig.initial && candidate.event === 'EXECUTE',
    );
    if (executeRule === undefined) {
      return rejected(`初始态 '${this.options.shippingConfig.initial}' 不支持执行（配置无 EXECUTE 规则）`);
    }

    const shippingOrderId = newShippingOrderId();
    // 落账顺序：先落 draft@v1 投影行再驱动 EXECUTE（Wave-2 返工结论，同盘点开单）。
    const runtime = startApprovalFlow({
      config: this.options.shippingConfig,
      subject: { aggregate: { id: shippingOrderId, type: SHIPPING_ORDER_AGGREGATE_TYPE }, initialObjectVersion: 1 },
      now: () => this.now(),
      newEventId: () => EventId.create(newDomainEventId()),
    });
    try {
      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: SHIPPING_ORDER_AGGREGATE_TYPE,
        aggregateId: shippingOrderId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.shippings.create({
        tenant,
        id: shippingOrderId,
        workOrderId: payload.workOrderId,
        flowConfigId: this.options.shippingConfig.flowId,
        state: this.options.shippingConfig.initial, // draft：初始态落库，无机器事件
        objectVersion: 1,
        lines: resolvedLines,
        executedBy: envelope.issuedBy,
        carrier: payload.carrier,
        trackingNo: payload.trackingNo,
        remark: payload.remark,
      });

      const outcome = runtime.send('EXECUTE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '发货执行',
        objectVersion: 1,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`发货执行失败：draft 对 EXECUTE 返回 ${outcome.status}`);
      }
      await this.machineEvents.append(outcome.event);

      // 行级出库（预校验已全过）：复用出库统一入账（核销 or 直扣）。
      const events: BusinessEvent[] = [];
      for (const line of resolvedLines) {
        const result = await this.issueStock(envelope, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId,
          quantity: line.quantity,
          purpose: 'shipping',
          movementKind: 'shipping-out',
          workOrderId: payload.workOrderId,
          reservationKey: line.reservationKey,
          issueKey: null,
          shipmentId: shippingOrderId,
          sourceRefType: 'shipping',
          sourceRefId: shippingOrderId,
          remark: payload.remark,
        });
        if (result.status !== 'committed') {
          // 预校验后的竞态窗口：整单已在途——上抛数据级冲突（组合根映射 409）。
          throw new InventoryStateError(
            `发货任务 '${shippingOrderId}' 行出库竞态失败：${result.status === 'rejected' ? result.reason : result.reason}`,
          );
        }
        events.push(...result.events);
      }

      const advanced = await this.shippings.advance(
        tenant,
        shippingOrderId,
        1,
        runtime.state(),
        runtime.objectVersion(),
      );
      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events,
        shippingOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  /** 出库预校验——预占核销行：返回 null=可出库；否则拒绝原因。 */
  private async precheckReservation(
    tenant: TenantId,
    itemId: string,
    warehouseId: string,
    quantity: number,
    reservationKey: string,
  ): Promise<string | null> {
    const reservation = await this.reservations.findByKey(tenant, reservationKey);
    if (reservation === null) return `预占 '${reservationKey}' 不存在`;
    if (reservation.status !== 'active') return `预占 '${reservationKey}' 已 ${reservation.status}`;
    if (reservation.itemId !== itemId || reservation.warehouseId !== warehouseId) {
      return `预占 '${reservationKey}' 锚定 ${reservation.itemId}@${reservation.warehouseId} 与发货行不符`;
    }
    if (reservation.remaining < quantity) {
      return `预占余量不足（剩 ${reservation.remaining} < ${quantity}）`;
    }
    return null;
  }

  /** 出库预校验——直扣可用量（合计口径）：返回 null=可出库；否则拒绝原因。 */
  private async precheckAvailability(
    tenant: TenantId,
    itemId: string,
    warehouseId: string,
    totalQuantity: number,
  ): Promise<string | null> {
    const account = await this.accounts.find(tenant, itemId, warehouseId);
    const onHand = account?.qtyOnHand ?? 0;
    const reserved = account?.qtyReserved ?? 0;
    if (!this.allowNegative && onHand - reserved < totalQuantity) {
      return `可用量不足（${onHand - reserved} < ${totalQuantity}）`;
    }
    return null;
  }

  // ---- shipping.confirm（确认发货 → ShippingConfirmed） ----

  private async confirmShipping(
    envelope: CommandEnvelope<InventoryCommand>,
    shippingOrderId: string,
  ): Promise<InventoryCommandResult> {
    const payload = parseShippingConfirmPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const shipping = await this.shippings.find(tenant, shippingOrderId);
    if (shipping === null) {
      return rejected(`租户 '${tenant}' 内不存在发货任务 '${shippingOrderId}'`);
    }
    if (shipping.flowConfigId !== this.options.shippingConfig.flowId) {
      return rejected(
        `发货任务由配置 '${shipping.flowConfigId}' 驱动，与当前装配配置 '${this.options.shippingConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== shipping.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，发货任务当前 objectVersion=${shipping.objectVersion}`,
      );
    }

    const runtime = await this.replayShipping(shipping);
    try {
      const from = runtime.state();
      const rule = this.options.shippingConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'CONFIRM',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持确认发货（仅执行中态，配置无 CONFIRM 规则）`);
      }
      const outcome = runtime.send('CONFIRM', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '发货确认',
        objectVersion: shipping.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对 CONFIRM 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: SHIPPING_ORDER_AGGREGATE_TYPE,
        aggregateId: shippingOrderId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const confirmedAt = this.now();
      const advanced = await this.shippings.advance(
        tenant,
        shippingOrderId,
        shipping.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        {
          ...(payload.carrier === undefined ? {} : { carrier: payload.carrier }),
          ...(payload.trackingNo === undefined ? {} : { trackingNo: payload.trackingNo }),
          confirmedBy: envelope.issuedBy,
          confirmedAt,
        },
      );

      // ShippingConfirmed → workorder 待发货→已发货联动（消费锚点：workOrderId）。
      const event = makeShippingConfirmedEvent(
        this.domainEventBase(envelope),
        {
          shippingOrderId,
          workOrderId: advanced.workOrderId,
          lines: advanced.lines,
          carrier: advanced.carrier,
          trackingNo: advanced.trackingNo,
          objectVersion: runtime.objectVersion(),
          actor: envelope.issuedBy,
        },
        shippingOrderId,
      );
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        shippingOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- 查询（合同 §3：实时库存/库位分布/流水/盘点台账/发货记录；移动端逻辑面同径） ----

  /** 仓库目录（code 升序；含库位集）。 */
  async listWarehouses(tenant: TenantId): Promise<readonly Warehouse[]> {
    return this.warehouses.list(tenant);
  }

  /** 仓库详情（含库位；不存在抛 InventoryNotFoundError）。 */
  async warehouseDetail(tenant: TenantId, warehouseId: string): Promise<Warehouse> {
    const warehouse = await this.warehouses.find(tenant, warehouseId);
    if (warehouse === null) {
      throw new InventoryNotFoundError(`租户 '${tenant}' 内不存在仓库 '${warehouseId}'`);
    }
    return warehouse;
  }

  /** 实时库存（可用量口径；可用量=总量−预占，机器计算非存储列）。 */
  async stockLevels(
    tenant: TenantId,
    warehouseId?: string,
    itemId?: string,
  ): Promise<readonly StockLevelView[]> {
    const accounts = await this.accounts.list(tenant, {
      ...(warehouseId === undefined ? {} : { warehouseId }),
      ...(itemId === undefined ? {} : { itemId }),
    });
    return accounts.map((account) => this.levelOf(account.itemId, account.warehouseId, account));
  }

  /** 库位分布（createdAt 升序 = FIFO 扣减序）。 */
  async locationBalances(
    tenant: TenantId,
    warehouseId?: string,
    itemId?: string,
  ) {
    return this.balances.list(tenant, {
      ...(warehouseId === undefined ? {} : { warehouseId }),
      ...(itemId === undefined ? {} : { itemId }),
    });
  }

  /** 出入库流水（插入序升序；itemId/warehouseId 过滤）。 */
  async listMovements(
    tenant: TenantId,
    itemId?: string,
    warehouseId?: string,
  ): Promise<readonly StockMovement[]> {
    return this.movements.list(tenant, {
      ...(itemId === undefined ? {} : { itemId }),
      ...(warehouseId === undefined ? {} : { warehouseId }),
    });
  }

  /** 盘点台账（createdAt 降序；state 过滤）。 */
  async listStocktakes(tenant: TenantId, stateFilter?: string): Promise<readonly Stocktake[]> {
    return this.stocktakes.list(
      tenant,
      stateFilter === undefined ? undefined : { state: stateFilter },
    );
  }  /** 盘点详情（含行集 + 机器迁移里程碑）。 */
  async stocktakeDetail(
    tenant: TenantId,
    stocktakeId: string,
  ): Promise<{
    readonly stocktake: Stocktake;
    readonly milestones: readonly { readonly from: string; readonly to: string; readonly event: string; readonly at: string; readonly actor: string; readonly objectVersion: number }[];
  }> {
    const stocktake = await this.stocktakes.find(tenant, stocktakeId);
    if (stocktake === null) {
      throw new InventoryNotFoundError(`租户 '${tenant}' 内不存在盘点单 '${stocktakeId}'`);
    }
    const page = await this.machineEvents.readByAggregate({ id: stocktakeId, type: STOCKTAKE_AGGREGATE_TYPE });
    return { stocktake, milestones: page.events.map((event) => ({
      from: event.payload.from,
      to: event.payload.to,
      event: event.payload.event,
      at: event.occurredAt,
      actor: event.payload.actor,
      objectVersion: event.payload.objectVersion,
    })) };
  }

  /** 发货记录（createdAt 降序；state/workOrderId 过滤）。 */
  async listShippingOrders(
    tenant: TenantId,
    stateFilter?: string,
    workOrderId?: string,
  ): Promise<readonly ShippingOrder[]> {
    return this.shippings.list(tenant, {
      ...(stateFilter === undefined ? {} : { state: stateFilter }),
      ...(workOrderId === undefined ? {} : { workOrderId }),
    });
  }

  /** 发货任务详情（含机器迁移里程碑）。 */
  async shippingDetail(
    tenant: TenantId,
    shippingOrderId: string,
  ): Promise<{
    readonly shippingOrder: ShippingOrder;
    readonly milestones: readonly { readonly from: string; readonly to: string; readonly event: string; readonly at: string; readonly actor: string; readonly objectVersion: number }[];
  }> {
    const shipping = await this.shippings.find(tenant, shippingOrderId);
    if (shipping === null) {
      throw new InventoryNotFoundError(`租户 '${tenant}' 内不存在发货任务 '${shippingOrderId}'`);
    }
    const page = await this.machineEvents.readByAggregate({ id: shippingOrderId, type: SHIPPING_ORDER_AGGREGATE_TYPE });
    return { shippingOrder: shipping, milestones: page.events.map((event) => ({
      from: event.payload.from,
      to: event.payload.to,
      event: event.payload.event,
      at: event.occurredAt,
      actor: event.payload.actor,
      objectVersion: event.payload.objectVersion,
    })) };
  }

  // ---- 跨模块端口面（适配器消费；见 inventory-ports.ts） ----

  /** 可用量批量查询（跨仓 Σ max(0, 总量−预占)——恒等式口径）。 */
  async availableQtyOf(
    tenant: TenantId,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const accounts = await this.accounts.list(tenant);
    const available = new Map<string, number>();
    for (const itemId of itemIds) available.set(itemId, 0);
    for (const account of accounts) {
      if (!available.has(account.itemId)) continue;
      const value = Math.max(0, account.qtyOnHand - account.qtyReserved);
      available.set(account.itemId, (available.get(account.itemId) ?? 0) + value);
    }
    return available;
  }

  /** listing InventoryReceiptPort 面收货入库（receiptKey 幂等；缺省仓落位）。 */
  async receivePurchaseStock(
    tenant: TenantId,
    command: {
      readonly receiptKey: string;
      readonly purchaseOrderId: string;
      readonly itemId: string;
      readonly quantity: number;
      readonly warehouseId?: string;
    },
  ): Promise<{ readonly received: boolean; readonly refusedReason?: string; readonly duplicate?: boolean }> {
    const warehouseId = command.warehouseId ?? this.options.defaultWarehouseId;
    if (warehouseId === null || warehouseId === undefined) {
      return { received: false, refusedReason: '未指定收货仓且未配置默认仓（服务选项 defaultWarehouseId）' };
    }
    const envelope = this.systemEnvelope(tenant, 'stock.receive.v1', {
      kind: 'purchase',
      itemId: command.itemId,
      warehouseId,
      locationId: null,
      quantity: command.quantity,
      inspectionId: null,
      purchaseOrderId: command.purchaseOrderId,
      workOrderId: null,
      receiptKey: command.receiptKey,
      remark: null,
    });
    const outcome = await this.receiveStock(envelope, {
      kind: 'purchase',
      itemId: command.itemId,
      warehouseId,
      locationId: null,
      quantity: command.quantity,
      inspectionId: null,
      purchaseOrderId: command.purchaseOrderId,
      workOrderId: null,
      receiptKey: command.receiptKey,
      remark: null,
    });
    if (outcome.status === 'rejected') {
      return { received: false, refusedReason: outcome.reason };
    }
    if (outcome.status === 'indeterminate') {
      return { received: false, refusedReason: `入库不确定：${outcome.reason}` };
    }
    return { received: true, ...(outcome.duplicate === true ? { duplicate: true } : {}) };
  }

  /** workorder PartsIssuePort 面配件出库（requestId 幂等——issueKey 锚点）。 */
  async issuePartsStock(
    tenant: TenantId,
    command: {
      readonly requestId: string;
      readonly workOrderId: string;
      readonly itemId: string;
      readonly quantity: number;
      readonly warehouseId?: string;
    },
  ): Promise<{ readonly issued: boolean; readonly refusedReason?: string; readonly duplicate?: boolean }> {
    const warehouseId = command.warehouseId ?? this.options.defaultWarehouseId;
    if (warehouseId === null || warehouseId === undefined) {
      return { issued: false, refusedReason: '未指定发料仓且未配置默认仓（服务选项 defaultWarehouseId）' };
    }
    const envelope = this.systemEnvelope(tenant, 'stock.issue.v1', {
      itemId: command.itemId,
      warehouseId,
      locationId: null,
      quantity: command.quantity,
      purpose: 'parts',
      workOrderId: command.workOrderId,
      reservationKey: null,
      issueKey: `parts-${command.requestId}`,
      remark: null,
    });
    const outcome = await this.issueStock(envelope, {
      itemId: command.itemId,
      warehouseId,
      locationId: null,
      quantity: command.quantity,
      purpose: 'parts',
      movementKind: 'issue-out',
      workOrderId: command.workOrderId,
      reservationKey: null,
      issueKey: `parts-${command.requestId}`,
      shipmentId: null,
      sourceRefType: 'parts-request',
      sourceRefId: command.requestId,
      remark: null,
    });
    if (outcome.status === 'rejected') {
      return { issued: false, refusedReason: outcome.reason };
    }
    if (outcome.status === 'indeterminate') {
      return { issued: false, refusedReason: `出库不确定：${outcome.reason}` };
    }
    return { issued: true, ...(outcome.duplicate === true ? { duplicate: true } : {}) };
  }

  /** inspection StockReleasePort 面放行事实登记（直连通道；事件通道为兜底）。 */
  async recordInspectionRelease(
    tenant: TenantId,
    fact: {
      readonly inspectionId: string;
      readonly kind: string;
      readonly itemId: string | null;
      readonly drawingNo: string | null;
      readonly quantity: number;
      readonly sourceType: string | null;
      readonly sourceRefId: string | null;
      readonly releasedAt: string;
    },
  ): Promise<void> {
    await this.releaseFacts.append({
      tenant,
      id: `rel-${uuidv7()}`,
      inspectionId: fact.inspectionId,
      phase: `direct@${fact.releasedAt}`, // 同轮重试幂等；复检新 releasedAt 记新行
      kind: fact.kind,
      itemId: fact.itemId,
      drawingNo: fact.drawingNo,
      quantity: fact.quantity,
      sourceType: fact.sourceType,
      sourceRefId: fact.sourceRefId,
      releasedAt: fact.releasedAt,
    });
  }

  // ---- 预占端口面（StockReservationPort 实现：reserve/release） ----

  /** 预占：创建即扣可用量（account.qtyReserved += q；可用量不足拒——reject 策略）。 */
  async reserveStock(
    tenant: TenantId,
    command: {
      readonly reservationKey: string;
      readonly itemId: string;
      readonly warehouseId?: string;
      readonly quantity: number;
      readonly refType: string;
      readonly refId: string;
    },
  ): Promise<{ readonly reserved: boolean; readonly refusedReason?: string; readonly duplicate?: boolean }> {
    const warehouseId = command.warehouseId ?? this.options.defaultWarehouseId;
    if (warehouseId === null || warehouseId === undefined) {
      return { reserved: false, refusedReason: '未指定仓库且未配置默认仓（服务选项 defaultWarehouseId）' };
    }
    const existing = await this.reservations.findByKey(tenant, command.reservationKey);
    if (existing !== null && existing.status === 'active') {
      return { reserved: true, duplicate: true }; // 幂等：重复指令返回首次结果不重复预占
    }
    if (existing !== null) {
      return {
        reserved: false,
        refusedReason: `预占键 '${command.reservationKey}' 已 ${existing.status}（consumed/released 的键不得复用）`,
      };
    }
    const account = await this.accounts.find(tenant, command.itemId, warehouseId);
    const onHand = account?.qtyOnHand ?? 0;
    const reserved = account?.qtyReserved ?? 0;
    if (!this.allowNegative && onHand - reserved < command.quantity) {
      return {
        reserved: false,
        refusedReason: `可用量不足：${command.itemId}@${warehouseId} 可用量 ${onHand - reserved} < 预占 ${command.quantity}`,
      };
    }
    await this.accounts.adjust(tenant, command.itemId, warehouseId, 0, command.quantity);
    const { duplicate } = await this.reservations.create({
      tenant,
      id: `rsv-${uuidv7()}`,
      reservationKey: command.reservationKey,
      itemId: command.itemId,
      warehouseId,
      quantity: command.quantity,
      refType: command.refType,
      refId: command.refId,
    });
    if (duplicate) {
      // 竞态：另一指令已建同键预占——回滚本侧预留量。
      await this.accounts.adjust(tenant, command.itemId, warehouseId, 0, -command.quantity);
      return { reserved: true, duplicate: true };
    }
    return { reserved: true };
  }

  /** 释放：未用退回（qtyReserved −= q；全量释放 quantity=null）。 */
  async releaseReservation(
    tenant: TenantId,
    reservationKey: string,
    quantity: number | null,
  ): Promise<{ readonly released: boolean; readonly refusedReason?: string }> {
    const reservation = await this.reservations.findByKey(tenant, reservationKey);
    if (reservation === null || reservation.status !== 'active') {
      return { released: false, refusedReason: `预占 '${reservationKey}' 不存在或已 ${reservation?.status ?? '不存在'}` };
    }
    const released = await this.reservations.releaseBy(tenant, reservationKey, quantity);
    if (released === null) {
      return { released: false, refusedReason: `预占 '${reservationKey}' 释放数量超余量` };
    }
    const releaseQty = quantity === null ? reservation.remaining : quantity;
    await this.accounts.adjust(tenant, reservation.itemId, reservation.warehouseId, 0, -releaseQty);
    return { released: true };
  }

  // ---- 私有辅助 ----

  private levelOf(itemId: string, warehouseId: string, account: { qtyOnHand: number; qtyReserved: number } | null): StockLevelView {
    const onHand = account?.qtyOnHand ?? 0;
    const reserved = account?.qtyReserved ?? 0;
    return { itemId, warehouseId, qtyOnHand: onHand, qtyReserved: reserved, availableQty: onHand - reserved };
  }

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<InventoryCommand>): {
    eventId: EventId;
    tenant: TenantId;
    occurredAt: string;
    provenance: InventoryEventProvenance;
  } {
    return {
      eventId: EventId.create(newDomainEventId()),
      tenant: envelope.tenantId,
      occurredAt: this.now(),
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    };
  }

  /** 端口面系统信封（兄弟模块联动指令——操作者记系统账号，operationId 幂等键由调用方 receiptKey/requestId 承载）。 */
  private systemEnvelope(tenant: TenantId, kind: InventoryCommandKind, payload: unknown): CommandEnvelope<InventoryCommand> {
    const operationId = OperationId.create(`sys-inventory-${newDomainEventId()}`);
    return makeCommandEnvelope<InventoryCommand>({
      tenantId: tenant,
      issuedBy: UserId.create('u-system-inventory'),
      operationId,
      expectedRevision: 'initial',
      issuedAt: this.now(),
      command: { kind, payload },
    });
  }

  /** 重放盘点机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayStocktake(stocktake: Stocktake): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: stocktake.id, type: STOCKTAKE_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.stocktakeConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    return this.finishReplay(runtime, page.events, stocktake, '盘点单');
  }

  /** 重放发货任务机器事件账本。 */
  private async replayShipping(shipping: ShippingOrder): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: shipping.id, type: SHIPPING_ORDER_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.shippingConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    return this.finishReplay(runtime, page.events, shipping, '发货任务');
  }

  private finishReplay(
    runtime: ApprovalFlowRuntime,
    events: readonly ApprovalEvent[],
    row: { readonly id: string; readonly state: string; readonly objectVersion: number },
    label: string,
  ): ApprovalFlowRuntime {
    for (const event of events) {
      const outcome = runtime.send(event.payload.event, {
        by: UserId.create(event.payload.actor),
        reason: event.payload.reason,
        objectVersion: event.payload.objectVersion - 1,
      });
      if (outcome.status !== 'transitioned') {
        runtime.stop();
        throw new InventoryStateError(
          `${label}事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== row.state || runtime.objectVersion() !== row.objectVersion) {
      runtime.stop();
      throw new InventoryStateError(
        `${label}事件账本与投影行不一致：投影 ${row.state}@v${row.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }
}
