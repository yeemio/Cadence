# M2 对账操作手册（活系统行为等价 · R2 线）

版本：v0.2（2026-10-25，骨架版 + 新系统侧基线已固化（§9 结果登记）；活系统未接入，映射表为**待验证草案**）｜
定位：`@smes/testkit` README「M2 九模块施工时的对账工作流」第 2 步活系统腿的落地手册。
配套资产：`fixtures/m2-scenarios/`（九模块 36 场景骨架 + 已录制 reference + 库快照 `baseline-snapshot-20261025.sql.gz`）+ `scripts/record-m2.mjs`（批量录制入口）。

本手册回答一个问题：**怎么把"与活系统同输入同输出黑盒比对"（清洁室纪律 #3 /
ADR-0002 #3，行为等价）从口号变成可执行的两侧夹具对跑。**

清洁室红线（先读）：映射与录制只允许**黑盒行为观察**（发请求、看响应）。不得阅读
活系统代码、SQL、模板或其开发文档（D11 禁用输入）；字段口径缺口走"行为需求重述 +
对账测试反推"补齐，不从原实现抄。

---

## 1. 资产总览

```
packages/testkit/
  fixtures/m2-scenarios/            # 九模块场景骨架（一文件=一场景，reference=null 待录制）
    01-baseline/    5 场景（自含 5 / 链式 0）
    02-workorder/   4 场景（自含 2 / 链式 2）
    03-listing/     4 场景（自含 2 / 链式 2）
    04-dispatch/    4 场景（自含 1 / 链式 3）
    05-reporting/   5 场景（自含 1 / 链式 4）
    06-inspection/  4 场景（自含 2 / 链式 2）
    07-inventory/   4 场景（自含 2 / 链式 2）
    08-hours/       3 场景（自含 3 / 链式 0）
    09-costing/     3 场景（自含 1 / 链式 2）
  scripts/record-m2.mjs             # 批量录制/清单入口（--list 即加载冒烟）
  M2-RECONCILE-GUIDE.md             # 本手册
```

合计 **36 场景（自含 19 / 链式 17）**。场景选取依据：九模块草案（`architecture/
contracts/m2-drafts/`）各 §7「Done-when 与对账要点」明文列出的行为锚点；新系统侧
input 一律照抄真实请求形态（来源：`apps/server/scripts/e2e-live-db.mjs`、
`apps/server/tests/cross-module-wiring.e2e.test.ts`、`packages/application` 各模块
控制器与测试载荷——具体来源逐场景写在夹具 `description` 里）。

两类场景：

| 类别 | 含义 | 录制前置 |
|---|---|---|
| 自含（19） | 输入自确定：创建类命令（幂等键固定）或空库合法的读 | 无（起栈即可录） |
| 链式（17） | 输入含运行期值：实体 ID / 乐观锁版本 / 固定字节 | 先跑准备链（§4.2.3）再替换占位符 |

占位符词汇表（`__UPPER_SNAKE__` 形态；`record-m2.mjs` 录制模式遇之显式 SKIP）：

| 占位符 | 语义 | 替换值来源（准备链产物） |
|---|---|---|
| `__WORK_ORDER_ID__` | 工作令 id（uuidv7） | 准备链步骤 A |
| `__WAREHOUSE_ID__` | 仓库 id | 准备链步骤 B |
| `__DISPATCH_ID__` | 已 assign 的派工单 id | 准备链步骤 C |
| `__REPORT_ID__` | 已 reported 的报工单 id | 准备链步骤 D |
| `__INSPECTION_ID__` | pending 质检单 id | 准备链步骤 E |
| `__NONCONFORM_ID__` | 已处置且复检合格的不合格单 id | 准备链步骤 F |
| `__EXPECTED_REVISION__` | 目标对象当前 objectVersion（乐观锁） | 各准备链步骤读回值 |
| `__XLSX_BASE64__` | 固定两行清单工作簿字节（表头：图号/物料编码/物料名称/规格型号/需求数量/需求日期） | §4.2.3 生成命令 |

