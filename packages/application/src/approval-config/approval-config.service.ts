/**
 * ApprovalConfigService —— 审批配置用例（T 波 #102，approval 域）。
 *
 * 零框架业务类（不 import @nestjs/*）：输入解析（engine-flow 唯一权威校验）、
 * 端口委托、404 翻译、flowId 不可变守卫与校验端点（不落库的试写）。
 * 权限门禁不在用例层（路由 @RequirePermission + AuthGuard 已收口）。
 */
import type { TenantId } from '@smes/business-core';
import type { ApprovalFlowConfig } from '@smes/engine-flow';
import {
  ApprovalConfigInputError,
  ApprovalConfigNotFoundError,
} from './approval-config-errors.js';
import { parseFlowConfig, parseFlowConfigIdParam } from './approval-config-input.js';
import type {
  ApprovalFlowConfigRecord,
  ApprovalFlowConfigStore,
} from './approval-config-stores.js';

export class ApprovalConfigService {
  constructor(private readonly store: ApprovalFlowConfigStore) {}

  /**
   * 创建流配置：body = { name?, config, active? }——config 必填为配置文档全文，
   * flowId 取 config.flowId（行业务键与文档内标识一体，不接受旁路指定）；
   * name 缺省 = flowId。active 缺省/true = 创建即启用（租户内单启用收口：
   * 其余 active 行同批置 false，见 activate）；显式 active=false = 建为草稿。
   */
  async createFlow(tenant: TenantId, input: unknown): Promise<ApprovalFlowConfigRecord> {
    const body = requireBodyObject(input, '创建流配置请求体');
    if (body['config'] === undefined) {
      throw new ApprovalConfigInputError('创建流配置须提供 config（配置文档全文）');
    }
    const config = parseFlowConfig(body['config']);
    const name =
      typeof body['name'] === 'string' && body['name'].trim().length > 0
        ? body['name'].trim()
        : config.flowId;
    const active = body['active'] === undefined ? true : body['active'];
    if (typeof active !== 'boolean') {
      throw new ApprovalConfigInputError(`active 须为布尔：${JSON.stringify(active)}`);
    }
    const created = await this.store.create({ tenant, flowId: config.flowId, name, config, active });
    return active ? ((await this.store.activate(tenant, created.id)) ?? created) : created;
  }

  async listFlows(tenant: TenantId): Promise<readonly ApprovalFlowConfigRecord[]> {
    return this.store.list(tenant);
  }

  async getFlow(tenant: TenantId, idParam: string): Promise<ApprovalFlowConfigRecord> {
    const id = parseFlowConfigIdParam(idParam);
    const found = await this.store.find(tenant, id);
    if (found === null) {
      throw new ApprovalConfigNotFoundError(`租户 '${tenant}' 内不存在流配置 '${id}'`);
    }
    return found;
  }

  /**
   * 期望态更新：未提供的键不变；config 提供即整文档替换（重走权威校验），
   * 且新 config.flowId 必须与行 flowId 一致（案件行按 flowId 引用配置，
   * 换标识 = 悬挂引用，拒绝）。
   */
  async updateFlow(
    tenant: TenantId,
    idParam: string,
    input: unknown,
  ): Promise<ApprovalFlowConfigRecord> {
    const id = parseFlowConfigIdParam(idParam);
    const body = requireBodyObject(input, '更新流配置请求体');
    if (body['flowId'] !== undefined) {
      throw new ApprovalConfigInputError('流配置 flowId 不可更新（案件行按 flowId 引用配置）');
    }
    const current = await this.store.find(tenant, id);
    if (current === null) {
      throw new ApprovalConfigNotFoundError(`租户 '${tenant}' 内不存在流配置 '${id}'`);
    }

    const patch: { name?: string; config?: ApprovalFlowConfig; active?: boolean } = {};
    if (body['name'] !== undefined) {
      if (
        typeof body['name'] !== 'string' ||
        body['name'].trim().length === 0 ||
        body['name'].length > 128
      ) {
        throw new ApprovalConfigInputError(
          `name 须为 1~128 个非空白字符：${JSON.stringify(body['name'])}`,
        );
      }
      patch.name = body['name'].trim();
    }
    if (body['config'] !== undefined) {
      const config = parseFlowConfig(body['config']);
      if (config.flowId !== current.flowId) {
        throw new ApprovalConfigInputError(
          `config.flowId 不可更换：行 flowId '${current.flowId}'，新配置 '${config.flowId}'（案件行按 flowId 引用配置）`,
        );
      }
      patch.config = config;
    }
    if (body['active'] !== undefined) {
      if (typeof body['active'] !== 'boolean') {
        throw new ApprovalConfigInputError(`active 须为布尔：${JSON.stringify(body['active'])}`);
      }
      patch.active = body['active'];
    }

    const updated = await this.store.update(tenant, id, patch);
    if (updated === null) {
      throw new ApprovalConfigNotFoundError(`租户 '${tenant}' 内不存在流配置 '${id}'`);
    }
    return updated;
  }

  /**
   * 启用指定流（T1 接线 #102"启用指定版本"）：目标行置 active=true，租户内
   * 其余 active 行同批置 false（单启用收口——运行时解析器按"active 行"取
   * 生效配置）。启用历史版本 = 调用方先取 history[i].config 再走 updateFlow
   * 的整文档替换（同一校验路径，当前配置自动入历史）。
   */
  async activateFlow(tenant: TenantId, idParam: string): Promise<ApprovalFlowConfigRecord> {
    const id = parseFlowConfigIdParam(idParam);
    const activated = await this.store.activate(tenant, id);
    if (activated === null) {
      throw new ApprovalConfigNotFoundError(`租户 '${tenant}' 内不存在流配置 '${id}'`);
    }
    return activated;
  }

  /**
   * 校验端点（不落库的试写）：body = 配置文档全文；合法返回固化配置摘要，
   * 非法抛 ApprovalConfigInputError（400）。供管理端保存前预检。
   */
  async validateFlow(input: unknown): Promise<{ valid: true; flowId: string }> {
    const config = parseFlowConfig(input);
    return { valid: true, flowId: config.flowId };
  }
}

function requireBodyObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApprovalConfigInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}
