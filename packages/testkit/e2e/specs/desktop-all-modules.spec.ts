/**
 * 桌面全模块页走查（V1 扩展，chromium project，storageState 会话注入）。
 *
 * 覆盖合同：T2 只走查了 8 个核心页；本文件补齐 S2 九循环模块页（manufacturing/
 * reporting/purchasing/quality/warehouse/costing/baseline 七组 23 页）+ S3-a
 * 主数据/组织/审计 8 页 + T1 能力子集（运营总览/扫码 2 页）。每页同一形态：
 * 侧栏菜单点击 → URL 断言 → 内容区元素可见断言（卡片标题/表单控件/表格列——
 * 结构级，不依赖业务数据存在）→ 截图留档。
 *
 * 断言纪律（T2 同体例）：
 * - 一律 scope 到 getByRole('main')——侧栏菜单链接文本与部分页面卡片标题同名
 *   （质检队列/发货任务/操作日志/扫码/运营总览……），main 限定避免 strict
 *   mode 双命中，且断言语义更强（内容区渲染而非侧栏存在）。
 * - 表单控件按 id 钉（页面 Label htmlFor 唯一锚点）；按钮按 role+name。
 * - 新种 PG 数据面大多空表：断言结构元素（卡片/表单/过滤控件），不做数据行
 *   断言（数据读回归 desktop-core-pages 种子断言与 real-chain 链路断言）。
 *
 * 模块未进栈的 3 页（菜单管理/审批流配置/通知中心）按合同第 6 条隔离为
 * test.fixme 并注明原因——走查栈 MODULES（T2 基线形态）不含 menu-config /
 * approval-config / notifications；页面可达但数据面 404 属栈形态而非页面缺陷，
 * 扩栈属栈合同变更，不在本任务泳道。通知中心另有入口不可达事实：铃铛未读
 * 计数 404 → fail-open 不渲染，且 /notifications 深链命中 API 前缀。
 *
 * 触发：RUN_E2E=1（缺省全 skip，不起栈）。
 */
import { expect, test, type Page } from '@playwright/test';
import { ARTEFACTS } from '../scripts/env.ts';

const RUN_E2E = process.env['RUN_E2E'] === '1';
test.skip(!RUN_E2E, '浏览器 e2e 需 RUN_E2E=1（docker PG + 15 模块 server + vite preview）');

test.describe.configure({ mode: 'serial' });

/** 全页截图（视觉证据；断言本体是元素可见性）。命名规则：desktop-<页面码>.png（与 assembly.ts PAGE_BY_CODE 键同名）。 */
async function shot(page: Page, code: string): Promise<void> {
  await page.screenshot({ path: `${ARTEFACTS}desktop-${code}.png`, fullPage: true });
}

/** 侧栏菜单点击导航 → URL 断言（NavLink client-side，无整页往返）。 */
async function gotoViaMenu(page: Page, menuTitle: string, urlPattern: RegExp): Promise<void> {
  await page.getByRole('link', { name: menuTitle, exact: true }).click();
  await expect(page).toHaveURL(urlPattern);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('离散制造运营平台', { exact: true })).toBeVisible();
});

// ---- 制造运营组（S2：工作令/清单/派工余量页） ----

test('21 配件申请页：列表卡 + 申请/决策表单可见', async ({ page }) => {
  await gotoViaMenu(page, '配件申请', /\/workorders\/parts$/);
  const main = page.getByRole('main');
  await expect(main.getByText('配件申请列表', { exact: true })).toBeVisible();
  await expect(page.locator('#parts-new-wo')).toBeVisible();
  await expect(page.locator('#parts-state-filter')).toBeVisible();
  await shot(page, 'workorder-parts');
});

test('22 清单页：四类清单卡 + 查询/骨架导入表单可见', async ({ page }) => {
  await gotoViaMenu(page, '清单', /\/listings\/sheets$/);
  const main = page.getByRole('main');
  await expect(main.getByText('四类清单', { exact: true })).toBeVisible();
  // 详情卡（含行）按选中行条件渲染（新栈无清单数据），恒在结构 = 查询表单双按钮
  await expect(page.locator('#sheets-wo')).toBeVisible();
  await expect(page.getByRole('button', { name: '查询清单' })).toBeVisible();
  await expect(page.getByRole('button', { name: '骨架导入（建四类空清单）' })).toBeVisible();
  await shot(page, 'listing-sheets');
});

