/**
 * prisma/seed.mjs 的最小类型面（tsc 无 allowJs——.mjs 不能进编译面，手写
 * 声明供 tests/seed.test.ts 直引锚定；形状按 seedMain 实际消费的四个操作，
 * 与测试内存桩同构）。声明缺失曾报 TS7016（隐式 any）。
 */
export declare function seedMain(prisma: {
  readonly userRecord: {
    createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  };
  readonly policyRecord: {
    createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  };
  readonly warehouseRecord: {
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
  };
  readonly warehouseLocationRecord: {
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
  };
}): Promise<void>;
