# 演示交接：从零到一条可重放的业务链

读者：接手演示环境的实施/交付人员。目标：按本页操作得到一个**可重放**的演示——起栈 → 造厂（账号+主数据+在制单）→ 登录 → 走一条核心业务链 → 核对结果。
纪律：演示只用合成数据，**不使用真实客户数据**；不再开发第二套演示平台，本页只整理现有资产（角色包、造厂脚本、操作入口）。

事实快照日 2026-10-28（设备维链候选待主控接收）。资产来源：`architecture/ROLE-PACKS.md`（岗位与剧本）、`packages/business-store/prisma/seed-factory.mjs`（造厂脚本）、`TESTING-GUIDE.md` §3（起栈）、`noodle-test-output/ui-round2-20261027/BRIEF.md`（账号口令）。

## 0. 前置

- 源码仓 Cadence（含本轮未提交增量时以工作区实态为准）；Docker（compose v2）。
- 宿主机跑造厂脚本需要 Node ≥ 22 + pnpm 11.x（见第 2 步「方式 B」）；只用「方式 A」则不需要。
- 端口 8080 / 3000 / 55432 未被占用。

## 1. 起栈（单机形态，全模块清单）

```bash
cd <仓库根>/deploy
export MODULES_ENABLED="core,org,masterdata,workbench,approval,baseline,workorder,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack,audit,standardreports,menu-config,approval-config,notifications,issue,attachment,aftercare-claim,demo,column-preferences,screen,ai-query"
docker compose up -d --build
```

（来源：`TESTING-GUIDE.md` §3、`noodle-test-output/test-handoff-round2-20261027.md` §一。缺省 `MODULES_ENABLED` 只起基础六模块，演示须显式传全清单。）

## 2. 健康核对（栈起来后先核对再演示）

| 检查 | 命令/地址 | 预期 |
| --- | --- | --- |
| API 健康 | `curl http://localhost:3000/health` | `{"status":"ok","tenant":"default"}`，HTTP 200 |
| 模块清单 | `curl http://localhost:3000/modules` | 30 个模块 |
| 桌面入口 | 浏览器 `http://localhost:8080` | 登录页（中文） |
| 移动入口 | `http://localhost:8080/m` | 移动工作台 |

## 3. 造厂（工厂种子：六岗账号 + 主数据 + 五张在制单）

造厂脚本是 `packages/business-store/prisma/seed-factory.mjs`，带**显式门**：必须 `SMES_FACTORY_SEED=on` 才执行，缺省拒跑（防误触）。**注意：compose 的 migrate 一次性服务缺省只跑基础种子（`db:seed`），不会自动跑工厂种子**（来源：`deploy/compose.yaml` migrate 服务 command 段）——因此造厂是起栈后的一次显式步骤，二选一：

**方式 A：经 migrate 一次性服务容器（推荐，superuser 侧，与脚本设计路径一致）**

```bash
cd <仓库根>
docker compose -f deploy/compose.yaml run --rm -e SMES_FACTORY_SEED=on migrate \
  sh -c 'pnpm --filter @smes/business-store run db:seed-factory'
```

（脚本头注注明其设计运行方式为「superuser 经 migrate 服务跑」。**安装验收实测提示（2026-10-27）**：起栈时若用了自定义端口/env（如 `PG_PORT`），`compose run` 必须带**同款 env 且加 `-p <同一 project>`**，否则 compose 会按缺省配置 recreate pg 容器、可能撞端口或丢失自定义拓扑——实测缺 env 的 run 触发了 pg recreate 并因端口冲突失败。简便替代：直接用方式 B。）

**方式 B：宿主机直跑（Node ≥22 + pnpm）**

```bash
cd <仓库根>
SMES_FACTORY_SEED=on \
DATABASE_URL="postgresql://postgres:cadenceSingleNodeDev@127.0.0.1:55432/cadence" \
  pnpm --filter @smes/business-store run db:seed-factory
```

