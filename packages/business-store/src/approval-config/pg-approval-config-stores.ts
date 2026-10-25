/**
 * ApprovalFlowConfigStore 的 PG 实现 + 组合根装配工厂（T 波 #102，经本包
 * `./approval-config` 子路径导出——与 `./masterdata` 同模式；子路径登记归
 * 合流）。
 *
 * 启动零 DB 依赖：connectApprovalConfigStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂（回落 application 内存实现）。
 *
 * JSONB 往返取舍：config 列存 engine-flow ApprovalFlowConfig 全文；读出经
 * application 侧 parseFlowConfig（defineApprovalFlowConfig 固化复核）——
 * 损坏配置 fail-fast 抛 ApprovalConfigInputError，不带病返回（深冻结快照
 * 在 PG 侧不可持久，固化复核即读出重建）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId } from '@smes/business-core';
import type { ApprovalFlowConfig } from '@smes/engine-flow';
import {
  ApprovalConfigConflictError,
  parseFlowConfig,
  APPROVAL_CONFIG_HISTORY_LIMIT,
  type ApprovalFlowConfigRecord,
  type ApprovalFlowConfigStore,
  type ApprovalFlowConfigVersion,
  type CreateApprovalFlowConfigInput,
  type UpdateApprovalFlowConfigInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

/** 唯一键冲突（P2002）-> 域冲突错误；其余原样上抛（不吞连接错误）。 */
function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ApprovalConfigConflictError(message);
  }
  return error;
}

interface ApprovalFlowConfigDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly flowId: string;
  readonly name: string;
  readonly config: unknown;
  readonly active: boolean;
  readonly history: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 历史快照数组读出：null/损坏形状 = 空历史（旧行无列值时的诚实缺省）。 */
function parseHistory(value: unknown): ApprovalFlowConfigVersion[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ApprovalConfigConflictError(`history[${index}] 形状非法（非对象）`);
    }
    const record = entry as Record<string, unknown>;
    const savedAt = record['savedAt'];
    if (typeof savedAt !== 'string' || savedAt.length === 0) {
      throw new ApprovalConfigConflictError(`history[${index}].savedAt 非法`);
    }
    return { config: parseFlowConfig(record['config']), savedAt };
  });
}

function toRecord(row: ApprovalFlowConfigDbRow): ApprovalFlowConfigRecord {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    flowId: row.flowId,
    name: row.name,
    // 读出固化复核：JSONB → defineApprovalFlowConfig（损坏 fail-fast，见文件头）
    config: parseFlowConfig(row.config),
    active: row.active,
    history: parseHistory(row.history),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgApprovalFlowConfigStore implements ApprovalFlowConfigStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateApprovalFlowConfigInput): Promise<ApprovalFlowConfigRecord> {
    try {
      const row = await this.prisma.approvalFlowConfigRecord.create({
        data: {
          id: uuidv7(), // 应用侧权威生成（本包 id 策略）
          tenantId: input.tenant,
          flowId: input.flowId,
          name: input.name,
          config: input.config as object,
          active: input.active ?? true,
          history: [],
        },
      });
      return toRecord(row);
    } catch (error) {
      throw toConflict(
        error,
        `流标识 '${input.flowId}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly ApprovalFlowConfigRecord[]> {
    const rows = await this.prisma.approvalFlowConfigRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { flowId: 'asc' },
    });
    return rows.map(toRecord);
  }

  async find(tenant: TenantId, id: string): Promise<ApprovalFlowConfigRecord | null> {
    const row = await this.prisma.approvalFlowConfigRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toRecord(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateApprovalFlowConfigInput,
  ): Promise<ApprovalFlowConfigRecord | null> {
    // 历史维护在应用侧先行读改写（PG JSONB 无数组追加原语；管理面低频写，
    // 读改写竞窗由 updatedAt 期望值兜底不叠加——端口合同只承诺单客户端语义）。
    const current = await this.find(tenant, id);
    if (current === null) return null;
    const history =
      input.config !== undefined && input.config !== current.config
        ? [
            ...current.history,
            { config: current.config, savedAt: current.updatedAt },
          ].slice(-APPROVAL_CONFIG_HISTORY_LIMIT)
        : current.history;
    // Prisma Json 写入面：配置文档/历史快照是深冻结对象（无索引签名），经
    // 结构化克隆转普通 JSON 值（同 config 列写法——冻结快照不可持久，读出
    // 侧 parseFlowConfig 固化复核重建）。
    const historyPayload: unknown = structuredClone(history);
    try {
      const row = await this.prisma.approvalFlowConfigRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.config !== undefined ? { config: input.config as object } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          history: historyPayload as object,
        },
      });
      return toRecord(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  async activate(tenant: TenantId, id: string): Promise<ApprovalFlowConfigRecord | null> {
    try {
      const row = await this.prisma.approvalFlowConfigRecord.update({
        where: { id, tenantId: tenant },
        data: { active: true },
      });
      // 同租户其余 active 行置 false（单启用收口；竞窗内双 active 的读取侧
      // 取 flowId 升序首行，行为确定——见端口合同注释）。
      await this.prisma.approvalFlowConfigRecord.updateMany({
        where: { tenantId: tenant, id: { not: id }, active: true },
        data: { active: false },
      });
      return toRecord(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

export interface ApprovalConfigStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：审批流配置端口实现 + 优雅断连。 */
export interface ApprovalConfigStoreHandle {
  readonly flowConfigStore: ApprovalFlowConfigStore;
  disconnect(): Promise<void>;
}

/** 构造审批流配置 PG 存储装配（惰性连接：见文件头）。 */
export function connectApprovalConfigStore(
  options: ApprovalConfigStoreOptions = {},
): ApprovalConfigStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    flowConfigStore: new PgApprovalFlowConfigStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}

/** 深冻结配置的 JSONB 载荷形状（写库时 Prisma 只收可序列化值，冻结不影响）。 */
export type StoredFlowConfig = ApprovalFlowConfig;