比对策略口径（从严默认）：金额、计数、比率、状态一律精确；只放行三类自由度——
uuidv7 `id` / `provenance` 溯源列（证据列纪律，`architecture/contracts/
evidence-columns.v1.md`）、ISO 时间戳 60s 容差（先例 `workbench-summary`）、非合同序
数组无序化（列表行序）。骨架策略在**新系统首录后按真实响应形状校准收紧**（首录见
到的响应键与骨架假设不符时，改夹具 `compare`，不改加载器）。

---

## 2. 端到端流程总览

```
 ①起栈 ──→ ②新系统录制 ──→ ③活系统获取（前置：Owner 提供访问方式）
                              │
                              ↓
 ⑥报告解读 ←── ⑤两侧夹具对跑 ←── ④映射表验证（待验证项清零）
```

- ①②③ 可并行推进；④ 是 ⑤ 的硬前置（映射表未清零前对跑只会产出噪声 diff）。
- 每一轮对账的最小闭环：一个模块目录 → 录两侧 → 对跑 → diff 归因 → 回规格澄清。

---

## 3. 前置条件清单

| # | 条件 | 状态（v0.1） | 提供/完成方 |
|---|---|---|---|
| 1 | 本地起栈能力（docker + pnpm） | 已具备（testkit README 快速上手 + 十四模块 MODULES_ENABLED，见 §4.1） | 实施线 |
| 2 | 活系统基址 + 认证方式（账号/token/VPN） | **待 Owner 提供** | Owner |
| 3 | 活系统专用测试租户/测试数据区（写场景唯一合法落点） | **待 Owner 提供** | Owner |
| 4 | 活系统 `ReferenceSource` 适配器实现 | 未实现（形状草案见 §4.3.2，届时另立任务） | 实施线 |
| 5 | 映射表实测（本文 §5，72+4 项待验证） | 未开始 | 实施线 + Owner 访问窗口 |

---

## 4. 操作步骤

### 4.1 起栈（新系统侧）

```bash
# 1) postgres:16（一次性容器即可；对账环境建议固定容器名便于复跑）
docker run -d --name cadence-reconcile-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cadence postgres:16
pnpm --filter @smes/business-store exec prisma migrate deploy --schema prisma/schema.prisma
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cadence \
  pnpm --filter @smes/business-store run db:seed

# 2) server：十四模块全开（九环节 + 四专业包 + core）+ dev 认证（场景身份走 x-smes-user 头）
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cadence \
MODULES_ENABLED=core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing \
SMES_DEV_AUTH=on \
  pnpm --filter @smes/server run dev        # 默认 :3000
```

（形态来源：`e2e-live-db.mjs` 起栈段。种子身份 `user-seed-admin` 域内 bypass——
冒烟身份，dev 边界。）

### 4.2 新系统侧录制

#### 4.2.1 加载冒烟（每次改骨架后先跑）

```bash
pnpm --filter @smes/testkit build    # record-m2.mjs 依赖 dist
node packages/testkit/scripts/record-m2.mjs --list
# 期望：合计 36 场景（自含 19 / 链式 17）；任何骨架格式错误在此 fail-fast 退出码 2
```

#### 4.2.2 自含场景批量录制（19 个）

```bash
node packages/testkit/scripts/record-m2.mjs --target-base-url http://localhost:3000
# 链式 17 个显式 SKIP；自含 19 个逐个写回 reference（脱敏 + recordedAt/recordedFrom）
```

单模块/单场景补录：`--module 03-listing` / `--filter m2-purchase-`。

**幂等与重复录制口径**（重要，避免误读）：

- 创建类命令带固定 `operationId`（`m2rec-*`）：同库重放回首次结果（幂等账本），
  重录不会产生第二份实体；换库重录才建新实体。