（缺省口令来源：`deploy/compose.yaml` `POSTGRES_PASSWORD` 缺省值；PG 端口映射 `127.0.0.1:55432` 来源：compose 与 `TESTING-GUIDE.md` §3。生产环境口令以部署实态为准。）

造厂脚本幂等：重跑零新增、不动既有行（来源：`seed-factory.mjs` 头注）——演示前重跑一遍是安全的「对齐」动作。

**造厂产物**（来源：`seed-factory.mjs` 头注「七岗位口径」「在制链」节）：

- 六个岗位账号：`plan01` / `purch01` / `prod01` / `qc01` / `wh01` / `appr01`，口令统一 `demo-password`；第七岗只读观察由既有 `viewer` 承担（零策略全拒形态）。
- 主数据：物品、供应商引用、工厂仓（含货架+库位层级）。
- 五张在制单（全部挂在同一个工作令 `wo-seed-factory-01` 下）：工作令（四类清单骨架齐，零件清单已导入 5 行）、采购订单（已下发、待收货）、派工单（执行中、待报工）、质检单（待判定）。

## 4. 登录与演示账号

| 用途 | 账号 | 说明 |
| --- | --- | --- |
| 管理员兜底/开通调整 | `admin` | 全量放行 |
| 岗位走链 | 六岗 `plan01…appr01` | 见 [roles/](roles/) 各岗位手册 |
| 只读随行 | `viewer` | 全拒形态：菜单基本全隐、深链被拒——演示「权限拒绝」用 |
| 口令 | `demo-password` | 全部演示账号统一 |

已知演示注意（详见 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md)）：

- 当前工厂种子已给计划岗 `parts:approve`；二级/三级账号为 `level2-user`/`level3-user`，只有显式配置多级审批时才演练相应级。已有环境的历史权限不会被本轮自动改写。
- 采购实收请从订单收货动作的仓库选项选择仓库；成功后同时核对订单已收数量、收货来源和库存流水。

## 5. 走一条链（两条可选路径）

**路径一（从工厂种子续走）**——种子不是齐套完成态，先区分工序与库存需求：

- 种子执行中单 `dsp-seed-factory-01` 是 `DWG-001 × OP-001`，数量 10；报工不会触发末道质检。该图工艺末道是 `OP-005`。
- 要演示报工触发质检，先用生产岗在同一工作令下创建、指派并开工一张 `DWG-001 × OP-005` 派工，再对这张末道单报工。不要把 OP-001 报工成功误当待检自动生成。
- 工厂清单有五行需求：圆钢 12、轴承 4、钢板 6、接触器 8、焊丝 5。一次报工一件并不能让五行齐套。完整装配演示须先按清单逐行完成对应合法来源的报工/质检/入库或采购收货，保留每笔来源和物料。不得通过另一仓随意补库存冒充同一流转链。

