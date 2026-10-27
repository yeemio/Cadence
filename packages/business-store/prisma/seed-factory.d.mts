/**
 * prisma/seed-factory.mjs 的最小类型面（同 seed.d.mts 先例：tsc 无 allowJs
 * ——.mjs 不能进编译面，手写声明供 tests/seed-factory.test.ts 直引锚定；
 * 形状按 seedFactoryMain 实际消费的操作，与测试内存桩同构）。
 */
export declare function seedFactoryMain(prisma: {
  readonly userRecord: CreateMany;
  readonly policyRecord: CreateMany;
  readonly customerRecord: CreateMany;
  readonly supplierRecord: CreateMany;
  readonly itemRecord: CreateMany;
  readonly processDefRecord: CreateMany;
  readonly routingRecord: CreateMany;
  readonly standardTimeRecord: CreateMany;
  readonly baselineOperationRecord: CreateMany;
  readonly inventoryOperationRecord: CreateMany;
  readonly workOrderProjectionRecord: CreateMany;
  readonly workorderOperationRecord: CreateMany;
  readonly listingSheetRecord: CreateMany;
  readonly listingLineRecord: CreateMany;
  readonly listingEventRecord: CreateMany;
  readonly listingOperationRecord: CreateMany;
  readonly purchaseOrderRecord: CreateMany;
  readonly dispatchOrderRecord: CreateMany;
  readonly dispatchEventRecord: CreateMany;
  readonly dispatchOperationRecord: CreateMany;
  readonly inspectionOrderRecord: CreateMany;
  readonly inspectionOperationRecord: CreateMany;
  readonly materialValidationRunRecord: CreateMany;
  readonly businessEventRecord: CreateMany;
  readonly outboxRecord: CreateMany;
  readonly warehouseRecord: Upsert;
  readonly warehouseLocationRecord: Upsert;
  readonly goodsShelfRecord: Upsert;
  readonly shelfLocationRecord: Upsert;
}): Promise<void>;

interface CreateMany {
  createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
}

interface Upsert {
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}