test('23 缺口核查页：核查卡 + 快照卡 + 双按钮可见', async ({ page }) => {
  await gotoViaMenu(page, '缺口核查', /\/listings\/gap-checks$/);
  const main = page.getByRole('main');
  await expect(main.getByText('缺口核查', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '执行缺口核查' })).toBeVisible();
  await expect(page.getByRole('button', { name: '读最新快照' })).toBeVisible();
  await shot(page, 'listing-gap-checks');
});

test('24 外协明细页：供应商维度卡 + 打印数据卡可见', async ({ page }) => {
  await gotoViaMenu(page, '外协明细', /\/outsourcing\/lines$/);
  const main = page.getByRole('main');
  await expect(main.getByText('外协明细（供应商维度）', { exact: true })).toBeVisible();
  await expect(main.getByText('外协加工单打印数据', { exact: true })).toBeVisible();
  await expect(page.locator('#os-supplier')).toBeVisible();
  await shot(page, 'outsourcing-lines');
});

test('25 扫码页：三档降级链组合根渲染（容器横幅 + 采集/结果卡）', async ({ page }) => {
  await gotoViaMenu(page, '扫码', /\/scan$/);
  const main = page.getByRole('main');
  // 全量渲染分支卡集（「扫码」标题仅无档位兜底分支；headless 摄像头不可用
  // → 降级链至扫码枪档 tier3，会话非空走全量渲染）
  await expect(main.getByText('扫码采集', { exact: true })).toBeVisible();
  await expect(main.getByText('最近结果', { exact: true })).toBeVisible();
  await expect(page.locator('#scan-tier')).toBeVisible();
  await expect(page.getByRole('button', { name: /开始扫码|重新开始/ })).toBeVisible();
  // 容器探测横幅：Chromium headless = browser 容器态
  await expect(main.getByText(/当前容器：浏览器/)).toBeVisible();
  await shot(page, 'scan');
});

// ---- 报工管理组（S2：核查页） ----

test('26 报工核查页：待核查队列卡 + 核查备注表单可见', async ({ page }) => {
  await gotoViaMenu(page, '报工核查', /\/reports\/verification$/);
  const main = page.getByRole('main');
  await expect(main.getByText('待核查队列', { exact: true })).toBeVisible();
  await expect(main.getByText('核查备注（可选；撤销时作原因）')).toBeVisible();
  await expect(page.locator('#verify-remark')).toBeVisible();
  await shot(page, 'report-verification');
});

// ---- 采购管理组（S2：四页） ----

test('27 采购申请页：列表卡 + 手工发起表单可见', async ({ page }) => {
  await gotoViaMenu(page, '采购申请', /\/purchase\/requests$/);
  const main = page.getByRole('main');
  await expect(main.getByText('采购申请列表', { exact: true })).toBeVisible();
  await expect(main.getByText('手工发起采购申请', { exact: true })).toBeVisible();
  await expect(page.locator('#pr-item')).toBeVisible();
  await shot(page, 'purchase-requests');
});

test('28 采购订单页：列表卡 + 建单提交表单可见', async ({ page }) => {
  await gotoViaMenu(page, '采购订单', /\/purchase\/orders$/);
  const main = page.getByRole('main');
  await expect(main.getByText('采购订单列表', { exact: true })).toBeVisible();
  await expect(main.getByText('建单并提交采购订单', { exact: true })).toBeVisible();
  // 全流程视图卡按选中行条件渲染（新栈无订单）——恒在结构 = 建单表单字段
  await expect(page.locator('#po-new-wo')).toBeVisible();
  await expect(page.locator('#po-new-supplier-ref')).toBeVisible();
  await expect(page.locator('#po-new-price')).toBeVisible();
  await shot(page, 'purchase-orders');
});

test('29 采购退货页：退货单卡 + 建退货/处置表单可见', async ({ page }) => {
  await gotoViaMenu(page, '采购退货', /\/purchase\/returns$/);
  const main = page.getByRole('main');
  await expect(main.getByText('采购退货单', { exact: true })).toBeVisible();
  await expect(page.locator('#ret-po')).toBeVisible();
  await expect(page.locator('#ret-target')).toBeVisible();
  await shot(page, 'purchase-returns');
});

