/**
 * 进度查询视图模型测试（S3 移动呈现）：工作令项目进度直返对象解析 +
 * 图号×工序进度行解析、权限码常量。响应形状镜像 packages/application
 * workorder.service WorkOrderProgressView 与 reporting.service
 * DrawingOperationProgressRow。
 */
import { describe, expect, it } from 'vitest';
import {
  parseOperationProgressResponse,
  parseWorkOrderProgressResponse,
  ProgressViewsError,
  WORKORDER_READ,
} from '../src/index.js';

const progressRow = {
  drawingNo: 'DWG-A01',
  operationCode: 'OP-10',
  netDoneQty: 30,
  verifiedQty: 20,
  netLaborMinutes: 480,
  verifiedLaborMinutes: 320,
  reportCount: 3,
  lastReportedAt: '2026-10-25T01:00:00.000Z',
};

const progressBody = {
  workOrderId: 'wo-0001',
  projectName: '示范项目一',
  state: 'in_production',
  plannedDeliveryAt: '2026-11-30T00:00:00.000Z',
  packagingArrivalAt: null,
  daysToDelivery: 36,
  milestones: [
    { from: 'draft', to: 'confirmed', event: 'workorder.transition.v1', at: '2026-10-01T00:00:00.000Z', actor: 'user-demo-planner', objectVersion: 2 },
  ],
};

describe('工作令进度响应解析（GET /workorder/work-orders/:id/progress）', () => {
  it('合法响应：直返对象解析、里程碑时序保留', () => {
    const view = parseWorkOrderProgressResponse(progressBody);
    expect(view.workOrderId).toBe('wo-0001');
    expect(view.projectName).toBe('示范项目一');
    expect(view.state).toBe('in_production');
    expect(view.plannedDeliveryAt).toBe('2026-11-30T00:00:00.000Z');
    expect(view.packagingArrivalAt).toBeNull();
    expect(view.daysToDelivery).toBe(36);
    expect(view.milestones).toEqual([
      {
        from: 'draft',
        to: 'confirmed',
        event: 'workorder.transition.v1',
        at: '2026-10-01T00:00:00.000Z',
        actor: 'user-demo-planner',
      },
    ]);
  });

  it('无计划交付：plannedDeliveryAt/daysToDelivery 双 null 合法', () => {
    const view = parseWorkOrderProgressResponse({
      ...progressBody,
      plannedDeliveryAt: null,
      daysToDelivery: null,
    });
    expect(view.plannedDeliveryAt).toBeNull();
    expect(view.daysToDelivery).toBeNull();
  });

  it('非法形状拒绝：缺 milestones / 坏里程碑行 / 非数值倒计时', () => {
    const { milestones: _m, ...noMilestones } = progressBody;
    expect(() => parseWorkOrderProgressResponse(noMilestones)).toThrow(ProgressViewsError);
    expect(() =>
      parseWorkOrderProgressResponse({ ...progressBody, milestones: [{ from: 'draft' }] }),
    ).toThrow(ProgressViewsError);
    expect(() =>
      parseWorkOrderProgressResponse({ ...progressBody, daysToDelivery: '36' }),
    ).toThrow(ProgressViewsError);
    expect(() => parseWorkOrderProgressResponse(null)).toThrow(ProgressViewsError);
  });
});

describe('图号工序进度响应解析（GET /reporting/drawings/:drawingNo/operation-progress）', () => {
  it('合法响应：净报工聚合行解析（未挂工序行 operationCode null）', () => {
    const rows = parseOperationProgressResponse({
      rows: [
        {
          drawingNo: 'DWG-A01',
          operationCode: 'OP-10',
          netDoneQty: 30,
          verifiedQty: 20,
          netLaborMinutes: 480,
          verifiedLaborMinutes: 320,
          reportCount: 3,
          lastReportedAt: '2026-10-25T01:00:00.000Z',
        },
        {
          drawingNo: 'DWG-A01',
          operationCode: null,
          netDoneQty: 5,
          verifiedQty: 0,
          netLaborMinutes: 60,
          verifiedLaborMinutes: 0,
          reportCount: 1,
          lastReportedAt: null,
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.operationCode).toBe('OP-10');
    expect(rows[0]?.verifiedQty).toBe(20);
    expect(rows[1]?.operationCode).toBeNull();
    expect(rows[1]?.lastReportedAt).toBeNull();
  });

  it('非法形状拒绝：缺 rows / 坏行 / 非数值净额', () => {
    expect(() => parseOperationProgressResponse({})).toThrow(ProgressViewsError);
    expect(() => parseOperationProgressResponse({ rows: [{}] })).toThrow(ProgressViewsError);
    expect(() =>
      parseOperationProgressResponse({ rows: [{ ...progressRow, netDoneQty: '30' }] }),
    ).toThrow(ProgressViewsError);
  });
});

describe('进度权限码常量（与后端端点一一对应）', () => {
  it('workorder:read', () => {
    expect(WORKORDER_READ).toBe('workorder:read');
  });
});