1. `prod01` 移动端 `/m/report`：对上述执行中的 **OP-005 末道单**报工（数量+工时）→ 提交成功「操作已生效」。
2. `qc01` `/inspections`：判定末道触发的质检单（合格数=送检数）。若来源只提供图号，须在判定前从「放行物料」选择真实物料；同一图号可能含多个物料，不会自动猜测。物料与判定同时保存，已有物料不可改绑。
3. `wh01` `/inventory/stock-operations`：选择「质检放行入库」，从可入库放行单中选择本单，物料自动带出；选择仓库并确认余量→流水号回显。放行无物料、物料未知/停用或请求物料不符，服务端拒绝入库。
4. `plan01` `/workorders`：在工作令详情维护真实设备（设备编码、名称、数量、自制/外购），在清单新增/导入时明确关联本工作令设备。零件、标准件、电气件关联自制设备；外购设备清单关联外购设备。旧清单的空设备关联不会被自动补造；已有行可用 `POST /listing/lines/:id/update` 显式提交 `equipmentRef`，有预占/任务的行不允许直接改关联。逐行核对同批来源入库与清单物料一致，在「缺口核查」执行检查生成设备维利库预占，再刷新工作令齐套检查。
5. `prod01` `/dispatches`：缺口收敛后创建装配派工（`OP-007`）或电气派工（`OP-008`），选择本令真实自制设备并指派执行人；**指派成功**才同步相应设备发料任务。外购设备归拢须显式选择，任务只含 equipment 行，不混入自制零件或售后行。`wh01` 通过既有发料接口确认实际任务（桌面发料页仍待实现）：part 记录预占来源拆分快照，equipment 记录归拢发料，二者不直接扣实时库存；standard/electrical 必须选择真实库位，确认后现存量及对应设备预占同减，撤销按原来源恢复。必须按类别读回任务、发料记录、库存与流水，不可用同一扣账断言概括全部类别。
6. `plan01` `/workorders/parts`：新建配件申请 → `plan01` 批准（plan01 兼任夹具工作令项目经理=一级审批人，AP-SEED-01 已补 `parts:approve`；安装验收实测可批）→ 按配置完成全部审批级，再由 `plan01`「发货（联动出库）」。发货前后核对同一物料同一仓的现存量差值=发货数量，并在出库流水中读回申请关联；不能仅凭「已发货」状态宣称库存链完成。
7. `viewer` 另一浏览器随行：任意页尝试提交 → 403（权限拒绝证据）。

**路径二（全，22 步主线链）**：从建令开始完整走 [journey-core-chain.md](journey-core-chain.md) 的逐步表（含采购下单/审核/收货/来料质检全链）。

## 6. 核对清单（演示结束前逐项过）

| # | 核对点 | 位置 | 预期 |
| --- | --- | --- | --- |
| 1 | 健康三面 | 第 2 步表 | 200 / 30 模块 / 双入口可达 |
| 2 | 岗位账号可登录 | 登录页 | 六岗 + admin + viewer 全部 201 |
| 3 | 报工成功提示 | 移动报工 | 「操作已生效。」 |
| 4 | 末道质检单自动生成 | `/inspections` 队列 | 出现来源=报工的待检单 |
| 5 | 库存上升 | `/inventory/stock` | 放行件入仓后现存量上升 |
| 6 | 装配派工与发料任务 | `/dispatches` + 接口 | 装配单建成；ISS-ASM- 任务存在 |
| 7 | 发料分类核对 | 任务/记录接口 + `/inventory/stock` | part/equipment 不直接扣库存；standard/electrical 真实库位扣减与预占核销，撤销恢复 |
| 8 | 配件审批链 | `/workorders/parts` | submitted→approved→shipped 全程状态可见 |
| 9 | 只读拒绝 | viewer | 提交 403 |
| 10 | 已知限制如实呈现 | — | 发料确认无桌面页、报表无导出——按 KNOWN-BEHAVIORS 口径说明，不承诺 |

## 7. 收栈与重置

```bash
# 收栈（保留数据卷，下次 up 直接续用）
docker compose -f deploy/compose.yaml down --remove-orphans

# 彻底重置（**删除全部数据**，含造厂数据；重置后按 §1→§3 重来）
docker compose -f deploy/compose.yaml down -v --remove-orphans
```

造厂脚本幂等，不覆盖已存在单据；部分重置后重跑仅补缺项；彻底重置后需重新造厂。数据保留与备份注意事项见 [../../deploy/README.md](../../deploy/README.md)「数据保留」。

## 8. 演示中遇到异常

1. 先查 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md) 是否为已登记设计内行为/已知限制/开放缺陷（BRIEF 口径：「已知勿报」清单同源）。
2. 是环境问题（容器退出/健康不过）→ 按 [../../deploy/README.md](../../deploy/README.md)「日志定位」查 `docker compose logs`，必要时 `down -v` 重置重来（演示环境数据可弃）。
3. 演示环境完全授权：可点批准/驳回/提交等操作（来源：`BRIEF.md`），但**不 commit/push、不改产品代码**。
