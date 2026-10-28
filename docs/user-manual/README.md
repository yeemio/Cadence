# Cadence 用户手册（入口）

读者：未参与开发的使用者——按岗位使用系统的操作人员、管理员，以及做安装与演示交接的实施人员。
本手册说明：每个岗位能做什么、怎么操作、预期看到什么、被拒绝时怎么办；当前版本的限制与故障处理见 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md)。

口径声明（读手册前必读）：

- 本手册描述**当前版本的实际行为**，事实快照日 **2026-10-27**。界面文案、菜单结构、账号以你手上系统的实态为准；发现与手册不一致时，先查 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md) 是否已登记为设计内行为或已知限制。
- 手册不承诺「一键安装成功」。安装与部署步骤见 [../deploy/README.md](../../deploy/README.md)，安装验收是独立环节。
- 每节关键事实在文内标注来源文件（仓库内路径）。本手册不复制需求规格全文；想知道「产品应该是什么」以 `architecture/requirements/`（PRD v1.0）为准。

## 1. 文档索引

| 文件 | 内容 | 读者 |
| --- | --- | --- |
| [getting-started.md](getting-started.md) | 登录、界面总览（桌面/移动）、语言切换、账号清单、通用界面约定 | 所有人 |
| [journey-core-chain.md](journey-core-chain.md) | 一条核心业务链的全程走法（建令→清单→齐套→采购→收货→质检→派工→报工→末道质检→入库→发料→配件申请→审批→发货） | 全体操作岗、实施 |
| [roles/planner.md](roles/planner.md) | 计划岗：建令、清单、缺口核查、齐套、配件申请发起 | 计划 |
| [roles/purchaser.md](roles/purchaser.md) | 采购岗：采购申请、建单、下发、收货、退货 | 采购 |
| [roles/production.md](roles/production.md) | 生产岗：派工、转单、移动报工、故障上报 | 生产/车间 |
| [roles/inspector.md](roles/inspector.md) | 质检岗：质检队列、判定、复检、特采、不合格处置 | 质检 |
| [roles/storekeeper.md](roles/storekeeper.md) | 仓管岗：入库、出库、调拨、盘点、发货、仓库货架 | 仓储 |
| [roles/approver.md](roles/approver.md) | 审批岗：采购订单审核、配件申请审批（多级链） | 审批/管理 |
| [roles/observer.md](roles/observer.md) | 只读观察岗：全程可见、不可操作 | 观察/审计 |
| [roles/admin.md](roles/admin.md) | 管理员：岗位开通、角色授权、口令与账号、审批链配置 | 管理员 |
| [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md) | 设计内行为、已知限制、尚未支持事项、当前已登记缺陷、处理办法 | 所有人 |
| [demo-handover.md](demo-handover.md) | 演示交接：从零起到可重放演示（账号→造厂→走链→核对） | 实施/接手人 |
| [../../deploy/README.md](../../deploy/README.md) | 部署：版本依赖、单机/SaaS 配置、初始化、健康检查、日志、更新与恢复 | 实施/运维 |

## 2. 业务旅程总图（岗位在链上的位置）

核心业务链（来源：`architecture/ROLE-PACKS.md` §2，依据 PRD 01-总纲 §4 主流程链）：

```
计划 ──建令→ 清单展开 ──缺口核查──→ 采购（申请→订单→审核→下发）
                                        │
                              仓管收货 ←─┘
                                │
                              质检判定（来料）
                                │
                              仓管入库放行件
                                │
生产 ←──料齐可开工── 计划（齐套复核）
  │ 派工→开工→报工（末道自动触发质检）
  │                    │
  │                 质检判定（末道）
  │                    │
  └─转单换人         仓管入库（完工件）
                                │
计划（齐套复核→装配派工→自动生成发料任务）→ 仓管确认发料
                                │
配件申请（计划发起）→ 审批（多级链）→ 发货联动出库（计划）
                                │
只读观察岗：全程可见、不可操作（随行）
```

各步的前置条件、操作入口、预期结果与交接去向，见 [journey-core-chain.md](journey-core-chain.md) 的逐步表。

## 3. 岗位与权限的基本规则

1. **菜单可见 = 接口可达**：左侧菜单按你的角色权限投影；看不到某菜单项，说明该角色未被授予对应权限，而不是系统故障（来源：`apps/web/src/menu.ts` 头注、`architecture/ROLE-PACKS.md` §0）。
2. **防线在后端**：页面上的操作按钮不做按角色的隐藏，无权限时提交会被后端拒绝（403 / 错误提示）。看到报错先确认自己角色是否有该动作权限（来源：`architecture/ROLE-PACKS.md` §0「界面级口径」）。
3. **每人一岗**：七岗位标准角色包的权限码互斥设计（申报与审批分离、判定与入库分离等），详见各岗位手册「明确不授予」节（来源：`architecture/ROLE-PACKS.md` §1）。
4. 全员基线：所有角色都有工作台入口与顶栏通知中心两个只读权限（来源：`architecture/ROLE-PACKS.md` §1「全员基线两码」）。