test('30 采购明细页：明细卡 + 逾期未交明细卡可见', async ({ page }) => {
  await gotoViaMenu(page, '采购明细', /\/purchase\/details$/);
  const main = page.getByRole('main');
  await expect(main.getByText('采购明细', { exact: true })).toBeVisible();
  await expect(main.getByText('逾期未交明细', { exact: true })).toBeVisible();
  await expect(page.locator('#pd-wo')).toBeVisible();
  await shot(page, 'purchase-details');
});

// ---- 质量管理组（S2：两页） ----

test('31 质检队列页：队列卡 + 手工建单表单可见', async ({ page }) => {
  await gotoViaMenu(page, '质检队列', /\/inspections$/);
  const main = page.getByRole('main');
  await expect(main.getByText('质检队列', { exact: true })).toBeVisible();
  await expect(main.getByText('手工建质检单', { exact: true })).toBeVisible();
  // 判定面板按选中行条件渲染（新栈队列空）——恒在结构 = 过滤 + 建单字段
  await expect(page.locator('#insp-kind-filter')).toBeVisible();
  await expect(page.locator('#insp-new-kind')).toBeVisible();
  await expect(page.locator('#insp-new-qty')).toBeVisible();
  await shot(page, 'inspections');
});

test('32 不合格处置页：处置列表卡 + 过滤表单可见', async ({ page }) => {
  await gotoViaMenu(page, '不合格处置', /\/inspections\/nonconformities$/);
  const main = page.getByRole('main');
  await expect(main.getByText('不合格处置', { exact: true })).toBeVisible();
  // 处置操作卡按选中行条件渲染（新栈无明细）——恒在结构 = 双过滤
  await expect(page.locator('#nc-state-filter')).toBeVisible();
  await expect(page.locator('#nc-inspection-filter')).toBeVisible();
  await shot(page, 'nonconformities');
});

// ---- 仓储管理组（S2：四页余量，实时库存已在 T2） ----

test('33 仓库与库位页：列表/详情/建仓三卡可见', async ({ page }) => {
  await gotoViaMenu(page, '仓库与库位', /\/inventory\/warehouses$/);
  const main = page.getByRole('main');
  await expect(main.getByText('仓库列表', { exact: true })).toBeVisible();
  // 建仓卡标题与提交按钮同名（T1 已知模式）——按 role 钉按钮（卡内，卡渲染随之证明）
  await expect(page.getByRole('button', { name: '建仓库' })).toBeVisible();
  await expect(page.locator('#wh-code')).toBeVisible();
  await expect(page.locator('#wh-loc-code')).toBeVisible();
  await shot(page, 'warehouses');
});

test('34 收发存操作页：入库/出库/调拨三组表单可见', async ({ page }) => {
  await gotoViaMenu(page, '收发存操作', /\/inventory\/stock-operations$/);
  const main = page.getByRole('main');
  await expect(main.getByText('入库', { exact: true })).toBeVisible();
  await expect(main.getByText('调拨 / 移库', { exact: true })).toBeVisible();
  await expect(page.locator('#recv-kind')).toBeVisible();
  await expect(page.locator('#issue-item')).toBeVisible();
  await shot(page, 'stock-operations');
});

test('35 库存盘点页：台账卡 + 开单表单可见', async ({ page }) => {
  await gotoViaMenu(page, '库存盘点', /\/inventory\/stocktakes$/);
  const main = page.getByRole('main');
  await expect(main.getByText('盘点台账', { exact: true })).toBeVisible();
  // 详情与录入卡按选中行条件渲染（新栈无盘点单）——恒在结构 = 开单 + 过滤
  await expect(page.locator('#st-new-wh')).toBeVisible();
  await expect(page.locator('#st-state-filter')).toBeVisible();
  await shot(page, 'stocktakes');
});

test('36 发货任务页：任务卡 + 建任务表单可见', async ({ page }) => {
  await gotoViaMenu(page, '发货任务', /\/inventory\/shipping-orders$/);
  const main = page.getByRole('main');
  await expect(main.getByText('发货任务', { exact: true })).toBeVisible();
  await expect(main.getByText('建发货任务并执行', { exact: true })).toBeVisible();
  // 详情确认卡按选中行条件渲染（新栈无任务）——恒在结构 = 建单 + 过滤
  await expect(page.locator('#ship-new-item')).toBeVisible();
  await expect(page.locator('#ship-state-filter')).toBeVisible();
  await shot(page, 'shipping-orders');
});