- 幂等回放的响应与首次 committed 响应**可能不同形**（如 inventory 按 G1 回首次
  结果、部分命令 replay 回 `已落账` rejected）——若重录后 reference 变化，先读
  diff 再判断是行为漂移还是幂等回放形态，必要时换新库重录。
- 读类场景（列表/汇总）对库内容敏感：录制与对跑之间库未变才可比；对账环境建议
  一次性容器（录完即跑，跑完即弃）。

#### 4.2.3 链式场景：准备链 + 占位符替换（17 个）

准备链按序执行（全部走真实命令，等价 `e2e-live-db.mjs` 各断言链；每步读回 id 与
`objectVersion`）：

| 步 | 命令（新系统） | 产出占位符值 |
|---|---|---|
| A | `POST /workorder/work-orders`（workorder.create.v1，任意 projectName） | `__WORK_ORDER_ID__` |
| B | `POST /inventory/warehouses`（warehouse.define.v1） | `__WAREHOUSE_ID__` |
| C | A 令上 `POST /dispatch/orders`（part）→ `/assign` | `__DISPATCH_ID__`（assign 后） |
| D | C 单上 `POST /reports`（submit） | `__REPORT_ID__`（reported 态） |
| E | 外协单 complete 联动回厂建单（`e2e-live-db` 口径 93 造数 c）或手工 `POST /inspection/orders` | `__INSPECTION_ID__`（pending） |
| F | 不合格判定（failedQty>0）→ `nonconform.dispose`（rework）→ `inspection.recheck` 合格 | `__NONCONFORM_ID__`（可闭环态） |

固定工作簿字节（替换 `__XLSX_BASE64__`，内容与表头冻结——表头别名本身是对账点，
**不许**按活系统改表头）：

```bash
node -e "
const ExcelJS = require('./node_modules/exceljs'); // 仓内已有（不受依赖铁律限制的包用法同 e2e）
" # 形态见 e2e-live-db.mjs 断言③b：addRow(['图号','物料编码','物料名称','规格型号','需求数量','需求日期'])
  # addRow(['DWG-XL-1','C-XL-1','端盖','规格X',3,'2026-11-15'])
  # addRow(['DWG-XL-2','C-XL-2','压盖','规格Y',2,'2026-11-16'])
  # Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')
```

替换后用 `--dry-run` 复核"将跳过=0"，再 `--filter <场景名>` 逐个录。**录制后占位符
已实体化**：夹具从此绑定该库的实体——这正是链式场景要一次性容器的原因（见
§4.2.2 口径）。对跑用同一容器。

### 4.3 活系统侧获取

#### 4.3.1 前置（Owner 三件套）

1. 活系统基址 + 认证（测试账号凭据/token 获取方式）；
2. 专用测试租户/数据区标识（写场景唯一合法落点，§6.3）；
3. 访问窗口与速率约束（活系统是共享环境，录制节奏限流，见 §6.5）。

#### 4.3.2 活系统 ReferenceSource 适配器（形状草案，届时另立任务实现）

`@smes/testkit` 端口已留（`ReferenceSource`：`get(scenarioName) → {status, body} |
null`）。适配器形状草案：

```ts
class LiveSystemHttpSource implements ReferenceSource {
  name = 'live-sieracMes';                 // 报告与 recordedFrom 可追溯
  // 构造入参：baseUrl、认证头、映射表（§5 实测后的 JSON 形态：
  //   { [scenarioName]: { method, path, query?, headers?, body 映射后的载荷 } }）、
  //   响应字段反映射（活系统字段 → 新系统字段，用于把活响应译回新系统形状再比）
  async get(scenarioName: string): Promise<ReferenceOutcome | null> { /* 未实现 */ }
}
```

与"把活响应写进夹具 reference"两条路线（选一，倾向 a）：

