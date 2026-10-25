/**
 * 报工单读取视图模型测试（S3 移动呈现）：GET /reports/mine 与
 * GET /reports/pending-verification 响应解析、权限码常量。响应形状镜像
 * packages/application reporting-stores WorkReport 投影行（两端点同键同行形）。
 */
import { describe, expect, it } from 'vitest';
import {
  parseWorkReportsResponse,
  REPORT_READ,
  REPORT_VERIFY,
  ReportViewsError,
} from '../src/index.js';

const reportRow = {
  id: 'wr-0192',
  tenant: 'tenant-e2e',
  dispatchId: 'dsp-0001',
  kind: 'part',
  flowConfigId: 'flow-1',
  state: 'reported',
  objectVersion: 2,
  doneQty: 10,
  laborMinutes: 120,
  reporter: 'user-demo-operator',
  workOrderId: 'wo-0001',
  drawingNo: 'DWG-A01',
  operationCode: 'OP-10',
  supersedes: null,
  businessTime: '2026-10-25T01:00:00.000Z',
  verifiedBy: null,
  verifiedAt: null,
  revokedBy: null,
  revokedAt: null,
  revokeReason: null,
  remark: null,
  createdAt: '2026-10-25T01:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
};

describe('报工单列表响应解析（mine / pending-verification 同径）', () => {
  it('合法响应：信封 reports 解包、行子集与乐观锁锚点保留', () => {
    const rows = parseWorkReportsResponse({ reports: [reportRow] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'wr-0192',
      kind: 'part',
      state: 'reported',
      dispatchId: 'dsp-0001',
      doneQty: 10,
      laborMinutes: 120,
      reporter: 'user-demo-operator',
      workOrderId: 'wo-0001',
      drawingNo: 'DWG-A01',
      operationCode: 'OP-10',
      objectVersion: 2,
      businessTime: '2026-10-25T01:00:00.000Z',
      remark: null,
      createdAt: '2026-10-25T01:00:00.000Z',
    });
  });

  it('可空字段 null 合法（workOrderId/drawingNo/operationCode/remark）', () => {
    const rows = parseWorkReportsResponse({
      reports: [
        { ...reportRow, workOrderId: null, drawingNo: null, operationCode: null, remark: '补录' },
      ],
    });
    expect(rows[0]?.workOrderId).toBeNull();
    expect(rows[0]?.drawingNo).toBeNull();
    expect(rows[0]?.operationCode).toBeNull();
    expect(rows[0]?.remark).toBe('补录');
  });

  it('非法形状拒绝：缺 reports / 坏行 / 非数值数量 / 坏乐观锁版本', () => {
    expect(() => parseWorkReportsResponse({})).toThrow(ReportViewsError);
    expect(() => parseWorkReportsResponse({ reports: [{ id: 'wr-1' }] })).toThrow(ReportViewsError);
    expect(() =>
      parseWorkReportsResponse({ reports: [{ ...reportRow, doneQty: '10' }] }),
    ).toThrow(ReportViewsError);
    expect(() =>
      parseWorkReportsResponse({ reports: [{ ...reportRow, objectVersion: 0 }] }),
    ).toThrow(ReportViewsError);
    expect(() => parseWorkReportsResponse(null)).toThrow(ReportViewsError);
  });
});

describe('报工权限码常量（与后端端点一一对应）', () => {
  it('report:read / report:verify', () => {
    expect(REPORT_READ).toBe('report:read');
    expect(REPORT_VERIFY).toBe('report:verify');
  });
});
