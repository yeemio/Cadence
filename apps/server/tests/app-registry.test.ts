import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  makeCommandEnvelope,
  OperationId,
  TenantId,
  UserId,
  type CommandEnvelope,
} from '@smes/business-core';
import { WorkOrderService } from '@smes/application';
import { AuthGuard } from '../src/auth.guard.js';
import { DevPolicyController } from '../src/dev-policy.controller.js';
import {
  DEFAULT_MODULES_ENABLED,
  MODULE_DEFINITIONS,
  ModuleRegistryError,
  REQUIRED_MODULE,
  buildAppModule,
  parseModulesEnabled,
  partsApprovalChainFromEnv,
} from '../src/app-registry.js';

describe('应用注册表（ADR-0004 feature flag 装配）', () => {
  it('MODULES_ENABLED 未设置 → 默认装配六模块 core,org,masterdata,workbench,approval,demo（core 置首，M1 收尾波-① 口径）', () => {
    expect(parseModulesEnabled(undefined)).toEqual(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']);
    expect(parseModulesEnabled(null)).toEqual(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']);
  });

  it("MODULES_ENABLED='core' → 只装配 core，org/masterdata/workbench/approval/demo 停用", () => {
    expect(parseModulesEnabled('core')).toEqual(['core']);
  });

  it('容忍空白与大小写，去重，core 恒置首（其余按输入顺序）', () => {
    expect(parseModulesEnabled(' demo, APPROVAL , ORG , CORE ,demo')).toEqual(['core', 'demo', 'approval', 'org']);
    expect(parseModulesEnabled('CORE')).toEqual(['core']);
  });

  it('缺 core → 拒绝启动（必装基础层，ADR-0004）', () => {
    expect(() => parseModulesEnabled('demo')).toThrow(ModuleRegistryError);
    expect(() => parseModulesEnabled('demo')).toThrow(/core/);
  });

  it('未知模块 → 拒绝并列出可用清单（拼写错误不静默）', () => {
    // 样例名刻意避开真实/规划模块名（workorder/baseline 自 M2 Wave-1 起已注册）
    expect(() => parseModulesEnabled('core,unknownmod')).toThrow(/unknownmod/);
  });

  it('显式置空 → 拒绝启动', () => {
    expect(() => parseModulesEnabled('')).toThrow(ModuleRegistryError);
    expect(() => parseModulesEnabled('  ')).toThrow(ModuleRegistryError);
  });

  it('buildAppModule 返回可交给 NestFactory.create 的根模块类', () => {
    const root = buildAppModule(parseModulesEnabled(undefined));
    expect(typeof root).toBe('function');
  });

  it('注册表常量与 ADR-0004 对齐（六模块默认装配：approval 进默认集，M1 收尾波-①）', () => {
    expect(REQUIRED_MODULE).toBe('core');
    expect(DEFAULT_MODULES_ENABLED).toBe('core,org,masterdata,workbench,approval,demo');
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'org')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'masterdata')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'workbench')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'approval')).toBe(true);
  });

  it('组合根恒注册全局鉴权守卫（APP_GUARD -> AuthGuard，M1 增量 2-B）', () => {
    const root = buildAppModule(parseModulesEnabled(undefined));
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, root) as unknown[];
    const guard = providers.find(
      (p) => (p as { provide?: unknown }).provide === APP_GUARD,
    ) as { useClass?: unknown } | undefined;
    expect(guard?.useClass).toBe(AuthGuard);
  });

  it('策略注入测试钩子默认不装配；显式开启才挂 DevPolicyController', () => {
    const controllersOf = (root: object): unknown[] =>
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, root) as unknown[];
    expect(controllersOf(buildAppModule(parseModulesEnabled(undefined)))).not.toContain(
      DevPolicyController,
    );
    expect(
      controllersOf(buildAppModule(parseModulesEnabled(undefined), { devPolicyEndpoint: true })),
    ).toContain(DevPolicyController);
  });

  it('S1 backfill：audit/standardreports 已注册但不进默认清单（激活价语义，同 M2/M3 环节模块口径）', () => {
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'audit')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'standardreports')).toBe(true);
    expect(parseModulesEnabled(undefined)).not.toContain('audit');
    expect(parseModulesEnabled(undefined)).not.toContain('standardreports');
    expect(parseModulesEnabled('core,org,masterdata,audit,standardreports')).toEqual([
      'core',
      'org',
      'masterdata',
      'audit',
      'standardreports',
    ]);
  });

  it('S1 backfill：操作日志写拦截器随 audit 模块条件装配（未启用零开销，同 HoursIngestLinkInterceptor 先例）', async () => {
    const { APP_INTERCEPTOR } = await import('@nestjs/core');
    const { AuditWriteInterceptor } = await import('@smes/application');
    const providersOf = (root: object): unknown[] =>
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, root) as unknown[];
    const hasAuditInterceptor = (providers: unknown[]): boolean =>
      providers.some(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          (p as { provide?: unknown }).provide === APP_INTERCEPTOR &&
          (p as { useClass?: unknown }).useClass === AuditWriteInterceptor,
      );
    expect(hasAuditInterceptor(providersOf(buildAppModule(parseModulesEnabled(undefined))))).toBe(
      false,
    );
    expect(
      hasAuditInterceptor(
        providersOf(buildAppModule(['core', 'org', 'masterdata', 'audit'])),
      ),
    ).toBe(true);
  });
});

