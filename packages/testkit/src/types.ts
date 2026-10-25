/**
 * 对账框架端口（ADR-0002 #3：行为等价 = 同输入同输出黑盒比对）。
 *
 * 三个可插拔端口：
 *   - TargetAdapter：调被测系统（新系统）。默认实现 NodeFetchTargetAdapter（HTTP）。
 *   - ReferenceSource：参考输出来源。默认实现 StaticFixtureSource（读录制夹具）；
 *     M2 施工期可插入活系统适配器（从 sieracMes 取同输入的真实输出）——
 *     端口已留，连接实现不在本工具范围（需活系统访问权限，届时另立）。
 *   - Comparator：纯函数 compareJson（见 comparator/）。
 */
import type { CompareStrategy } from './comparator/strategy.js';

/** 场景输入（对 ReferenceSource 与 TargetAdapter 是同一份"同输入"）。 */
export interface TargetRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** 目标系统单次调用的输出（"同输出"的黑盒观察面）。 */
export interface TargetResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface TargetAdapter {
  /** 适配器名（报告显示；HTTP 适配器为 baseUrl）。 */
  readonly name: string;
  invoke(request: TargetRequest): Promise<TargetResponse>;
}

/** 参考输出（reference）。 */
export interface ReferenceOutcome {
  readonly status: number;
  readonly body: unknown;
}

export interface ReferenceSource {
  readonly name: string;
  /** 无该场景的参考 → null（Harness 判 fail 并提示先录制）。 */
  get(scenarioName: string): Promise<ReferenceOutcome | null>;
}

/** 场景（夹具的运行时形态；格式见 fixtures/types.ts）。 */
export interface ReconcileScenario {
  readonly name: string;
  readonly description?: string;
  readonly input: TargetRequest;
}

/** 加载后的对账夹具（一个文件 = 一个场景）。 */
export interface ReconcileFixture {
  /** 夹具文件绝对路径（报告定位用）。 */
  readonly file: string;
  readonly scenarioName: string;
  readonly description?: string;
  readonly input: TargetRequest;
  /** null = 待录制（文件里 reference 为 null）。 */
  readonly reference: ReferenceOutcome | null;
  readonly strategy: CompareStrategy;
  readonly recordedAt: string | null;
  readonly recordedFrom: string | null;
}
