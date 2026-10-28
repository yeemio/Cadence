/**
 * ai-query 会话存储的内存先行实现（重启即失；PG 实现属后续波次——首版会话
 * 为轻量线程历史，无跨进程持久化需求）。
 *
 * 读按租户收口；listByOwner 再按 userId 收口（"仅本人"数据权限边界）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { AiQuerySession, AiQuerySessionStore, AiQuerySessionSummary } from './ai-query-ports.js';

export class InMemoryAiQuerySessionStore implements AiQuerySessionStore {
  private readonly sessions = new Map<string, AiQuerySession>();

  private keyOf(tenant: TenantId, sessionId: string): string {
    return `${tenant}|${sessionId}`;
  }

  async create(input: {
    readonly sessionId: string;
    readonly tenant: TenantId;
    readonly userId: UserId;
    readonly createdAt: string;
  }): Promise<AiQuerySession> {
    const session: AiQuerySession = {
      sessionId: input.sessionId,
      tenant: input.tenant,
      userId: input.userId,
      createdAt: input.createdAt,
      lastActivityAt: input.createdAt,
      turns: [],
    };
    this.sessions.set(this.keyOf(input.tenant, input.sessionId), session);
    return session;
  }

  async find(tenant: TenantId, sessionId: string): Promise<AiQuerySession | null> {
    return this.sessions.get(this.keyOf(tenant, sessionId)) ?? null;
  }

  async listByOwner(tenant: TenantId, userId: UserId, limit: number): Promise<readonly AiQuerySessionSummary[]> {
    const summaries: AiQuerySessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session.tenant !== tenant || session.userId !== userId) continue;
      summaries.push({
        sessionId: session.sessionId,
        lastActivityAt: session.lastActivityAt,
        turnCount: session.turns.length,
      });
    }
    summaries.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
    return summaries.slice(0, limit);
  }

  async save(session: AiQuerySession): Promise<void> {
    this.sessions.set(this.keyOf(session.tenant, session.sessionId), session);
  }
}
