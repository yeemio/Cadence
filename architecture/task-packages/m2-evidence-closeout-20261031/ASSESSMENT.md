# M2 剩余证据综合评定与并行执行范围

日期：2026-10-31｜唯一执行总控：`01a190b8-b764-7473-852d-cfe62d232c07`（Owner 指定 Astra-max）

Owner 本轮指令：“你来综合评定后，派sol并行完成接下来的工作。”本文件是当前 M2 的新增差量，不重开历史验收，不替代 PM 的产品接受。状态：Owner 已明确“允许安装并绑定，随后直接派工”；独立绑定与两条原生 Sol-6.1-high 并行执行已完成，本总控对两项稳定结果均作有范围技术 ACCEPT，详见[最终交付](../../../output/m2-evidence-closeout-20261031/DELIVERY.md)。

## 评定

- 当前提交 `f0b910c46be56494bb0a2c3d4545b4e9b0fe3046` 已按上轮具体授权推送；产品源码仍为 `0425ded838a87b8aeab3cfc300097a985bde2bd2`。依据 [Git 读回](../../../output/m2-clean-install-20261031/GIT-DELIVERY.json)。旧 DELIVERY 中“未提交”等描述保留为冻结时点，不能覆盖后续 Git 回执。
- [准确候选干净安装、单机/SaaS 与 P2-06](../../../output/m2-clean-install-20261031/DELIVERY.md)技术 ACCEPT 可复用。SP-5 已按 Owner“维持现状”销项；第 3 波已明确延后到客户语言确认，不再把两项列为当前实施阻塞。
- [MFG01 接收](../../../output/mfg01-capabilities-20261028/PARENT-ACCEPTANCE.md)明确留下 A/B 图纸 PDF 视觉和历史成本快照不被工程变更回写的样本缺口。它们可以各用独立的可定位证据闭合，选作本轮两条并行线。不能将新合成样本冒充过去已有客户/共享数据的历史事实。
- 原 WO/NC/IQ 三个 404 缺少原报告的提交/数据卷来源，保留 UNKNOWN；本轮不扫描其它数据库，也不虚构丢失或恢复结果。
- D-18 保留非阻断。完整 RES/RTN、CLM01、PO A/B 业务版/应付、SCN09、完整 IQ/IP/FQ、工艺批准返工、D-22 导出及真实身份 clearance 工程不纳入。M3 客户/数据/业务接受与 M4 运营另有进入条件。

本轮主要缺口是这两个已知技术声明的证据完整性，现已按具名边界补齐。本总控已接收技术结果并提供 PM 可读取的稳定记录；应用内PDF查看器、真实历史数据与M2整体产品范围接受保持各自未证/责任边界，不直接启动客户试点。

## 两个有界 Sol 任务

| 任务 | writer / 选型理由 | 允许工作与完成条件 | 保护和停止条件 |
| --- | --- | --- | --- |
| `m2-pdf-visual` | Sol-6.1-high；Owner 本轮明确选择 Sol，独立文档内容与渲染核对 | 读取当前 A/B 图纸 fixture、既有 HTTP 字节身份和具名修订绑定；使用本地 PDF 渲染工具查看实际页面，核对非空、可读、A/B 区分、版本对应；原 IAB PDF 查看器两次空白的失败保留。输出 PDF 哈希、渲染图与结论，局部真实缺陷回本总控限定修复。 | 初始仅证据目录可写；产品只读；不增加 PO 业务版/权限门，不反复重试已失败浏览器路径，不操作共享浏览器。具名视觉证明完成或确认工具/输入缺口后停止。 |
| `m2-cost-history` | Sol-6.1-high；独立现有成本与工程变更合同的具名集成证据 | 沿用原成本快照/显式重建规则，在独立环境建立工程变更前样本，再执行现有冻结/版本变更/批准链，读回旧成本事实未被自动改写；必要时补一个当前候选的针对性行为证明。区分“不回写旧事实”与“显式重建允许产生新结果”，不得重新设计成本算法。 | 初始证据/临时场景脚本可写，独立数据库可写；源码只读，真实缺陷先回本总控；不写共享数据库、真实客户数据、迁移或旧证据。证明具名不变性或确认真实数据/合同缺口后停止。 |

两条线从同一准确提交形成隔离候选目录；不改当前 main、不覆盖已有 output 和 PM 修改。正式 assignment 绑定实际目录、原件、返回事件与可写路径后启动。只用原生 collaboration/native final 向 `/root` 回传；不跨聊天发送给 PM。主控保留回合等待稳定结果，只验收一次；不重跑已覆盖全仓业务链，不另加审查代理。

## 当前 RunKit 缺口与具体方案

当前产品仓未声明或安装 RunKit。仓外 `cadence-runkit` 的 `cadence-dual-lane-20261025` 和 `cadence-runkit-s3` 的旧目标保持原状，不能改名/复制为当前 M2。

拟在新目录 `/Users/yeemio/AI/gitrep/cadence-runkit-m2` 建立本次唯一控制 workspace，固定安装旧项目已具备官方来源记录的 `owlrunkit@0.23.0`（不顺带升级版本），生成本目录 package/lock 与 package-bound 配置。用其支持的 Project Driver 初始化当前已授权 M2 目标，绑定上述两条任务与本总控；仅本总控写控制记录。旧账本、全局 Skill、Cadence 产品依赖及运行环境不动。

本操作已于同日获 Owner 明确授权并执行。以下保留原权限依据：这是新增本地依赖/绑定操作，[controller-modes](/Users/yeemio/.codex/skills/controller-modes/SKILL.md)要求缺绑定时先补精确权限，原接管包也明确未授予安装/迁移权限。当前 exact package/lock、CLI/Core、Config 与官方 registry adoption 已匹配；当前项目定义与两条 assignment 已通过 Project Driver 写入并读回。旧账本和共享 Skill 未改。绑定说明及原始输出见 `/Users/yeemio/AI/gitrep/cadence-runkit-m2/evidence/setup/BINDING.md`；该控制目录没有应用测试脚本，doctor 的空 profiles 提示如实保留，本轮仅用 managed continuity、assurance none，不声称 Quick/Formal 验证。

## 验收与停止

接收两个稳定结果后，按准确候选给出各自 ACCEPT / REWORK / BLOCKED，技术结论与真实历史数据/客户业务边界分开。涉及真实缺陷时先确认根因与最小改动范围；不启动严格 TDD，不因新测试而加审查链。达到上述结果即停止，不自动 commit/push、部署、发版或进入 M3。PM 三个入口由 PM 单独维护。

## 实际派工

- 原生 `/root/m2_pdf_visual`：Sol-6.1-high，`as-m2-pdf-r1` / `m2-pdf-visual`；候选目录 `/Users/yeemio/AI/workspaces/cadence-m2-pdf-20261031-2c07`；唯一证据写目录 `/Users/yeemio/AI/gitrep/cadence-runkit-m2/evidence/pdf/`。
- 原生 `/root/m2_cost_history`：Sol-6.1-high，`as-m2-cost-r1` / `m2-cost-history`；候选目录 `/Users/yeemio/AI/workspaces/cadence-m2-cost-20261031-2c07`；唯一证据写目录 `/Users/yeemio/AI/gitrep/cadence-runkit-m2/evidence/cost/`及本任务新建隔离数据环境。

两项均绑定 `f0b910c46be56494bb0a2c3d4545b4e9b0fe3046`。控制状态以 `/Users/yeemio/AI/gitrep/cadence-runkit-m2/.owlcoda/runkit/project/` 为准；本节是实际派工定位，不是额外状态账本。
