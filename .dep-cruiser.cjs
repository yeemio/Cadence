/**
 * 依赖铁律（ADR-0003 #1，决策簿"架构与模块化"页）
 *
 *   business-core <- application <- store / ui / integrations / engine
 *   apps 只做组合（server 组后端件，web 经 product-ui）
 *   testkit 是测试工具，不受限
 *
 * 违反 = CI 失败（pnpm verify -> boundary）。
 * 注意：packages/business-core/tests/boundary-fixtures/ 是故意违规的自检夹具，
 * 被本配置 exclude；由 .dep-cruiser.selftest.cjs 单独扫描以证明铁律真实生效。
 */
module.exports = {
  forbidden: [
    {
      name: 'core-no-internal-deps',
      comment: 'business-core 是最内层纯领域包，不得依赖仓内任何其他包',
      severity: 'error',
      from: { path: '^packages/business-core' },
      to: { path: '^(packages/(?!business-core/)|apps/)' },
    },
    {
      name: 'application-only-core',
      comment: 'application 只能依赖 business-core 与 engine-*（ADR-0011 水平内核）',
      severity: 'error',
      from: { path: '^packages/application/' },
      to: { path: '^(packages/(?!application/|business-core/|engine-)|apps/)' },
    },
    {
      name: 'store-tier-edges',
      comment: 'business-store 只能依赖 business-core / application / engine-*（ADR-0011 存储端口实现）',
      severity: 'error',
      from: { path: '^packages/business-store/' },
      to: { path: '^(packages/(?!business-store/|business-core/|application/|engine-)|apps/)' },
    },
    {
      name: 'ui-tier-edges',
      comment: 'product-ui 只能依赖 business-core / application',
      severity: 'error',
      from: { path: '^packages/product-ui/' },
      to: { path: '^(packages/(?!product-ui/|business-core/|application/)|apps/)' },
    },
    {
      name: 'integration-tier-edges',
      comment: 'integration-* 边缘包独占外部 SDK，只能依赖 business-core / application',
      severity: 'error',
      from: { path: '^packages/integration-' },
      to: { path: '^(packages/(?!integration-|business-core/|application/)|apps/)' },
    },
    {
      name: 'engine-tier-edges',
      comment: 'engine-* 引擎包只能依赖 business-core（ADR-0011：水平内核单向，自身不依赖 application）',
      severity: 'error',
      from: { path: '^packages/engine-' },
      to: { path: '^(packages/(?!engine-|business-core/)|apps/)' },
    },
    {
      name: 'pro-pack-tier-edges',
      comment: '专业包（payroll/maintenance/drawing/metric-pack）只能依赖 business-core 与 engine-*（水平内核）；M3 正式实施按实际挂载方向经 ADR 放宽',
      severity: 'error',
      from: { path: '^(packages/payroll/|packages/maintenance/|packages/drawing/|packages/metric-pack/)' },
      to: { path: '^(packages/(?!(payroll|maintenance|drawing|metric-pack)/|business-core/|engine-)|apps/)' },
    },
    {
      name: 'apps-compose-only',
      comment: 'apps/server 是组合根，不得触达前端视图层',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^packages/product-ui' },
    },
    {
      name: 'web-via-ui',
      comment: 'apps/web 是前端组合根：product-ui + business-core 类型 + testkit + integration-*（ADR-0011），不得直连后端包',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^(packages/(?!business-core/|product-ui/|testkit/|integration-)|apps/server/)' },
    },
    {
      name: 'no-circular',
      comment: '仓内不允许循环依赖',
      severity: 'error',
      from: { path: '^(packages|apps)/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['\\.d\\.ts$', 'boundary-fixtures'] },
  },
};