- a. **活系统侧录制进夹具**：适配器产出新系统形状的响应，写回
  `m2-scenarios/**` 的 `reference`（`recordedFrom='live-sieracMes'`）——夹具成为
  两侧共用的唯一事实面，对跑走现成 `pnpm reconcile`；
- b. 适配器作为运行时 ReferenceSource 直连对跑——免落盘，但活系统不可达时无法
  复跑，且活响应不落档违背"证据可回放"。

### 4.4 映射表验证（把 §5 的待验证项清零）

逐场景四小步（一个模块目录一批）：

1. 用映射表草案的活系统功能锚点，在活系统上找到对应功能页/接口（黑盒：抓浏览器
   请求或用功能页实测，不读代码/文档）；
2. 实测同输入下活系统的 method/path/字段，回填映射表（活系统两列从"待实测"改为
   实测值；字段差异列如实记：字段名不同/量纲不同/枚举词不同/分页包裹不同）；
3. 映射进适配器（§4.3.2 的映射表 JSON），跑 36 场景的活侧录制（自含先行）；
4. 词汇类差异（状态词/枚举/包裹层）在适配器的反映射层归一，**不**改新系统实现。

### 4.5 两侧夹具对跑

```bash
# 单模块（推荐粒度——报告聚焦，diff 归因快）
node packages/testkit/dist/cli/run.js \
  --fixtures-dir packages/testkit/fixtures/m2-scenarios/03-listing \
  --target-base-url http://localhost:3000

# 全量（活 reference 齐后）
for d in packages/testkit/fixtures/m2-scenarios/*/; do
  node packages/testkit/dist/cli/run.js --fixtures-dir "$d" --target-base-url http://localhost:3000 || break
done
```

（既有 `reconcile` CLI 非递归读目录，故按模块目录循环；这是不改 testkit src 前提
下的既定用法。）`--max-age-days` 门禁照常适用：活 reference 录制超龄会被拒，防拿
陈旧活行为当基线。

### 4.6 报告解读

- 每场景 pass/fail + 字段级 diff（路径精确到 `a.b[2].c: 期望 x 实际 y`）。
- diff 三分法（归因决定去向）：
  1. **词汇差异**（状态词/枚举名/包裹层不同）→ 修适配器反映射（§4.4.4），不修系统；
  2. **口径差异**（数值/判定规则不同）→ 回 m2-drafts 规格，"行为需求重述 + 对账
     反推"澄清后裁定改哪侧（这正是对账的目的：把口径差暴露成字段级证据）；
  3. **真缺陷**（新系统实现违反自家规格）→ 开返工，走常规验收分级。
- `STALE` 行=参考过期（重录）；`filter 未命中`/`0 场景` 一律 fail-fast（假绿防护）。

---

## 5. 输入映射表（活系统侧 = **待验证草案**，实测前不得当作事实）

> 诚实声明：本仓**没有**活系统访问，且清洁室纪律禁止读活系统文档/代码——活系统侧
> 的 method/path/字段**全部待实测**。下表活系统侧只给"功能锚点"（来自合法规格源：
> m2-drafts 各模块依据的功能项编号与名称），作为实测时的寻找起点。
> **待验证计数：36 场景 × 2 单元（活系统 method/path、字段映射）= 72 项，加全局
> 4 项（认证方式、测试租户、状态词对照表、分页/筛选参数口径）= 共 76 项待验证。**

