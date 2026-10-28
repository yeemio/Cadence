/**
 * 错误响应语义化 code 映射测试（i18n 波 2 后端半面，ADR-0012 决定 3）。
 *
 * 覆盖 apps/server/src 全部 22 个 *-error.filter.ts（navigation-error.filter
 * 属他人合同，不在本表）：每个过滤器 × 其 @Catch 注册的每个错误类，
 * 断言响应体形状恰为 { statusCode, code, message }、code 等于该类型的语义
 * 映射、message 原文透传（不裁剪不改写）。纯过滤器单测——不起容器、
 * 不走网络，与既有 e2e 中文 message 断言零交集。
 */
import { describe, expect, it } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ApprovalConflictError, ApprovalInputError, ApprovalNotFoundError, ApprovalStateError } from '@smes/application';
import { AiQueryConflictError, AiQueryInputError, AiQueryNotFoundError } from '@smes/application';
import { AttachmentConflictError, AttachmentInputError, AttachmentNotFoundError, AttachmentStorageError } from '@smes/application';
import { AuditInputError } from '@smes/application';
import { AuthCredentialsError, AuthInputError, AuthRateLimitError } from '@smes/application';
import { BaselineConflictError, BaselineInputError, BaselineNotFoundError } from '@smes/application';
import { ColumnPreferenceInputError } from '@smes/application';
import { CostingConflictError, CostingInputError, CostingNotFoundError } from '@smes/application';
import { DispatchConflictError, DispatchInputError, DispatchNotFoundError, DispatchStateError } from '@smes/application';
import { HoursConflictError, HoursInputError, HoursNotFoundError } from '@smes/application';
import { InspectionConflictError, InspectionInputError, InspectionNotFoundError, InspectionStateError } from '@smes/application';
import { InventoryConflictError, InventoryInputError, InventoryNotFoundError, InventoryStateError } from '@smes/application';
import { IssueConflictError, IssueInputError, IssueNotFoundError, IssueStateError } from '@smes/application';
import { ListingConflictError, ListingInputError, ListingNotFoundError, ListingStateError } from '@smes/application';
import { MasterdataConflictError, MasterdataInputError, MasterdataNotFoundError, WorkbenchInputError, WorkbenchNotFoundError } from '@smes/application';
import { MenuConfigConflictError, MenuConfigInputError, MenuConfigNotFoundError, NotificationInputError, NotificationNotFoundError } from '@smes/application';
import { ApprovalConfigConflictError, ApprovalConfigInputError, ApprovalConfigNotFoundError } from '@smes/application';
import { OrgConflictError, OrgInputError, OrgNotFoundError } from '@smes/application';
import { ReportConflictError, ReportInputError, ReportNotFoundError, ReportStateError } from '@smes/application';
import { StandardReportsInputError, StandardReportsNotFoundError, StandardReportsSourceError } from '@smes/application';
import { WorkOrderConflictError, WorkOrderInputError, WorkOrderNotFoundError, WorkOrderStateError } from '@smes/application';
import { DrawingConflictError, DrawingInputError, DrawingNotFoundError } from '@smes/drawing';
import { MaintenanceConflictError, MaintenanceInputError, MaintenanceNotFoundError } from '@smes/maintenance';
import { MetricPackConflictError, MetricPackInputError, MetricPackNotFoundError } from '@smes/metric-pack';
import { PayrollConflictError, PayrollInputError, PayrollNotFoundError } from '@smes/payroll';
import { AiQueryErrorFilter } from '../src/ai-query-error.filter.js';
import { ApprovalErrorFilter } from '../src/approval-error.filter.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { BackfillErrorFilter } from '../src/backfill-error.filter.js';
import { BaselineErrorFilter } from '../src/baseline-error.filter.js';
import { CapabilityErrorFilter } from '../src/capability-error.filter.js';
import { ColumnPreferenceErrorFilter } from '../src/column-preference-error.filter.js';
import { CostingErrorFilter } from '../src/costing-error.filter.js';
import { DispatchErrorFilter } from '../src/dispatch-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';
import { DrawingErrorFilter } from '../src/drawing-error.filter.js';
import { HoursErrorFilter } from '../src/hours-error.filter.js';
import { InspectionErrorFilter } from '../src/inspection-error.filter.js';
import { InventoryErrorFilter } from '../src/inventory-error.filter.js';
import { ListingErrorFilter } from '../src/listing-error.filter.js';
import { MaintenanceErrorFilter } from '../src/maintenance-error.filter.js';
import { MetricPackErrorFilter } from '../src/metric-pack-error.filter.js';
import { OrgErrorFilter } from '../src/org-error.filter.js';
import { PayrollErrorFilter } from '../src/payroll-error.filter.js';
import { ReportErrorFilter } from '../src/report-error.filter.js';
import { UWaveErrorFilter } from '../src/u-wave-error.filter.js';
import { WorkOrderErrorFilter } from '../src/workorder-error.filter.js';