// ---- D-25：S6 配件多级审批链 env 装配面（retest-59c9f8d） ----

const D25_TENANT = TenantId.create('t-d25');
const D25_MANAGER = UserId.create('pm-d25');
const D25_LEVEL2_ROLE = 'parts-manager';
const D25_LEVEL3_ROLE = 'parts-leader';

/** D-25 起服上下文回收（同 u-wave-wiring.test 体例）。 */
const d25Contexts: INestApplicationContext[] = [];

afterAll(async () => {
  for (const context of d25Contexts) await context.close();
});

/** 直构命令信封（口径同 application workorder 测试，issuedAt 固定可复现）。 */
function d25Envelope(
  kind: string,
  payload: Record<string, unknown>,
  options: { readonly actor?: typeof D25_MANAGER; readonly expectedRevision?: number | 'initial' } = {},
): CommandEnvelope<{ kind: never; payload: Record<string, unknown> }> {
  return makeCommandEnvelope({
    tenantId: D25_TENANT,
    issuedBy: options.actor ?? D25_MANAGER,
    operationId: OperationId.create(`d25-${kind}-${Math.random().toString(36).slice(2, 10)}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: '2026-10-26T10:00:00.000Z',
    command: { kind, payload } as never,
  }) as CommandEnvelope<{ kind: never; payload: Record<string, unknown> }>;
}

/** env 临时覆写（try/finally 原样还原；undefined = 删除键）。 */
async function withEnv(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key] as string;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('D-25：配件审批链 env 面（SMES_PARTS_APPROVAL_LEVELS + 角色码）', () => {
  it('纯解析面：缺省 undefined 零回归；2/3 级须角色；非法级数/缺角色/坏角色码 fail-fast', () => {
    expect(partsApprovalChainFromEnv({})).toBeUndefined();
    expect(partsApprovalChainFromEnv({ SMES_PARTS_APPROVAL_LEVELS: '' })).toBeUndefined();
    expect(partsApprovalChainFromEnv({ SMES_PARTS_APPROVAL_LEVELS: '1' })).toEqual({ levels: 1 });
    expect(
      partsApprovalChainFromEnv({
        SMES_PARTS_APPROVAL_LEVELS: '2',
        SMES_PARTS_LEVEL2_ROLE: D25_LEVEL2_ROLE,
      }),
    ).toEqual({ levels: 2, level2Role: D25_LEVEL2_ROLE });
    expect(
      partsApprovalChainFromEnv({
        SMES_PARTS_APPROVAL_LEVELS: '3',
        SMES_PARTS_LEVEL2_ROLE: D25_LEVEL2_ROLE,
        SMES_PARTS_LEVEL3_ROLE: D25_LEVEL3_ROLE,
      }),
    ).toEqual({ levels: 3, level2Role: D25_LEVEL2_ROLE, level3Role: D25_LEVEL3_ROLE });

    // fail-fast：非法级数 / 多级缺角色（不静默回落单级）。
    expect(() => partsApprovalChainFromEnv({ SMES_PARTS_APPROVAL_LEVELS: '4' })).toThrow(
      ModuleRegistryError,
    );
    expect(() => partsApprovalChainFromEnv({ SMES_PARTS_APPROVAL_LEVELS: '2' })).toThrow(
      ModuleRegistryError,
    );
    expect(() =>
      partsApprovalChainFromEnv({
        SMES_PARTS_APPROVAL_LEVELS: '3',
        SMES_PARTS_LEVEL2_ROLE: D25_LEVEL2_ROLE,
      }),
    ).toThrow(ModuleRegistryError);
    // 非法角色码形状（definePartsApprovalChain 纪律经包装错误透出）。
    expect(() =>
      partsApprovalChainFromEnv({
        SMES_PARTS_APPROVAL_LEVELS: '2',
        SMES_PARTS_LEVEL2_ROLE: 'Bad Role',
      }),
    ).toThrow(ModuleRegistryError);
  });

  it('装配面：levels=3 → 三级链经组合根注入生效（一级过进 level2_review，角色码读面可见）', async () => {
    await withEnv(
      {
        SMES_PARTS_APPROVAL_LEVELS: '3',
        SMES_PARTS_LEVEL2_ROLE: D25_LEVEL2_ROLE,
        SMES_PARTS_LEVEL3_ROLE: D25_LEVEL3_ROLE,
      },
      async () => {
        const context = await NestFactory.create(buildAppModule(['core', 'workorder'], {}), {
          logger: ['error', 'warn'],
        });
        d25Contexts.push(context);
        const service = context.get(WorkOrderService, { strict: false });

        // 建令（负责人 pm-d25 = 一级审批人）+ 配件申请（自动 SUBMIT → submitted v2）。
        const created = await service.execute(
          d25Envelope('workorder.create.v1', {
            projectName: 'D-25 三级链装配项目',
            manager: 'pm-d25',
            plannedDeliveryAt: '2026-11-01T00:00:00.000Z',
          }),
        );
        expect(created.status).toBe('committed');
        const orderId = (created as { readonly workOrder?: { readonly id: string } }).workOrder!.id;
        const requested = await service.execute(
          d25Envelope(
            'workorder.parts.request.v1',
            { workOrderId: orderId, itemId: 'item-d25', quantity: 2 },
            { actor: UserId.create('worker-d25') },
          ),
        );
        expect(requested.status).toBe('committed');
        const request = (requested as { readonly partsRequest?: { readonly id: string; readonly state: string } })
          .partsRequest!;
        expect(request.state).toBe('submitted');

        // 一级（负责人）通过 → level2_review（多级链流配置经装配注入生效——
        // 缺省单级此处直接 approved，状态即链级数的可观察判据）。
        const level1 = await service.execute(
          d25Envelope(
            'workorder.parts.approve.v1',
            { decision: 'approve', remark: '一级通过' },
            { expectedRevision: 2 },
          ),
          request.id,
        );
        expect(level1.status).toBe('committed');
        expect((level1 as { readonly partsRequest?: { readonly state: string } }).partsRequest!.state).toBe('level2_review');

        // 读面：待审批人实时解析打到 env 角色（零 DB org 目录无人 → 名单空带
        // 角色说明——角色码经装配链路可见，不落库口径同 S6）。
        const detail = await service.partsDetail(D25_TENANT, request.id);
        expect(detail.pendingApproval?.level).toBe(2);
        expect(detail.pendingApproval?.approvers).toEqual([]);
        expect(detail.pendingApproval?.note).toContain(D25_LEVEL2_ROLE);
        await context.close();
      },
    );
  });

  it('装配面：env 缺省 → 单级零回归（负责人一级通过即 approved）；多级配错启动即炸', async () => {
    await withEnv(
      {
        SMES_PARTS_APPROVAL_LEVELS: undefined,
        SMES_PARTS_LEVEL2_ROLE: undefined,
        SMES_PARTS_LEVEL3_ROLE: undefined,
      },
      async () => {
        const context = await NestFactory.create(buildAppModule(['core', 'workorder'], {}), {
          logger: ['error', 'warn'],
        });
        d25Contexts.push(context);
        const service = context.get(WorkOrderService, { strict: false });
        const created = await service.execute(
          d25Envelope('workorder.create.v1', {
            projectName: 'D-25 缺省零回归项目',
            manager: 'pm-d25',
            plannedDeliveryAt: '2026-11-01T00:00:00.000Z',
          }),
        );
        const orderId = (created as { readonly workOrder?: { readonly id: string } }).workOrder!.id;
        const requested = await service.execute(
          d25Envelope(
            'workorder.parts.request.v1',
            { workOrderId: orderId, itemId: 'item-d25', quantity: 1 },
            { actor: UserId.create('worker-d25') },
          ),
        );
        const requestId = (requested as { readonly partsRequest?: { readonly id: string } })
          .partsRequest!.id;
        const approved = await service.execute(
          d25Envelope(
            'workorder.parts.approve.v1',
            { decision: 'approve', remark: '一级即终' },
            { expectedRevision: 2 },
          ),
          requestId,
        );
        expect(approved.status).toBe('committed');
        expect((approved as { readonly partsRequest?: { readonly state: string } }).partsRequest!.state).toBe('approved');
        await context.close();
      },
    );

    // fail-fast：LEVELS=2 缺角色 env → buildAppModule（workorder 工厂期）即抛。
    await withEnv({ SMES_PARTS_APPROVAL_LEVELS: '2', SMES_PARTS_LEVEL2_ROLE: undefined }, async () => {
      expect(() => buildAppModule(['core', 'workorder'], {})).toThrow(ModuleRegistryError);
      expect(() => buildAppModule(['core', 'workorder'], {})).toThrow(/SMES_PARTS_LEVEL2_ROLE/);
    });
  });
});
