# M2 两项剩余技术证据接收

2026-10-31（Asia/Shanghai）｜唯一执行总控：`01a190b8-b764-7473-852d-cfe62d232c07`

**结论：本轮两条 Sol-6.1-high 并行任务均作有范围技术 ACCEPT。** 没有产品源码修改；准确候选仍为 `f0b910c46be56494bb0a2c3d4545b4e9b0fe3046`，产品源码版本 `0425ded838a87b8aeab3cfc300097a985bde2bd2`。本次接受不等于 M2 整体产品、客户部署或真实客户业务接受。

## 接收结果

| 任务与执行者 | 主控确认的结果 | 稳定原件 |
| --- | --- | --- |
| `m2-pdf-visual` / `/root/m2_pdf_visual` / Sol-6.1-high | A/B PDF各一页，实际渲染清晰非空；A/10mm、B/12mm与具名v1/v2修订记录对应。主控已看两张PNG，核对原件哈希及候选/产品Git blob绑定。它们是文字合成fixture，不是生产工程图。 | [PDF交付](../../../cadence-runkit-m2/evidence/pdf/DELIVERY.md)、[结果与映射](../../../cadence-runkit-m2/evidence/pdf/RESULT.json)、[A图](../../../cadence-runkit-m2/evidence/pdf/mfgcap-drawing-A-page-1.png)、[B图](../../../cadence-runkit-m2/evidence/pdf/mfgcap-drawing-B-page-1.png) |
| `m2-cost-history` / `/root/m2_cost_history` / Sol-6.1-high | 实际服务命令在独立PG建立两套非空成本历史链：三分类事实2行、项目事实4行、各2个快照。图纸/工艺B发布、EC冻结、独立运营批准及解冻后，8组成本表/事件完整行零差量；明确调价后不重建也不自动改写。显式rebuild各追加v3与delta，所有旧行字段保持不变。 | [成本交付](../../../cadence-runkit-m2/evidence/cost/DELIVERY.md)、[结果](../../../cadence-runkit-m2/evidence/cost/RESULT.json)、[变更前原行](../../../cadence-runkit-m2/evidence/cost/rows/before-ec.json)、[批准后原行](../../../cadence-runkit-m2/evidence/cost/rows/after-approve.json)、[显式重建后](../../../cadence-runkit-m2/evidence/cost/rows/after-explicit-rebuild.json) |

成本快照的合成金额为 v1=9651分、v2=12657分；最后明确调价并重建才产生v3=15663分。非零来源是外协，不把部分零金额类别或空价格表当作全面非零验证。未直接SQL插入成本样本，SQL仅读取本轮隔离库的完整行；变更由工程角色请求、另一运营角色批准。主控读取实际命令回执及EC/B绑定，重新比较冻结原件的完整行并确认旧行不变，未重跑业务场景。[主控读回](../../../cadence-runkit-m2/evidence/setup/controller-acceptance-readback.json)。

## 当前绑定与保护面

Owner 已明确“允许安装并绑定，随后直接派工”。独立控制目录 `/Users/yeemio/AI/gitrep/cadence-runkit-m2` 已固定安装 `owlrunkit@0.23.0`，package/lock、项目CLI/Core、Config与官方registry adoption匹配，当前项目 `cadence-m2-evidence-closeout-20261031` 的两项assignment已实际派发并由本主控接收。原两个历史账本、全局Skill与Cadence产品依赖未修改。

本轮使用 managed continuity / assurance none。控制目录没有应用测试脚本，自动bootstrap/doctor保留空profiles提示；它没有用于Quick/Formal验证，不把有效Project Driver绑定写成全部自动诊断通过。[绑定说明与失败原件](../../../cadence-runkit-m2/evidence/setup/BINDING.md)。

两份候选独立checkout于准确提交，源码未改。成本服务与迁移镜像各991项真实server构建输入一致。主仓PM三个入口、原有三份output脏文件及产品源码均保留；主控读回证明本轮未覆盖它们。现有干净安装、单机/SaaS、P2-06、SP-5与语言范围决定直接复用，未重开历史19项复测。

## 失败、收尾与未证边界

- PDF验证脚本的1次成功状态码误判、成本线5次harness错误及1次seed调用开关拒绝均保留，原writer从准确恢复点修正；没有产品实现失败证据。成本首次身份失败stdout未单独落盘，第二次同因完整输出及后续失败均留存，不补造首轮原件。
- 仅停止本轮独立PG/server；数据卷、停止的容器、私有恢复配置和证据保留。常驻共享容器的ID/镜像/启动时间/端口状态未变；未连接共享数据库。server停止后退出137，未证明优雅退出，不将其列为本轮完成的能力。
- 原IAB PDF查看器两次空白仍为未证，本地PDF可读不证明内置查看器已修好。当前两份fixture的真实生产图纸质量、真实历史客户/共享成本数据、全部成本类别的非零行为仍未验证。
- 三个原历史对象404的出处保持UNKNOWN；D-18非阻断、语言第3波延期及其它原范围外模型保持既定边界。本轮没有commit/push、共享升级、发布或客户部署。

**本轮停止条件已满足。** 技术证据已供Cadence-PM读取，M2整体产品范围与可交付性接受仍归PM；没有自动进入M3。后续依PM/Owner具名决定推进，不再为本候选重复验收或新增研究链。