// ---- 成本与工时组（S2：两页） ----

test('37 工时统计页：机加工时统计卡 + 月度工时卡可见', async ({ page }) => {
  await gotoViaMenu(page, '工时统计', /\/hours\/stats$/);
  const main = page.getByRole('main');
  await expect(main.getByText('机加工时统计', { exact: true })).toBeVisible();
  await expect(main.getByText('月度工时（汇总 / 明细 / 重算快照）', { exact: true })).toBeVisible();
  await expect(page.locator('#hours-month')).toBeVisible();
  await shot(page, 'hours-stats');
});

test('38 成本核算页：口径版本链/事件审计卡 + 求值表单可见', async ({ page }) => {
  await gotoViaMenu(page, '成本核算', /\/costing$/);
  const main = page.getByRole('main');
  await expect(main.getByText('口径版本链', { exact: true })).toBeVisible();
  await expect(main.getByText('口径事件审计', { exact: true })).toBeVisible();
  await expect(page.locator('#cost-model-code')).toBeVisible();
  await expect(page.locator('#cost-compare-a')).toBeVisible();
  await shot(page, 'costing');
});

// ---- 工艺与设备组（S2：七页） ----

test('39 工序页：工序列表卡 + 定义表单 + 过滤可见', async ({ page }) => {
  await gotoViaMenu(page, '工序', /\/baseline\/processes$/);
  const main = page.getByRole('main');
  await expect(main.getByText('工序列表', { exact: true })).toBeVisible();
  await expect(page.locator('#proc-code')).toBeVisible();
  await expect(page.locator('#proc-status-filter')).toBeVisible();
  await shot(page, 'baseline-processes');
});

test('40 工艺路线页：路线卡 + 定义路线表单可见', async ({ page }) => {
  await gotoViaMenu(page, '工艺路线', /\/baseline\/routings$/);
  const main = page.getByRole('main');
  await expect(main.getByText('工艺路线', { exact: true })).toBeVisible();
  // 定义卡标题与提交按钮同名——按 role 钉按钮
  await expect(page.getByRole('button', { name: '定义工艺路线' })).toBeVisible();
  await expect(page.locator('#routing-drawing')).toBeVisible();
  await expect(page.locator('#routing-steps')).toBeVisible();
  await shot(page, 'baseline-routings');
});

test('41 额定工时页：额定工时卡 + 定义表单可见', async ({ page }) => {
  await gotoViaMenu(page, '额定工时', /\/baseline\/standard-times$/);
  const main = page.getByRole('main');
  await expect(main.getByText('额定工时', { exact: true })).toBeVisible();
  // 定义卡标题与提交按钮同名——按 role 钉按钮
  await expect(page.getByRole('button', { name: '定义额定工时' })).toBeVisible();
  await expect(page.locator('#st-code')).toBeVisible();
  await expect(page.locator('#st-seconds')).toBeVisible();
  await shot(page, 'baseline-standard-times');
});

test('42 设备档案页：设备卡 + 定义表单 + 过滤可见', async ({ page }) => {
  await gotoViaMenu(page, '设备档案', /\/baseline\/equipment$/);
  const main = page.getByRole('main');
  await expect(main.getByText('设备档案', { exact: true })).toBeVisible();
  await expect(page.locator('#equip-code')).toBeVisible();
  await expect(page.locator('#equip-status-filter')).toBeVisible();
  await shot(page, 'baseline-equipment');
});

test('43 故障上报页（桌面）：故障单列表卡 + 上报故障表单可见', async ({ page }) => {
  await gotoViaMenu(page, '故障上报', /\/baseline\/fault-reports$/);
  const main = page.getByRole('main');
  await expect(main.getByText('故障单列表', { exact: true })).toBeVisible();
  // 上报卡标题与提交按钮同名——按 role 钉按钮
  await expect(page.getByRole('button', { name: '上报故障' })).toBeVisible();
  await expect(page.locator('#fault-equipment')).toBeVisible();
  await expect(page.locator('#fault-state-filter')).toBeVisible();
  await shot(page, 'baseline-fault-reports');
});