/** message 哨兵：任意字符串原样透传即为正确（message 语义属业务包，本测试不钉文案）。 */
const SENTINEL = 'raw-message-sentinel';

/** 捕获 status + json 调用的最小响应体。 */
function capture(exception: unknown, filter: { catch(exception: unknown, host: ArgumentsHost): void }): {
  status: number | undefined;
  body: Record<string, unknown>;
} {
  let status: number | undefined;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number): void {
      status = code;
    },
    json(payload: unknown): void {
      body = payload as Record<string, unknown>;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return { status, body };
}

/** 表驱动用例：错误类构造器 + 期望 statusCode + 期望 code。 */
interface Case {
  make: () => Error;
  status: number;
  code: string;
}

/** 过滤器表：filter 实例工厂 + 全部 @Catch 分支用例。 */
const TABLE: Array<{ name: string; filter: { catch(exception: unknown, host: ArgumentsHost): void }; cases: Case[] }> = [
  {
    name: 'AiQueryErrorFilter',
    filter: new AiQueryErrorFilter(),
    cases: [
      { make: () => new AiQueryInputError(SENTINEL), status: 400, code: 'ai_query.invalid_input' },
      { make: () => new AiQueryNotFoundError(SENTINEL), status: 404, code: 'ai_query.not_found' },
      { make: () => new AiQueryConflictError(SENTINEL), status: 409, code: 'ai_query.conflict' },
    ],
  },
  {
    name: 'DomainErrorFilter',
    filter: new DomainErrorFilter(),
    cases: [
      { make: () => new MasterdataInputError(SENTINEL), status: 400, code: 'masterdata.invalid_input' },
      { make: () => new MasterdataNotFoundError(SENTINEL), status: 404, code: 'masterdata.not_found' },
      { make: () => new MasterdataConflictError(SENTINEL), status: 409, code: 'masterdata.conflict' },
      { make: () => new WorkbenchInputError(SENTINEL), status: 400, code: 'workbench.invalid_input' },
      { make: () => new WorkbenchNotFoundError(SENTINEL), status: 404, code: 'workbench.not_found' },
    ],
  },
  {
    name: 'WorkOrderErrorFilter',
    filter: new WorkOrderErrorFilter(),
    cases: [
      { make: () => new WorkOrderInputError(SENTINEL), status: 400, code: 'workorder.invalid_input' },
      { make: () => new WorkOrderNotFoundError(SENTINEL), status: 404, code: 'workorder.not_found' },
      { make: () => new WorkOrderConflictError(SENTINEL), status: 409, code: 'workorder.conflict' },
      { make: () => new WorkOrderStateError(SENTINEL), status: 409, code: 'workorder.state_conflict' },
    ],
  },
  {
    name: 'AuthErrorFilter',
    filter: new AuthErrorFilter(),
    cases: [
      { make: () => new AuthInputError(SENTINEL), status: 400, code: 'auth.invalid_input' },
      { make: () => new AuthCredentialsError(SENTINEL), status: 401, code: 'auth.invalid_credentials' },
      { make: () => new AuthRateLimitError(SENTINEL), status: 429, code: 'auth.rate_limited' },
    ],
  },
  {
    name: 'ApprovalErrorFilter',
    filter: new ApprovalErrorFilter(),
    cases: [
      { make: () => new ApprovalInputError(SENTINEL), status: 400, code: 'approval.invalid_input' },
      { make: () => new ApprovalNotFoundError(SENTINEL), status: 404, code: 'approval.not_found' },
      { make: () => new ApprovalConflictError(SENTINEL), status: 409, code: 'approval.conflict' },
      { make: () => new ApprovalStateError(SENTINEL), status: 409, code: 'approval.state_conflict' },
    ],
  },
  {
    name: 'BackfillErrorFilter',
    filter: new BackfillErrorFilter(),
    cases: [
      { make: () => new AuditInputError(SENTINEL), status: 400, code: 'audit.invalid_input' },
      { make: () => new StandardReportsInputError(SENTINEL), status: 400, code: 'standard_reports.invalid_input' },
      { make: () => new StandardReportsNotFoundError(SENTINEL), status: 404, code: 'standard_reports.not_found' },
      { make: () => new StandardReportsSourceError(SENTINEL), status: 503, code: 'standard_reports.source_unavailable' },
    ],
  },
  {
    name: 'BaselineErrorFilter',
    filter: new BaselineErrorFilter(),
    cases: [
      { make: () => new BaselineInputError(SENTINEL), status: 400, code: 'baseline.invalid_input' },
      { make: () => new BaselineNotFoundError(SENTINEL), status: 404, code: 'baseline.not_found' },
      { make: () => new BaselineConflictError(SENTINEL), status: 409, code: 'baseline.conflict' },
    ],
  },
  {
    name: 'CapabilityErrorFilter',
    filter: new CapabilityErrorFilter(),
    cases: [
      { make: () => new MenuConfigInputError(SENTINEL), status: 400, code: 'menu_config.invalid_input' },
      { make: () => new MenuConfigNotFoundError(SENTINEL), status: 404, code: 'menu_config.not_found' },
      { make: () => new MenuConfigConflictError(SENTINEL), status: 409, code: 'menu_config.conflict' },
      { make: () => new NotificationInputError(SENTINEL), status: 400, code: 'notification.invalid_input' },
      { make: () => new NotificationNotFoundError(SENTINEL), status: 404, code: 'notification.not_found' },
      { make: () => new ApprovalConfigInputError(SENTINEL), status: 400, code: 'approval_config.invalid_input' },
      { make: () => new ApprovalConfigNotFoundError(SENTINEL), status: 404, code: 'approval_config.not_found' },
      { make: () => new ApprovalConfigConflictError(SENTINEL), status: 409, code: 'approval_config.conflict' },
    ],
  },
  {
    name: 'ColumnPreferenceErrorFilter',
    filter: new ColumnPreferenceErrorFilter(),
    cases: [
      { make: () => new ColumnPreferenceInputError(SENTINEL), status: 400, code: 'column_preference.invalid_input' },
    ],
  },
  {
    name: 'CostingErrorFilter',
    filter: new CostingErrorFilter(),
    cases: [
      { make: () => new CostingInputError(SENTINEL), status: 400, code: 'costing.invalid_input' },
      { make: () => new CostingNotFoundError(SENTINEL), status: 404, code: 'costing.not_found' },
      { make: () => new CostingConflictError(SENTINEL), status: 409, code: 'costing.conflict' },
    ],
  },
  {
    name: 'DispatchErrorFilter',
    filter: new DispatchErrorFilter(),
    cases: [
      { make: () => new DispatchInputError(SENTINEL), status: 400, code: 'dispatch.invalid_input' },
      { make: () => new DispatchNotFoundError(SENTINEL), status: 404, code: 'dispatch.not_found' },
      { make: () => new DispatchConflictError(SENTINEL), status: 409, code: 'dispatch.conflict' },
      { make: () => new DispatchStateError(SENTINEL), status: 409, code: 'dispatch.state_conflict' },
    ],
  },
  {
    name: 'DrawingErrorFilter',
    filter: new DrawingErrorFilter(),
    cases: [
      { make: () => new DrawingInputError(SENTINEL), status: 400, code: 'drawing.invalid_input' },
      { make: () => new DrawingNotFoundError(SENTINEL), status: 404, code: 'drawing.not_found' },
      { make: () => new DrawingConflictError(SENTINEL), status: 409, code: 'drawing.conflict' },
    ],
  },
  {
    name: 'HoursErrorFilter',
    filter: new HoursErrorFilter(),
    cases: [
      { make: () => new HoursInputError(SENTINEL), status: 400, code: 'hours.invalid_input' },
      { make: () => new HoursNotFoundError(SENTINEL), status: 404, code: 'hours.not_found' },
      { make: () => new HoursConflictError(SENTINEL), status: 409, code: 'hours.conflict' },
    ],
  },
  {
    name: 'InspectionErrorFilter',
    filter: new InspectionErrorFilter(),
    cases: [
      { make: () => new InspectionInputError(SENTINEL), status: 400, code: 'inspection.invalid_input' },
      { make: () => new InspectionNotFoundError(SENTINEL), status: 404, code: 'inspection.not_found' },
      { make: () => new InspectionConflictError(SENTINEL), status: 409, code: 'inspection.conflict' },
      { make: () => new InspectionStateError(SENTINEL), status: 409, code: 'inspection.state_conflict' },
    ],
  },
  {
    name: 'InventoryErrorFilter',
    filter: new InventoryErrorFilter(),
    cases: [
      { make: () => new InventoryInputError(SENTINEL), status: 400, code: 'inventory.invalid_input' },
      { make: () => new InventoryNotFoundError(SENTINEL), status: 404, code: 'inventory.not_found' },
      { make: () => new InventoryConflictError(SENTINEL), status: 409, code: 'inventory.conflict' },
      { make: () => new InventoryStateError(SENTINEL), status: 409, code: 'inventory.state_conflict' },
    ],
  },
  {
    name: 'ListingErrorFilter',
    filter: new ListingErrorFilter(),
    cases: [
      { make: () => new ListingInputError(SENTINEL), status: 400, code: 'listing.invalid_input' },
      { make: () => new ListingNotFoundError(SENTINEL), status: 404, code: 'listing.not_found' },
      { make: () => new ListingConflictError(SENTINEL), status: 409, code: 'listing.conflict' },
      { make: () => new ListingStateError(SENTINEL), status: 409, code: 'listing.state_conflict' },
    ],
  },
  {
    name: 'MaintenanceErrorFilter',
    filter: new MaintenanceErrorFilter(),
    cases: [
      { make: () => new MaintenanceInputError(SENTINEL), status: 400, code: 'maintenance.invalid_input' },
      { make: () => new MaintenanceNotFoundError(SENTINEL), status: 404, code: 'maintenance.not_found' },
      { make: () => new MaintenanceConflictError(SENTINEL), status: 409, code: 'maintenance.conflict' },
    ],
  },
  {
    name: 'MetricPackErrorFilter',
    filter: new MetricPackErrorFilter(),
    cases: [
      { make: () => new MetricPackInputError(SENTINEL), status: 400, code: 'metric_pack.invalid_input' },
      { make: () => new MetricPackNotFoundError(SENTINEL), status: 404, code: 'metric_pack.not_found' },
      { make: () => new MetricPackConflictError(SENTINEL), status: 409, code: 'metric_pack.conflict' },
    ],
  },
  {
    name: 'OrgErrorFilter',
    filter: new OrgErrorFilter(),
    cases: [
      { make: () => new OrgInputError(SENTINEL), status: 400, code: 'org.invalid_input' },
      { make: () => new OrgNotFoundError(SENTINEL), status: 404, code: 'org.not_found' },
      { make: () => new OrgConflictError(SENTINEL), status: 409, code: 'org.conflict' },
    ],
  },
  {
    name: 'PayrollErrorFilter',
    filter: new PayrollErrorFilter(),
    cases: [
      { make: () => new PayrollInputError(SENTINEL), status: 400, code: 'payroll.invalid_input' },
      { make: () => new PayrollNotFoundError(SENTINEL), status: 404, code: 'payroll.not_found' },
      { make: () => new PayrollConflictError(SENTINEL), status: 409, code: 'payroll.conflict' },
    ],
  },
  {
    name: 'ReportErrorFilter',
    filter: new ReportErrorFilter(),
    cases: [
      { make: () => new ReportInputError(SENTINEL), status: 400, code: 'report.invalid_input' },
      { make: () => new ReportNotFoundError(SENTINEL), status: 404, code: 'report.not_found' },
      { make: () => new ReportConflictError(SENTINEL), status: 409, code: 'report.conflict' },
      { make: () => new ReportStateError(SENTINEL), status: 409, code: 'report.state_conflict' },
    ],
  },
  {
    name: 'UWaveErrorFilter',
    filter: new UWaveErrorFilter(),
    cases: [
      { make: () => new IssueInputError(SENTINEL), status: 400, code: 'issue.invalid_input' },
      { make: () => new IssueNotFoundError(SENTINEL), status: 404, code: 'issue.not_found' },
      { make: () => new IssueConflictError(SENTINEL), status: 409, code: 'issue.conflict' },
      { make: () => new IssueStateError(SENTINEL), status: 409, code: 'issue.state_conflict' },
      { make: () => new AttachmentInputError(SENTINEL), status: 400, code: 'attachment.invalid_input' },
      { make: () => new AttachmentNotFoundError(SENTINEL), status: 404, code: 'attachment.not_found' },
      { make: () => new AttachmentConflictError(SENTINEL), status: 409, code: 'attachment.conflict' },
      { make: () => new AttachmentStorageError(SENTINEL), status: 502, code: 'attachment.storage_failure' },
    ],
  },
];

describe('错误响应语义化 code 映射（ADR-0012 决定 3）', () => {
  for (const entry of TABLE) {
    describe(entry.name, () => {
      for (const testCase of entry.cases) {
        it(`${testCase.code} <- ${testCase.make().name} (${testCase.status})`, () => {
          const { status, body } = capture(testCase.make(), entry.filter);
          // 响应体形状恰为 { statusCode, code, message }——不多键不少键。
          expect(Object.keys(body).sort()).toEqual(['code', 'message', 'statusCode']);
          expect(status).toBe(testCase.status);
          expect(body.statusCode).toBe(testCase.status);
          expect(body.code).toBe(testCase.code);
          // message 原文透传：过滤器不裁剪不改写（中文语义断言归既有 e2e）。
          expect(body.message).toBe(SENTINEL);
          // code 形态：全小写 + 数字 + 下划线/点分段（snake，无大写无空格）。
          expect(testCase.code).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
        });
      }
    });
  }

  it('覆盖 22 个过滤器（navigation-error.filter 属他人合同不计入）', () => {
    expect(TABLE).toHaveLength(22);
  });
});
