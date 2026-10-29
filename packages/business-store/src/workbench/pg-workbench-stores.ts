/**
 * TodoStore 的 PG 实现 + 组合根装配工厂（M1 增量 4-I，经本包 `./workbench`
 * 子路径导出——与 `./org` / `./masterdata` 同模式）。
 *
 * 数据级过滤合同（application 端口）：一切读操作按 (tenant_id, assignee_id)
 * 双键收口——非本人的行对当事人不可见（findOwn/complete 不命中 → null）。
 * 时间列往返：PG 侧 timestamptz，端口侧 ISO-8601 字符串（toISOString 归一）。
 */
import { PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, UserId } from '@smes/business-core';
import type {
  CreateTodoInput,
  TodoItem,
  TodoStore,
  TodoStatus,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

interface TodoDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly assigneeId: string;
  readonly title: string;
  readonly source: string;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly dueAt: Date | null;
}

function toTodoItem(row: TodoDbRow): TodoItem {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    assignee: UserId.create(row.assigneeId),
    title: row.title,
    source: row.source,
    refType: row.refType,
    refId: row.refId,
    status: row.status === 'done' ? 'done' : 'open', // 行内值由本适配器唯一写入
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
  };
}

export class PgTodoStore implements TodoStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTodoInput): Promise<TodoItem> {
    const row = await this.prisma.todoRecord.create({
      data: {
        id: uuidv7(), // 应用侧权威生成（本包 id 策略）
        tenantId: input.tenant,
        assigneeId: input.assignee,
        title: input.title,
        source: input.source,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        status: 'open',
        dueAt: input.dueAt === null || input.dueAt === undefined ? null : new Date(input.dueAt),
      },
    });
    return toTodoItem(row);
  }

  async listOwn(tenant: TenantId, assignee: UserId): Promise<readonly TodoItem[]> {
    const rows = await this.prisma.todoRecord.findMany({
      where: { tenantId: tenant, assigneeId: assignee },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(toTodoItem);
  }

  async findOwn(tenant: TenantId, assignee: UserId, id: string): Promise<TodoItem | null> {
    const row = await this.prisma.todoRecord.findFirst({
      where: { tenantId: tenant, assigneeId: assignee, id },
    });
    return row === null ? null : toTodoItem(row);
  }

  async complete(tenant: TenantId, assignee: UserId, id: string): Promise<TodoItem | null> {
    // 幂等：已 done 的行 updateMany 零变更（同值写入），原样读回。
    const updated = await this.prisma.todoRecord.updateMany({
      where: { tenantId: tenant, assigneeId: assignee, id, status: 'open' },
      data: { status: 'done' satisfies TodoStatus },
    });
    if (updated.count === 0) {
      // 未命中：要么不存在，要么非本人（双键已滤），要么已 done——统一走读回。
      const row = await this.prisma.todoRecord.findFirst({
        where: { tenantId: tenant, assigneeId: assignee, id },
      });
      return row === null ? null : toTodoItem(row);
    }
    return this.findOwn(tenant, assignee, id);
  }
}

export interface WorkbenchStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：待办端口实现 + 优雅断连。 */
export interface WorkbenchStoreHandle {
  readonly todoStore: TodoStore;
  disconnect(): Promise<void>;
}

/** 构造工作台 PG 存储装配（惰性连接：同 `./org`）。 */
export function connectWorkbenchStore(
  options: WorkbenchStoreOptions = {},
): WorkbenchStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    todoStore: new PgTodoStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