test('44 外协计价页：计价规则卡 + 定义表单可见', async ({ page }) => {
  await gotoViaMenu(page, '外协计价', /\/baseline\/outsourcing-rules$/);
  const main = page.getByRole('main');
  await expect(main.getByText('外协计价规则', { exact: true })).toBeVisible();
  await expect(page.locator('#or-code')).toBeVisible();
  await expect(page.locator('#or-status-filter')).toBeVisible();
  await shot(page, 'baseline-outsourcing-rules');
});

test('45 物料校验页：校验运行台账卡（只读两径）可见', async ({ page }) => {
  await gotoViaMenu(page, '物料校验', /\/baseline\/material-validations$/);
  const main = page.getByRole('main');
  await expect(main.getByText('物料校验运行', { exact: true })).toBeVisible();
  await expect(main.getByText(/三分判定（match\/candidate\/missing）/)).toBeVisible();
  await shot(page, 'baseline-material-validations');
});

// ---- 基础数据组（S3-a：资源/客户/供应商/计量单位；物品已在 T2） ----

test('46 资源页：资源列表卡 + 创建资源表单可见', async ({ page }) => {
  await gotoViaMenu(page, '资源', /\/masterdata\/resources$/);
  const main = page.getByRole('main');
  await expect(main.getByText('资源列表', { exact: true })).toBeVisible();
  // 创建卡标题与提交按钮同名——按 role 钉按钮
  await expect(page.getByRole('button', { name: '创建资源' })).toBeVisible();
  await expect(page.locator('#resource-code')).toBeVisible();
  await shot(page, 'masterdata-resource');
});

test('47 客户页：客户列表卡 + 创建表单可见', async ({ page }) => {
  await gotoViaMenu(page, '客户', /\/masterdata\/customers$/);
  const main = page.getByRole('main');
  await expect(main.getByText('客户列表', { exact: true })).toBeVisible();
  await expect(page.locator('#customer-code')).toBeVisible();
  await expect(page.locator('#customer-contact')).toBeVisible();
  await shot(page, 'masterdata-customer');
});

test('48 供应商页：供应商列表卡 + 创建表单可见', async ({ page }) => {
  await gotoViaMenu(page, '供应商', /\/masterdata\/suppliers$/);
  const main = page.getByRole('main');
  await expect(main.getByText('供应商列表', { exact: true })).toBeVisible();
  await expect(page.locator('#supplier-code')).toBeVisible();
  await expect(page.locator('#supplier-name')).toBeVisible();
  await shot(page, 'masterdata-supplier');
});

test('49 计量单位页：单位列表卡 + 创建表单可见', async ({ page }) => {
  await gotoViaMenu(page, '计量单位', /\/masterdata\/units$/);
  const main = page.getByRole('main');
  await expect(main.getByText('计量单位列表', { exact: true })).toBeVisible();
  await expect(page.locator('#unit-code')).toBeVisible();
  await expect(page.locator('#unit-symbol')).toBeVisible();
  await shot(page, 'masterdata-unit');
});

// ---- 系统管理组（S3-a：角色/机构/岗位/操作日志；用户与角色已在 T2） ----

test('50 角色与授权页：角色卡 + 创建角色表单可见', async ({ page }) => {
  await gotoViaMenu(page, '角色与授权', /\/system\/roles$/);
  const main = page.getByRole('main');
  await expect(main.getByText('角色与授权', { exact: true })).toBeVisible();
  // 创建卡标题与提交按钮同名——按 role 钉按钮
  await expect(page.getByRole('button', { name: '创建角色' })).toBeVisible();
  await expect(page.locator('#org-role-name')).toBeVisible();
  await shot(page, 'system-role');
});

test('51 机构页：机构列表卡 + 建机构表单可见', async ({ page }) => {
  await gotoViaMenu(page, '机构', /\/system\/departments$/);
  const main = page.getByRole('main');
  await expect(main.getByText('机构列表', { exact: true })).toBeVisible();
  await expect(page.locator('#dept-code')).toBeVisible();
  await expect(page.locator('#dept-parent')).toBeVisible();
  await shot(page, 'system-department');
});

