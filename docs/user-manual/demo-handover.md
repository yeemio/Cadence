# 演示交接：从零到一条可重放的业务链

读者：接手演示环境的实施/交付人员。目标：按本页操作得到一个**可重放**的演示——起栈 → 造厂（账号+主数据+在制单）→ 登录 → 走一条核心业务链 → 核对结果。
纪律：演示只用合成数据，**不使用真实客户数据**；不再开发第二套演示平台，本页只整理现有资产（角色包、造厂脚本、操作入口）。

事实快照日 2026-10-27。资产来源：`architecture/ROLE-PACKS.md`（岗位与剧本）、`packages/business-store/prisma/seed-factory.mjs`（造厂脚本）、`TESTING-GUIDE.md` §3（起栈）、`noodle-test-output/ui-round2-20261027/BRIEF.md`（账号口令）。

## 0. 前置

- 源码仓 Cadence（含本轮未提交增量时以工作区实态为准）；Docker（compose v2）。
- 宿主机跑造厂脚本需要 Node ≥ 22 + pnpm 11.x（见第 2 步「方式 B」）；只用「方式 A」则不需要。
- 端口 8080 / 3000 / 55432 未被占用。

## 1. 起栈（单机形态，全模块清单）

```bash
cd <仓库根>/deploy
MODULES_ENABLED="core,org,masterdata,workbench,approval,baseline,workorder,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack,audit,standardreports,menu-config,approval-config,notifications,issue,attachment,aftercare-claim,demo" \
  docker compose up -d --build
```

（来源：`TESTING-GUIDE.md` §3、`noodle-test-output/test-handoff-round2-20261027.md` §一。缺省 `MODULES_ENABLED` 只起基础六模块，演示须显式传全清单。）

## 2. 健康核对（栈起来后先核对再演示）

| 检查 | 命令/地址 | 预期 |
| --- | --- | --- |
| API 健康 | `curl http://localhost:3000/health` | `{"status":"ok","tenant":"default"}`，HTTP 200 |
| 模块清单 | `curl http://localhost:3000/modules` | 27 个模块 |
| 桌面入口 | 浏览器 `http://localhost:8080` | 登录页（中文） |
| 移动入口 | `http://localhost:8080/m` | 移动工作台 |

## 3. 造厂（工厂种子：六岗账号 + 主数据 + 五张在制单）

造厂脚本是 `packages/business-store/prisma/seed-factory.mjs`，带**显式门**：必须 `SMES_FACTORY_SEED=on` 才执行，缺省拒跑（防误触）。**注意：compose 的 migrate 一次性服务缺省只跑基础种子（`db:seed`），不会自动跑工厂种子**（来源：`deploy/compose.yaml` migrate 服务 command 段）——因此造厂是起栈后的一次显式步骤，二选一：

**方式 A：经 migrate 一次性服务容器（推荐，superuser 侧，与脚本设计路径一致）**

```bash
cd <仓库根>/deploy
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

- 多级审批演练前，管理员先给 plan 角色补 `parts:approve`（开放缺陷 AP-SEED-01 的现场处置）；二级/三级演练账号 `level2-user`/`level3-user` 能登录但不在登录页清单。
- 这些属于「已知勿报」项，演示中遇到不要当现场故障排查。

## 5. 走一条链（两条可选路径）

**路径一（短，用种子的在制链续走，约 15 分钟）**——从造厂产物直接续：

1. `prod01` 移动端 `/m/report`：对执行中派工单报工（数量+工时）→ 提交成功「操作已生效」。
2. `qc01` `/inspections`：判定末道触发的质检单（合格数=送检数）→ 判定成功。
3. `wh01` `/inventory/stock-operations`：质检放行入库（引质检单号）→ 流水号回显。
4. `plan01` `/workorders`：刷新齐套检查 → 缺口收敛；`prod01` `/dispatches`：建装配派工单 → 建单成功并**自动生成发料任务**（ISS-ASM- 编号）。派工建单按 ROLE-PACKS 归生产岗（`dispatch:write`），且装配类被齐套硬闸拦截——缺口未收敛前建单会被中文拒因拒绝（安装验收实测更正：本步原文误写 plan01 建单）。
5. `wh01`：发料确认（接口面，无桌面页——现场说明该限制）→ `/inventory/stock` 看现存量与预占同减。
6. `plan01` `/workorders/parts`：新建配件申请 → `plan01` 批准（plan01 兼任夹具工作令项目经理=一级审批人，AP-SEED-01 已补 `parts:approve`；安装验收实测可批）→ `plan01`「发货（联动出库）」。
7. `viewer` 另一浏览器随行：任意页尝试提交 → 403（权限拒绝证据）。

**路径二（全，22 步主线链）**：从建令开始完整走 [journey-core-chain.md](journey-core-chain.md) 的逐步表（含采购下单/审核/收货/来料质检全链）。

## 6. 核对清单（演示结束前逐项过）

| # | 核对点 | 位置 | 预期 |
| --- | --- | --- | --- |
| 1 | 健康三面 | 第 2 步表 | 200 / 27 模块 / 双入口可达 |
| 2 | 岗位账号可登录 | 登录页 | 六岗 + admin + viewer 全部 201 |
| 3 | 报工成功提示 | 移动报工 | 「操作已生效。」 |
| 4 | 末道质检单自动生成 | `/inspections` 队列 | 出现来源=报工的待检单 |
| 5 | 库存上升 | `/inventory/stock` | 放行件入仓后现存量上升 |
| 6 | 装配派工与发料任务 | `/dispatches` + 接口 | 装配单建成；ISS-ASM- 任务存在 |
| 7 | 发料核销 | `/inventory/stock` | 现存量与预占同减、可用量不变 |
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

造厂脚本幂等，部分重置后重跑即可对齐；彻底重置后需重新造厂。数据保留与备份注意事项见 [../../deploy/README.md](../../deploy/README.md)「数据保留」。

## 8. 演示中遇到异常

1. 先查 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md) 是否为已登记设计内行为/已知限制/开放缺陷（BRIEF 口径：「已知勿报」清单同源）。
2. 是环境问题（容器退出/健康不过）→ 按 [../../deploy/README.md](../../deploy/README.md)「日志定位」查 `docker compose logs`，必要时 `down -v` 重置重来（演示环境数据可弃）。
3. 演示环境完全授权：可点批准/驳回/提交等操作（来源：`BRIEF.md`），但**不 commit/push、不改产品代码**。