| 场景 | 新系统 input（method path / 载荷要点） | 活系统功能锚点（规格源词汇） | 活系统 method/path | 字段映射 |
|---|---|---|---|---|
| m2-baseline-process-define | POST /baseline/processes/commands · process.define（code/name） | 功能项 10 工序管理 | 待实测 | 待实测 |
| m2-baseline-outsourcing-rule-set | POST /baseline/outsourcing-rules/commands · rule.set（processCode/unitPrice/marginPermyriad） | 功能项 13 外协计价配置 | 待实测 | 待实测 |
| m2-baseline-fault-report | POST /baseline/fault-reports/commands · fault.report（equipmentCode/description/assignee） | 功能项 20 故障上报（127 移动镜像） | 待实测 | 待实测 |
| m2-baseline-routing-define | POST /baseline/routings/commands · routing.define（drawingNo/steps[]） | 功能项 35 工艺路线 | 待实测 | 待实测 |
| m2-baseline-routing-query | GET /baseline/routings/:drawingNo | 功能项 35 工艺路线（按图号查） | 待实测 | 待实测 |
| m2-workorder-create | POST /workorder/work-orders · create（projectName/计划交付/包材到货） | 功能项 24 工作令信息 | 待实测 | 待实测 |
| m2-workorder-list-by-state | GET /workorder/work-orders?state= | 功能项 24 工作令（状态筛选） | 待实测 | 待实测（含状态词对照） |
| m2-workorder-transition | POST /workorder/work-orders/:id/transitions · targetState | 功能项 27~29 三类进度（九态流转） | 待实测 | 待实测（九态词表见 §7） |
| m2-workorder-kit-refresh | POST /workorder/work-orders/:id/kit-checks · kit.refresh | 功能项 30 物料齐套检查 | 待实测 | 待实测 |
| m2-listing-import-part | POST /listing/imports · import（xlsx-bytes，kind=part） | 功能项 31~34 四类清单（导入） | 待实测 | 待实测（表头别名为对账点本体） |
| m2-listing-gap-check | POST /listing/work-orders/:id/gap-checks · gap.check | 功能项 73~76 四类缺口核查 | 待实测 | 待实测 |
| m2-purchase-order-submit | POST /purchase/orders · order.submit（supplier/lines×unitPriceMinor） | 功能项 59~62 采购订单 | 待实测 | 待实测（金额量纲：分 vs 待实测） |
| m2-purchase-details-export | GET /purchase/details/export | 功能项 62 采购明细（可导出） | 待实测 | 待实测（xlsx 结构解析比对） |
| m2-dispatch-create-part | POST /dispatch/orders · create（kind=part，图号×工序随单） | 功能项 38 零件派工 | 待实测 | 待实测 |
| m2-dispatch-create-outsourcing | POST /dispatch/orders · create（kind=outsourcing，已定价行） | 功能项 39 外协派工 | 待实测 | 待实测 |
| m2-dispatch-create-assembly-blocked | POST /dispatch/orders · create（kind=assembly，未齐套，期望拒） | 功能项 40 装配派工（齐套后放行） | 待实测 | 待实测（负行为：拒绝形态） |
| m2-dispatch-list-by-state | GET /dispatch/orders?state= | 功能项 38~43（状态筛选器） | 待实测 | 待实测 |
| m2-report-submit | POST /reports · submit（dispatchId/doneQty/laborMinutes） | 功能项 44~48 五类报工 | 待实测 | 待实测（工时量纲：分钟 vs 待实测） |
| m2-report-submit-batch | POST /reports/batch · submit-batch（lines[]，上限 50） | 功能项 107~114 移动生产作业（批量） | 待实测 | 待实测 |
| m2-report-verify | POST /reports/:id/verify · verify | 功能项 49~53 五类报工核查 | 待实测 | 待实测 |
| m2-report-revoke | POST /reports/:id/revoke · revoke（reason） | 功能项 49~53（撤销） | 待实测 | 待实测 |
| m2-report-mine | GET /reports/mine | 功能项 136 我的报工 | 待实测 | 待实测 |
| m2-inspection-judge | POST /inspection/orders/:id/judgment · judge（passedQty/failedQty） | 功能项 63~66 四类质检 | 待实测 | 待实测 |
| m2-inspection-queue | GET /inspection/orders?state=pending | 功能项 63~66（待检队列） | 待实测 | 待实测 |
| m2-inspection-summary | GET /inspection/summary（合格率/待检/未闭环） | 功能项 63~66（质检汇总） | 待实测 | 待实测（比率口径） |
| m2-inspection-nonconform-close | POST /inspection/nonconformities/:id/close · close | 功能项 63~66（不合格闭环） | 待实测 | 待实测 |
| m2-inventory-warehouse-define | POST /inventory/warehouses · warehouse.define（locations[]） | 功能项 14 仓库与库位 | 待实测 | 待实测 |
| m2-inventory-stock-receive | POST /inventory/stock/receipts · receive（kind=production） | 功能项 77~80 入库 | 待实测 | 待实测 |
| m2-inventory-stock-view | GET /inventory/stock?itemId=（可用量口径） | 功能项 81 实时库存 | 待实测 | 待实测（可用量公式对照） |
| m2-inventory-stocktake-open | POST /inventory/stocktakes · open（盘点双口径） | 功能项 83 盘点 | 待实测 | 待实测（双口径：调账/审计差异） |
| m2-hours-my-month | GET /hours/my?month=（本人已审核） | 功能项 137 我的工时统计 | 待实测 | 待实测（量纲：小时 vs 待实测） |
| m2-hours-month-summary | GET /hours/months/:month/summary（人×工种净额） | 功能项 85 工时汇总 | 待实测 | 待实测（工种五词对照） |
| m2-hours-rebuild-month | POST /hours/rebuild-month · rebuild（幂等） | 功能项 85（汇总重算） | 待实测 | 待实测（活系统是否有等价重算面） |
| m2-costing-model-publish | POST /costing/models · model.publish（hourlyRates 五工种） | 功能项 97 项目成本（口径配置） | 待实测 | 待实测（活系统口径是否可配置） |
| m2-costing-rebuild | POST /costing/rebuild · rebuild（工作令×口径） | 功能项 97（成本归集/重算） | 待实测 | 待实测 |
| m2-costing-summary | GET /costing/work-orders/:id/summary（三分类） | 功能项 97（项目成本呈现） | 待实测 | 待实测（三分类口径对照） |