test('52 岗位页：岗位列表卡 + 建岗位表单可见', async ({ page }) => {
  await gotoViaMenu(page, '岗位', /\/system\/positions$/);
  const main = page.getByRole('main');
  await expect(main.getByText('岗位列表', { exact: true })).toBeVisible();
  await expect(page.locator('#pos-code')).toBeVisible();
  // 归属机构：org 可读走 #pos-dept 下拉（#pos-dept-id 是机构清单不可读的降级手填）
  await expect(page.locator('#pos-dept')).toBeVisible();
  await shot(page, 'system-position');
});

test('53 操作日志页：日志查询卡（用户/时间窗/条数过滤）可见', async ({ page }) => {
  await gotoViaMenu(page, '操作日志', /\/system\/audit$/);
  const main = page.getByRole('main');
  await expect(main.getByText('操作日志', { exact: true })).toBeVisible();
  await expect(page.locator('#audit-user')).toBeVisible();
  await expect(page.locator('#audit-from')).toBeVisible();
  await expect(page.locator('#audit-limit')).toBeVisible();
  await shot(page, 'system-audit');
});

// ---- T1 能力子集（模块在栈内：运营总览四源聚合；扫码已收 25） ----

test('54 运营总览页：四源聚合卡 + 交付/质检/工时下钻可见', async ({ page }) => {
  await gotoViaMenu(page, '运营总览', /\/overview$/);
  const main = page.getByRole('main');
  await expect(main.getByText('运营总览', { exact: true })).toBeVisible();
  // 四源指标卡（真实 overviewApi 四 GET 聚合后渲染）
  await expect(main.getByText('我的待办', { exact: true })).toBeVisible();
  await expect(main.getByText(/交付风险（非终态 \d+ 单）/)).toBeVisible();
  await expect(main.getByText(/质检态势（待检 \d+）/)).toBeVisible();
  await expect(main.getByText('机加工时（净额）', { exact: true })).toBeVisible();
  // 下钻分组
  await expect(main.getByText('交付态势下钻', { exact: true })).toBeVisible();
  await expect(main.getByText('质检四类下钻', { exact: true })).toBeVisible();
  await expect(main.getByText('机加工时下钻', { exact: true })).toBeVisible();
  await shot(page, 'overview');
});

// ---- 模块未进栈（合同第 6 条：fixme 隔离，如实计数不硬凑绿） ----

test('55 菜单管理页（fixme：走查栈 MODULES 不含 menu-config）', async ({ page }) => {
  test.fixme(
    true,
    '栈形态非页面缺陷：GET /menu-config 404 → 配置集卡数据面失败；扩栈（+menu-config）属栈合同变更，不在本任务泳道。扩栈后删本行按下方断言放开。',
  );
  await gotoViaMenu(page, '菜单管理', /\/system\/menus$/);
  await expect(page.getByRole('main').getByText('菜单配置集', { exact: true })).toBeVisible();
  await expect(page.locator('#menu-config-code')).toBeVisible();
  await shot(page, 'system-menus');
});

test('56 审批流配置页（fixme：走查栈 MODULES 不含 approval-config）', async ({ page }) => {
  test.fixme(
    true,
    '栈形态非页面缺陷：approval-config 数据面 404；且该模块正处 U 波在途改动区（packages/application approval*），扩栈验证不宜在本轮捆绑。扩栈后删本行按下方断言放开。',
  );
  await gotoViaMenu(page, '审批流配置', /\/system\/approval-config$/);
  await expect(page.getByRole('main').getByText('审批流配置', { exact: true })).toBeVisible();
  await expect(page.locator('#flow-name')).toBeVisible();
  await shot(page, 'system-approval-config');
});

test('57 通知中心页（fixme：走查栈 MODULES 不含 notifications，入口不可达）', async ({ page }) => {
  test.fixme(
    true,
    '双重不可达：铃铛未读计数 404 → fail-open 不渲染（无 UI 入口）；/notifications 深链命中 API 前缀（preview proxy 反代语义）。扩栈（+notifications）后删本行按下方断言放开。',
  );
  // 扩栈后入口：顶栏铃铛（aria-label 通知中心）点击 → /notifications
  await page.getByRole('button', { name: '通知中心' }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('main').getByText('通知中心', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '全部置读' })).toBeVisible();
  await shot(page, 'notifications');
});
