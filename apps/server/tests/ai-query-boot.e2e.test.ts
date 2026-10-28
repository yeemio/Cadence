/**
 * AI 问数 boot e2e（CONTRACT v1 · 2026-10-28，WP-B 组合验收）：零 DB 真实
 * 起服（Nest 组合根 → express HTTP → fetch 读回），体例沿 screen-boot.e2e /
 * boot.e2e——MODULES_ENABLED='core,ai-query' 激活价形态（不进默认清单）。
 *
 * 机器断言（CONTRACT §Wire / §三域能力 / §意图路由）：
 *  - /modules 含 ai-query（激活价）；
 *  - 门禁同构：零凭据 401 / 无策略身份 403（AuthGuard 判 ai-query:read）；
 *  - permissionResolver 真实 casbin 链：全码身份（ai-query:read + 三域码经
 *    POST /dev/policies 逐码授予，非 admin bypass）→ ask 200 answer；仅有
 *    ai-query:read 缺域码 → kind:'denied' + missingPermissions 逐码明示；
 *  - ask happy：material-gap（种工作令+齐套核对记录）/ quality-inspection
 *    （种窗口内 failed 检验单）走通；workorder-progress 经澄清回放（零进度
 *    事实 = 合法零行 answer）；
 *  - 澄清分支：编号多匹配（两候选选项）与无时间词（时间范围四选项）+
 *    selectedOptionId 回放续走；
 *  - capabilities 200；sessions 列表/详情；跨用户读会话 404（不泄漏存在性）；
 *  - AiQueryErrorFilter：空 question 400 / 未知会话 404（code ai_query.*）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import {
  InMemoryGapCheckStore,
  InMemoryInspectionOrderStore,
  InMemoryUserStore,
  InMemoryWorkOrderStore,
  TenantContext,
} from '@smes/application';
import { InspectionId, TenantId, WorkOrderId } from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { AiQueryErrorFilter } from '../src/ai-query-error.filter.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';

/** 种子工作令 id（token 小写归一后与提问内嵌编号互含）。 */
const WO_1 = 'wo-aiq-2026-001';
const WO_2 = 'wo-aiq-2026-002';