全局待验证（跨场景，4 项）：认证方式与凭据传递；专用测试租户标识与数据隔离边界；
两侧状态/枚举词对照表（§7）；分页与筛选参数口径（活系统列表面是否分页包裹）。

---

## 6. 风险与边界

1. **数据脱敏（活系统侧红线）**：活系统响应可能含真实客户/供应商/金额/人名——
   适配器落盘前按夹具 `compare.ignore`/`shape` 脱敏（录制器既有语义），另对
   `costing:*` 金额面与 `hours:*` 人名面默认整字段 `ignore`+`shape`，除非 Owner
   明示测试租户数据无敏感成分。reference 落仓前人工抽查一次（手册流程 ③ 的
   checklist 项）。
2. **无写场景优先**：先对齐全部读类场景（列表/汇总/详情/导出），写类场景后行——
   读类零风险且能先暴露大部分词汇与口径差异。
3. **写场景用专用测试租户**：活系统写操作（创建/判定/报工/出入库）只打 Owner
   指定的测试租户/测试数据区；映射表实测阶段发现某写操作无法限定测试区 → 该场景
   挂起并上报 Owner，不打生产数据。
4. **幂等差异**：新系统命令有 `operationId` 幂等键，活系统大概率没有——同输入重放
   活系统可能建重复实体。活侧每场景只打一次；重打前确认活系统行为或在测试租户
   内容忍重复。
5. **限流与访问窗口**：活系统是共享环境，录制批量节奏 ≤1 req/s 量级起步，遇 429/
   限流按全局准则退避重试（30s 起步逐次加倍，≥3 次），多次失败暂停上报 Owner。
6. **时间窗偏差**：两侧录制尽量同窗（读类场景的时间型字段靠 60s 容差兜底；跨天
   录制的"当月汇总"类场景会合理报 diff——重录窄化）。
