/**
 * prisma/seed.mjs 的最小类型面（tsc 无 allowJs——.mjs 不能进编译面，手写
 * 声明供 tests/seed.test.ts 直引锚定；形状按 seedMain 实际消费的四个操作，
 * 与测试内存桩同构）。声明缺失曾报 TS7016（隐式 any）。
 */
import type { PrismaClient } from '@prisma/client';

interface SeedClient {
  readonly userRecord: {
    createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
    count(args: { where: { tenantId: string } }): Promise<number>;
  };
  readonly policyRecord: {
    createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
    count(args: { where: { tenantId: string } }): Promise<number>;
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
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export declare function seedMain(prisma: PrismaClient | (SeedClient & {
  $transaction<T>(run: (tx: SeedClient) => Promise<T>): Promise<T>;
})): Promise<void>;
