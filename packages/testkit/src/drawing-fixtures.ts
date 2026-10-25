/**
 * drawing 模块联动夹具（M3）。
 *
 * 图纸域无外部事实源端口（v1 无 engine 依赖，合同 §4）——夹具面=钉版引用的
 * 结构同形镜像（消费方 workorder/dispatch/reporting/inspection 持
 * `{ drawingId, version }` 结构同形字段，不 import @smes/drawing——合同
 * §4 差异表 #3 裁定）+ 发布命令提交体基线（录制/回放对账用；信封字段由目标
 * 适配器补）。保密等级值集按 m3 冻结合同默认两级（公开/受限，R-M3-6）。
 *
 * 类型取舍同 payroll-fixtures / metric-pack-fixtures：本地结构化镜像类型
 * （testkit rootDir 不含 drawing 源），结构化兼容——引用形状可直接喂
 * DrawingService.drawingsForWorkOrder 的 refs 参数位。
 */

// ---- 本地结构化类型（镜像 drawing DrawingRef 钉版引用合同） ----

/** 钉版引用镜像（{ drawingId, version }——挂 vN 不随 vN+1 漂移）。 */
export interface FixtureDrawingRef {
  readonly drawingId: string;
  readonly version: number;
}

/** 查看者镜像（身份 + 保密许可等级；两级值集与等级同源）。 */
export interface FixtureDrawingViewer {
  readonly userId: string;
  readonly clearance: 'public' | 'restricted';
}

// ---- 命令提交体基线（录制/回放对账用） ----

/** drawing.publish 提交体（发布新修订：version 由链尾+1，不收客户端值）。 */
export interface FixturePublishSubmission {
  readonly drawingId: string;
  /** 文件引用（存储键/URL；实施层解释）。 */
  readonly fileRef: string;
  readonly changeNote: string;
  /** 保密等级缺省 public（两级值集）。 */
  readonly classification?: 'public' | 'restricted';
}

// ---- 构造器 ----

/** 钉版引用（缺省挂 v1）。 */
export function fixtureDrawingRef(overrides: Partial<FixtureDrawingRef> = {}): FixtureDrawingRef {
  return { drawingId: 'dwg-fixture-001', version: 1, ...overrides };
}

/** 查看者（缺省工艺/技术：restricted 许可）。 */
export function fixtureDrawingViewer(overrides: Partial<FixtureDrawingViewer> = {}): FixtureDrawingViewer {
  return { userId: 'u-tech-fixture-01', clearance: 'restricted', ...overrides };
}

let fixtureDrawingCounter = 0;

/** 发布提交体（首发；修订 expectedRevision 由场景叠加）。 */
export function publishDrawingSubmission(overrides: Partial<FixturePublishSubmission> = {}): FixturePublishSubmission {
  fixtureDrawingCounter += 1;
  const seq = String(fixtureDrawingCounter).padStart(3, '0');
  return {
    drawingId: `dwg-fixture-${seq}`,
    fileRef: `storage://drawings/dwg-fixture-${seq}/v1.pdf`,
    changeNote: '夹具首发修订',
    ...overrides,
  };
}