7. **骨架策略非终态**：`compare` 块是新系统首录前按证据列纪律写的从严默认；首录后
   校准是流程的一部分（§1 口径），但**收紧不放松**——发现策略放过真差异时回写
   夹具并留原因注释。

## 7. ADR-0010 词汇与状态口径

ADR-0010（领域内核通用性纪律）三层：状态集与迁移语义属内核概念、模块 schema 版本化、
**默认配置可按客户口径调整**。对账时的推论：

- 两侧状态**枚举词不同名是词汇差异，不是行为差异**（新系统九态 snake_case：
  `not_started/in_progress/ready_to_ship/shipped/in_acceptance/…`；活系统词汇待实测）。
  对账比较的是**迁移合法集**（同输入下允不允许迁）与**状态分布计数**，不是词面。
- 状态词对照表是映射表的一部分（§5 全局待验证第 3 项），维护在适配器反映射层，
  不进新系统内核。
- 工时量纲（v1.1 冻结：报工载荷=整数分钟、hours 存储=小时不取整）与工种五词
  （part/assembly/electrical/aftermarket/oddjob ↔ machining/assembly/electrical/
  aftercare/misc）是对账的固定锚，活系统侧量纲/词汇差异在反映射层归一并登记。

## 8. 维护与增改纪律

- 新场景必须有 m2-drafts 对应模块 §7 对账要点（或 v1.1 增补裁定）的行为锚点出处，
  写进 `description`；无锚点不收。
- input 只用新系统已实证的请求形态（e2e/控制器/测试载荷）；形态变更（模块 API 演
  进）时改夹具并重录，不留过期形态。
- 场景名全局唯一（`m2-<module>-<behavior>`），`record-m2.mjs --list` 即唯一性与合
  法性冒烟。
- reference 录制来源必须在 `recordedFrom` 可追溯（`http://localhost:3000` = 新系统
  自我一致基线；`live-sieracMes` = 活系统行为基线）；两种来源不要混在同一轮对跑
  的解读里——先活系统基线（行为等价），后新系统基线（回归防漂移）。

---

## 9. 结果登记：新系统侧基线首录（S4 线，2026-10-25）

### 9.1 录制结果

**36/36 场景全部录制成功**（自含 19 + 链式 17，无 SKIP 无失败）；同库自洽对跑
（§4.5 九模块目录循环）**36 通过 / 0 失败**——新系统自我一致基线成立。

录制环境与身份：一次性 docker `postgres:16`（端口 55495，容器 `cadence-m2-rec`）
+ `prisma migrate deploy` + 组织种子；server :3000（`SMES_DEV_AUTH=on`，十模块=
core+九环节）。真实登录链路实证：`POST /auth/login`（admin）→ 201 签发 43 字符
opaque token → `GET /auth/me` Bearer 200（user-seed-admin，admin=true）——准备链
A–F 全程走该 Bearer；场景录制走夹具固定的 `x-smes-user: user-seed-admin` dev 头
（同一 seed 管理员，dev 边界）。

环境指纹：migrate **31 条**入库（最新 `20261026121000_rls_tenant_isolation_replay`）
；seed 完成于 **2026-10-25T14:52:24Z**（users +4 / policies +6，tenant `default`）
；录制窗口 2026-10-25T14:55–15:07Z。库行数快照（录制完成后）：work_orders=2、
dispatch_orders=6、work_reports=4、inspections=2、nonconformities=1、warehouses=2、
purchase_orders=1、listing_lines=2、kit_checks=1、stocktakes=1、labor_entries=3。

### 9.2 录制口径：写类两遍录制法（防误读，重要）