describe('AI 问数组合态（零 DB，core+ai-query）', () => {
  let baseUrl = '';
  let opId = '';
  let partialId = '';
  let otherId = '';
  let viewId = '';
  /** happy 用例（material-gap）产出的会话 id——会话详情/跨用户 404 断言锚点。 */
  let gapSessionId = '';
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    setEnv('MODULES_ENABLED', 'core,ai-query');
    setEnv('DATABASE_URL', undefined); // 零 DB：源模块未启用，三域 store 走组合根内存缺省
    setEnv('SMES_DEV_AUTH', 'on'); // dev 身份回落（测试钩子；生产形态默认关）

    const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
    const tenant = TenantId.create('default');

    // 种用户：全码问数人 op（逐码授予，证明判定链取的是 casbin 逐码判定而非
    // admin bypass）/ 无策略 viewer / 仅有 ai-query:read 的 partial / 另一会话
    // 归属人 other（跨用户 404 用，有 ai-query:read 过守卫）。
    const sharedUserStore = new InMemoryUserStore();
    const op = await sharedUserStore.create({
      tenant,
      username: 'aiq-op',
      displayName: 'AI问数e2e全码操作员',
    });
    const partial = await sharedUserStore.create({
      tenant,
      username: 'aiq-partial',
      displayName: 'AI问数e2e缺域码用户',
    });
    const other = await sharedUserStore.create({
      tenant,
      username: 'aiq-other',
      displayName: 'AI问数e2e跨用户读会话人',
    });
    const view = await sharedUserStore.create({ tenant, username: 'aiq-view', displayName: 'AI问数e2e无策略访客' });
    opId = op.id;
    partialId = partial.id;
    otherId = other.id;
    viewId = view.id;

    // 种最小业务数据（InMemory store 直种，经 buildAppModule options 注入即生效）：
    // 两张工作令（多匹配澄清用）+ 一条齐套核对记录（material-gap happy）+
    // 一张窗口内 failed 检验单（quality-inspection happy，judgedAt=now 落今日窗）。
    const workOrderStore = new InMemoryWorkOrderStore();
    for (const [id, projectName] of [
      [WO_1, 'AI问数E2E项目一'],
      [WO_2, 'AI问数E2E项目二'],
    ] as const) {
      await workOrderStore.create({
        tenant,
        id: WorkOrderId.create(id),
        flowConfigId: 'workorder-default',
        state: 'released',
        objectVersion: 1,
        customerRef: null,
        projectName,
        salesRep: null,
        manager: null,
        plannedDeliveryAt: null,
        packagingArrivalAt: null,
      });
    }
    const listingGapStore = new InMemoryGapCheckStore();
    await listingGapStore.append({
      tenant,
      id: 'gap-aiq-1',
      workOrderId: WO_1,
      kinds: [{ kind: 'part', lineCount: 1, checkedLineCount: 1, gapLineCount: 1, complete: false }],
      gapLines: [
        {
          kind: 'part',
          listingLineId: 'line-aiq-1',
          itemId: 'item-aiq-1',
          drawingNo: 'DWG-AIQ-01',
          requiredQty: 10,
          availableQty: 4,
          gapQty: 6,
          neededBy: '2026-11-05',
        },
      ],
      complete: false,
      checkedBy: op.id,
    });
    const inspectionOrderStore = new InMemoryInspectionOrderStore();
    const inspectionId = InspectionId.create('insp-aiq-1');
    await inspectionOrderStore.create({
      tenant,
      id: inspectionId,
      flowConfigId: 'inspection-default',
      state: 'pending',
      objectVersion: 1,
      kind: 'standard_purchase',
      sourceType: null,
      sourceRefId: null,
      itemId: 'item-aiq-1',
      drawingNo: 'DWG-AIQ-01',
      quantity: 10,
    });
    await inspectionOrderStore.advance(tenant, inspectionId, 1, 'failed', 2, {
      passedQty: 9,
      failedQty: 1,
      judgeRemark: 'e2e 判定不合格',
      judgedBy: op.id,
      judgedAt: new Date().toISOString(),
      closeDueAt: null,
    });

    app = await NestFactory.create(
      buildAppModule(enabled, {
        devPolicyEndpoint: true,
        userStore: sharedUserStore,
        workOrderStore,
        listingGapStore,
        inspectionOrderStore,
      }),
      { logger: ['error', 'warn'] },
    );
    app.useGlobalFilters(new AuthErrorFilter(), new DomainErrorFilter(), new AiQueryErrorFilter());
    const tenantContext = app.get(TenantContext);
    app.use((request: unknown, _response: unknown, next: () => void) => {
      tenantContext.run(tenantContext.resolve(request), () => next());
    });
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    // 策略注入钩子（screen-boot 同体例）：逐码授予（非 admin bypass）——
    // op 全四码；partial/other 仅有 ai-query:read（denied/跨用户 404 分支用）。
    const granted = await fetch(`${baseUrl}/dev/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smes-user': opId },
      body: JSON.stringify({
        rules: [
          { kind: 'grant-role', tenant: 'default', user: opId, role: 'aiq-full' },
          { kind: 'grant-permission', tenant: 'default', role: 'aiq-full', resource: 'ai-query', action: 'read' },
          { kind: 'grant-permission', tenant: 'default', role: 'aiq-full', resource: 'workorder', action: 'read' },
          { kind: 'grant-permission', tenant: 'default', role: 'aiq-full', resource: 'listing', action: 'read' },
          { kind: 'grant-permission', tenant: 'default', role: 'aiq-full', resource: 'inspection', action: 'read' },
          { kind: 'grant-role', tenant: 'default', user: partialId, role: 'aiq-basic' },
          { kind: 'grant-role', tenant: 'default', user: otherId, role: 'aiq-basic' },
          { kind: 'grant-permission', tenant: 'default', role: 'aiq-basic', resource: 'ai-query', action: 'read' },
        ],
      }),
    });
    expect(granted.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const headersOf = (user: string): Record<string, string> => ({
    'content-type': 'application/json',
    'x-smes-user': user,
  });

  /**
   * ask 成功态状态码：合同 §Wire 冻结 200（denied 也在回答通道内 200 明示）。
   * WP-A 已在 ask 处理器补 @HttpCode(200)（Nest @Post 缺省 201 已消除）——
   * 此处严格断言 200；错误态映射（400/404/409）同恒严格断言。
   */
  const expectAskOk = (status: number): void => {
    expect(status).toBe(200);
  };

  const ask = async (user: string | null, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/ai-query/ask`, {
      method: 'POST',
      headers: user === null ? { 'content-type': 'application/json' } : headersOf(user),
      body: JSON.stringify(body),
    });

  it('ai-query 进 /modules 清单（激活价语义，不进默认装配）', async () => {
    const modules = await fetch(`${baseUrl}/modules`);
    expect(modules.status).toBe(200);
    expect(await modules.json()).toEqual({ modules: ['core', 'ai-query'] });
  });

  it('门禁同构：零凭据 401；身份有效但无 ai-query:read 策略 403', async () => {
    const anonymousCapabilities = await fetch(`${baseUrl}/ai-query/capabilities`);
    expect(anonymousCapabilities.status).toBe(401);
    const anonymousAsk = await ask(null, { question: '今天检验有哪些不合格' });
    expect(anonymousAsk.status).toBe(401);

    const viewerCapabilities = await fetch(`${baseUrl}/ai-query/capabilities`, {
      headers: headersOf(viewId),
    });
    expect(viewerCapabilities.status).toBe(403);
    const viewerAsk = await ask(viewId, { question: '今天检验有哪些不合格' });
    expect(viewerAsk.status).toBe(403);
  });

  it('capabilities 200：三能力目录（id/域码/ready 冻结形状）', async () => {
    const response = await fetch(`${baseUrl}/ai-query/capabilities`, { headers: headersOf(opId) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { capabilityId: string; subjectKind: string; requiredPermissions: string[]; status: string }[];
    };
    expect(body.items.map((item) => item.capabilityId).sort()).toEqual([
      'material-gap',
      'quality-inspection',
      'workorder-progress',
    ]);
    const byId = new Map(body.items.map((item) => [item.capabilityId, item]));
    expect(byId.get('workorder-progress')!.requiredPermissions).toEqual(['workorder:read']);
    expect(byId.get('material-gap')!.requiredPermissions).toEqual(['listing:read']);
    expect(byId.get('quality-inspection')!.requiredPermissions).toEqual(['inspection:read']);
    expect(body.items.every((item) => item.status === 'ready')).toBe(true);
  });

  it('ask happy：material-gap（种工作令+齐套核对记录）→ answer 三卡 + 缺口口径', async () => {
    const response = await ask(opId, { question: `${WO_1} 缺料吗` });
    expectAskOk(response.status);
    const body = (await response.json()) as {
      kind: string;
      sessionId: string;
      capabilityId: string;
      summary: string;
      caliberNotes: string[];
      factCards: { title: string; metrics: { key: string; value: string | number }[] }[];
    };
    expect(body.kind).toBe('answer');
    expect(body.capabilityId).toBe('material-gap');
    expect(body.sessionId.length).toBeGreaterThan(0);
    gapSessionId = body.sessionId;
    expect(body.factCards.map((card) => card.title)).toEqual(['物料缺口（最新齐套核对）', '缺口明细', '采购关联']);
    const complete = body.factCards[0]!.metrics.find((metric) => metric.key === 'complete');
    expect(complete?.value).toBe('存在缺口');
    expect(body.summary).toContain('存在缺口');
    expect(body.caliberNotes.length).toBeGreaterThan(0); // 口径注记原样携带（不得静默吞掉）
  });

  it('ask happy：quality-inspection（种今日 failed 检验单）→ answer 不合格 1 单', async () => {
    const response = await ask(opId, { question: '今天检验有哪些不合格' });
    expectAskOk(response.status);
    const body = (await response.json()) as {
      kind: string;
      capabilityId: string;
      factCards: { metrics: { key: string; value: string | number }[] }[];
    };
    expect(body.kind).toBe('answer');
    expect(body.capabilityId).toBe('quality-inspection');
    const failedCount = body.factCards[0]!.metrics.find((metric) => metric.key === 'failedCount');
    expect(failedCount?.value).toBe(1);
    const failedQty = body.factCards[0]!.metrics.find((metric) => metric.key === 'failedQty');
    expect(failedQty?.value).toBe(1);
  });

  it('澄清分支：编号多匹配 → clarify 两候选；selectedOptionId 回放续走（零进度事实=合法零行 answer）', async () => {
    const question = 'WO-AIQ-2026 进度做到哪了';
    const clarify = await ask(opId, { question });
    expectAskOk(clarify.status);
    const clarifyBody = (await clarify.json()) as {
      kind: string;
      sessionId: string;
      prompt: string;
      options: { id: string; label: string }[];
    };
    expect(clarifyBody.kind).toBe('clarify');
    expect(clarifyBody.options.map((option) => option.id).sort()).toEqual([WO_1, WO_2]);

    const replay = await ask(opId, { sessionId: clarifyBody.sessionId, question, selectedOptionId: WO_1 });
    expectAskOk(replay.status);
    const replayBody = (await replay.json()) as { kind: string; capabilityId: string; summary: string };
    expect(replayBody.kind).toBe('answer');
    expect(replayBody.capabilityId).toBe('workorder-progress');
    // core+ai-query 形态 progressFacts = EMPTY_PROGRESS_PORT（零行口径，同模块缺省）：
    // 零行是合法 answer——summary 明示「查询有效、无记录」而非伪零值。
    expect(replayBody.summary).toContain('查询有效、无记录');
  });

  it('澄清分支：质检无时间词 → clarify 四时间选项；回放 today 续走', async () => {
    const question = '最近的返工情况';
    const clarify = await ask(opId, { question });
    expectAskOk(clarify.status);
    const clarifyBody = (await clarify.json()) as { kind: string; sessionId: string; options: { id: string }[] };
    expect(clarifyBody.kind).toBe('clarify');
    expect(clarifyBody.options.map((option) => option.id)).toEqual([
      'today',
      'this-week',
      'last-7-days',
      'last-30-days',
    ]);

    const replay = await ask(opId, { sessionId: clarifyBody.sessionId, question, selectedOptionId: 'today' });
    expectAskOk(replay.status);
    const replayBody = (await replay.json()) as { kind: string; capabilityId: string };
    expect(replayBody.kind).toBe('answer');
    expect(replayBody.capabilityId).toBe('quality-inspection');
  });

  it('denied 分支：有 ai-query:read 缺域码 → 回答通道内 kind denied + 逐码明示（不是 403 硬抛）', async () => {
    const gapDenied = await ask(partialId, { question: `${WO_1} 缺料吗` });
    expectAskOk(gapDenied.status);
    const gapBody = (await gapDenied.json()) as { kind: string; reason: string; missingPermissions: string[] };
    expect(gapBody.kind).toBe('denied');
    expect(gapBody.reason).toBe('no_permission');
    expect(gapBody.missingPermissions).toEqual(['listing:read']);

    const qualityDenied = await ask(partialId, { question: '今天检验有哪些不合格' });
    expectAskOk(qualityDenied.status);
    const qualityBody = (await qualityDenied.json()) as { kind: string; missingPermissions: string[] };
    expect(qualityBody.kind).toBe('denied');
    expect(qualityBody.missingPermissions).toEqual(['inspection:read']);
  });

  it('AiQueryErrorFilter：空 question 400 ai_query.invalid_input；未知会话 404 ai_query.not_found', async () => {
    const badAsk = await ask(opId, { question: '' });
    expect(badAsk.status).toBe(400);
    const badBody = (await badAsk.json()) as { statusCode: number; code: string; message: string };
    expect(badBody.statusCode).toBe(400);
    expect(badBody.code).toBe('ai_query.invalid_input');

    const missingSession = await fetch(`${baseUrl}/ai-query/sessions/no-such-session`, {
      headers: headersOf(opId),
    });
    expect(missingSession.status).toBe(404);
    const missingBody = (await missingSession.json()) as { statusCode: number; code: string };
    expect(missingBody.statusCode).toBe(404);
    expect(missingBody.code).toBe('ai_query.not_found');
  });

  it('sessions：本人列表非空且轮次 ≥1；详情回放提问与 answer 轮', async () => {
    const list = await fetch(`${baseUrl}/ai-query/sessions`, { headers: headersOf(opId) });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: { sessionId: string; turnCount: number }[] };
    expect(listBody.items.length).toBeGreaterThanOrEqual(3); // gap + 多匹配澄清 + 时间澄清 各一会话
    expect(listBody.items.every((item) => item.turnCount >= 1)).toBe(true);

    const detail = await fetch(`${baseUrl}/ai-query/sessions/${gapSessionId}`, { headers: headersOf(opId) });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { sessionId: string; turns: { question: string; kind: string }[] };
    expect(detailBody.sessionId).toBe(gapSessionId);
    expect(detailBody.turns[0]!.question).toBe(`${WO_1} 缺料吗`);
    expect(detailBody.turns[0]!.kind).toBe('answer');
  });

  it('session 归属：跨用户读（同租户他人）→ 404 不泄漏存在性', async () => {
    const cross = await fetch(`${baseUrl}/ai-query/sessions/${gapSessionId}`, { headers: headersOf(otherId) });
    expect(cross.status).toBe(404);
    const crossBody = (await cross.json()) as { statusCode: number; code: string };
    expect(crossBody.statusCode).toBe(404);
    expect(crossBody.code).toBe('ai_query.not_found');
  });
});
