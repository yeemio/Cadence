/**
 * StaticFixtureSource——ReferenceSource 的静态夹具实现：
 * 从已加载的 ReconcileFixture 列表按场景名取参考输出。
 */
import type { ReconcileFixture, ReferenceOutcome, ReferenceSource } from '../types.js';

export class StaticFixtureSource implements ReferenceSource {
  readonly name = 'static-fixtures';
  private readonly byName: Map<string, ReconcileFixture>;

  constructor(fixtures: readonly ReconcileFixture[]) {
    this.byName = new Map(fixtures.map((fixture) => [fixture.scenarioName, fixture]));
  }

  async get(scenarioName: string): Promise<ReferenceOutcome | null> {
    const fixture = this.byName.get(scenarioName);
    if (fixture === undefined || fixture.reference === null) {
      return null;
    }
    return fixture.reference;
  }
}