全模块幂等冲突回 `rejected`（application 层统一形态"operationId 已落账，拒绝重复
执行"），与首次 `committed` 响应**不同形**——同库对跑重放写命令必然得到回放态。
因此本轮对 25 个写类场景执行**两遍录制**：首录建实体（committed / 业务拒 / 输入
校验拒），二录把 reference 定格为**幂等回放态**（同输入可无限次重放、零 diff）。
推论：写类场景的 reference 语义 = "命令已落账后的重放行为"，不是首次创建面；
11 个读类场景的 reference = 库终态读值（录制后库不再变更，对跑稳定）。

三个列表场景（m2-workorder-list-by-state / m2-dispatch-list-by-state /
m2-report-mine）用 `--keep-values` 不脱敏录制：comparator 的无 key 无序数组按
canonical 全值配对（ignore 不参与配对），脱敏 reference（无 id/objectVersion）与
实际元素（含）永不配对。库固定值 id/时间戳同库稳定，比对时 ignore 仍生效。
`--keep-values` 为 record-m2.mjs 本轮新增 flag（透传 recordFixtures.keepValues）。

### 9.3 首录暴露的真实行为发现（reference 如实固化，修复后将由对跑报警）

1. **baseline 三命令 + 路线读 500**（m2-baseline-process-define /
   outsourcing-rule-set / routing-define 500，routing-query 500）：
   `PgVersionedMasterStore.versions()`（business-store
   `src/baseline/pg-baseline-stores.ts:108` 附近）`orderBy` 用对象形态
   （`{code:'asc', objectVersion:'asc'}`），Prisma 6.19.3 校验要求数组——
   首命令与版本读路径全炸。属新系统真缺陷（工序库维护 Done-when 不可达），
   修复后这 4 个场景对跑将 500→2xx 报警（安全网预期行为）。
2. **costing 口径错位**（m2-costing-rebuild 201+`rejected`，m2-costing-summary
   404）：骨架 model.publish 用 code=`m2reconcile`，而 rebuild 载荷无 modelCode
   （默认 `standard` 未发布）——三分类汇总对账面在当前骨架 input 形态下不可达，
   需 Owner 裁定骨架修订（publish 改 `standard` 或 rebuild 带 modelCode）后重录。
3. **assembly 拦截面不可达**（m2-dispatch-create-assembly-blocked 400
   "装配派工必须携带工序"）：输入校验（operationCode 必填）先于齐套判定——
   骨架载荷无 operationCode，齐套拦截负行为未被触发；4xx 拒绝面成立但拒绝
   原因与骨架意图（齐套拦截）不同，骨架修订后重录可覆盖真实拦截面。
4. **inspection-summary 的 `generatedAt` 滚动时间字段**：骨架 compare 未 ignore
   它，60s 容差内对跑须紧跟重录（本轮即如此）；任何 >60s 后的对跑该场景必
   FAIL（非行为漂移）。建议 Owner 裁定在 compare.ignore 增补 `**.generatedAt`
   （一行，属"首录后校准"范畴，本轮按"不改比对策略"红线未动）。

### 9.4 诚实边界与复跑方法

- **基线已固化 ≠ 活系统行为**：本轮全部 reference 的 recordedFrom=
  `http://127.0.0.1:3000`（新系统自我一致基线，回归防漂移用）；活系统行为
  对账（行为等价）仍待 Owner 提供访问（§3 前置 2/3），映射表 §5 的 76 项
  待验证一项未动。
- 链式 17 场景的 input 已实体化绑定录制库（实体 id 明文在夹具内）；该库完整
  快照已导出 `fixtures/m2-scenarios/baseline-snapshot-20261025.sql.gz`（31 KB）。
  复跑对跑：`docker run` 新 PG（任意端口）→ `psql` 恢复快照（或 migrate+seed 后
  重跑准备链）→ 起 server（同 §4.1 形态指该库）→ §4.5 九模块循环（inspection-
  summary 须先重录，见 9.3.4）。
- 录制库容器已于本轮收尾清理（手册口径：录完即跑、跑完即弃；快照即回放凭据）。
