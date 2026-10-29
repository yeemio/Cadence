# MFG01缺陷差量交付（worker evidence，待父级接收）

**assignment** `MFG01-DEFECT-DELTA-20261028`；事件 `mfg01-delta-v1`；writer `/root/cadence_remaining` / gpt-6.1-sol high，父 `/root`（chat 01a17d85-16ec-7c42-a86d-7d42711031a3）。当前差量已实现并冻结，不把MFG01全功能报告整体宣称通过。

基础HEAD `ae7a615a86a84817947cd388edd1c1096c439dc9`；当前19路径候选聚合 `6362a8a771c1265e0b507ac8ed6ea92fd8d6b03f210761d32465292b2ac7a8f5`。每文件SHA及明确path排序格式见 CANDIDATE-MANIFEST.json，精确路径见CHANGED-PATHS.txt；candidate.patch同时包含跟踪文件差量和两个新增源码文件，manifest路径均可读取。无commit/push/发布；原105产品验收结果按不受影响范围复用。

## 实际修改

- 仓管已有purchase:receive却被完整purchase:read页面阻挡：新增动作自己的最小订单投影、专用收货页与正确菜单闸。只暴露待收身份/供应商名/行物料数量/类别可判别性，不返单价、金额、申请和审批人员信息，不给角色加码。逐行一次收货定稿沿原合同，未造分批模型。
- 合法收货→采购质检原接线正常；无申请/多kind歧义只warn不可观察已修为逐行回执和UI提示，失败不掩盖成成功建检，仍保留通知式不回滚收货。原种子无来源未盲改；新的实际三类申请链与文档可复现。
- 既有预占创建/核销/释放数量逻辑保留，新增stock:read只读追溯与来源/状态/余量，补报告无法可靠找到key的缺口。没有新增RES/RTN状态机或人工解除写权限。
- 库存总表仓库筛选原先没有传至API，已修，保持与库位/预占同过滤；没有把在手伪改为合格。
- 库存同来源重放明确提示零增量；NC处置/闭环按钮与原open/disposed/返工复检门一致；库存消费已有放行与订单收货的说明更清楚。

每个分派ID（P0-03/05/06、P1-01/04/05、P2-02~06）及UX的核定、改动/已修/设计边界/待决定与源码位置见 DISPOSITIONS.md。原报告未提交动作只视为未知，本轮用403负向实际证明；不为报告建议无菜单封直链、QC独占库存动作或E02替代项目经理而破坏既有合同。

## 检查及实际读回

原件与完整命令/退出码见 `evidence/CHECKS.json`：三个受影响包typecheck EXIT0；application收货投递/库存两文件50/50；Web菜单/数据接缝/模块装配76/76；受影响application/web/server构建EXIT0；既有真实收货→质检server集成1/1。没有全仓verify/整套业务重跑，也不虚称单次全verify通过。初次typecheck也通过；之后UI逐行输入调整使覆盖作废，最终typecheck-final为稳定源结果。

本轮隔离HTTP原件（均完整响应，令牌仅内存使用不落响应日志）：

- `ENTRY-HTTP-RESULT.json`：prod库存选项/提交403、wh质检判定403、qc库存提交403、wh放行选项200、wh完整PO403、采购仓选项200。
- `LIVE-RESULT.json` + `live-*.http`：全新合成物料/工作令/三类采购申请→同一PO下发→wh收货，自动建standard/nonstandard/equipment三张pending，来源PO#行号一致；最小投影无价格/审批/人员；无申请订单明确unclassified而不猜standard；同本轮来源重放duplicate=true、库存前后完全一致；prod动作投影403、wh完整PO403不变。
- `PROTECTION-RESULT.json`：4个既有库存账户字节值不变，旧种子PO不变，旧A超长恢复键1行不变。新增3个库存账户仅属本轮3个新物料。没有改旧种子/旧流水/旧失败夹具。3张待检未判定，不碰任何旧quality事实。
- 预占核销/释放数量与跨租户/错仓只读断言在本次inventory测试；上一轮设备真实入库/分类发料/撤销原始证据复用，不把新的列表冒充正式RES/RTN业务单据。

## 真实边界与下一动作

质量态库存（HOLD/QUALIFIED/隔离）、PO业务版/应付、返工工艺批准路线、SCN09独立验收/批次，以及MFG01实名角色映射，不在既有模型中；没有加schema、金额阈值、MFG专用授权或新模块。采购库存与pending在旧合同下可并存，本轮证据不宣称“收货不计可用”已实现。多进程同池并发原子封顶仍沿上一轮明确风险保留。

Owner新增能力已由父级接收并留待下一增量合同；本writer没有启动排程/承诺/金额分流/复机会签/报废会签/EC实施。父级PRODUCT-DECISION.md和PARENT-CONTINUITY.json由父独写，不属于本候选产品指纹。

最终运行绑定 UI-RUNTIME-BINDING.json：Web8181、API3101、PG55435，PID 26542；仅重启本轮隔离API，30模块，未碰8080/3000/55432共享栈。相关JS和实际Web产物指纹见evidence/RUNTIME-FILES.json。父级必要IAB读回见UI-READBACK.md；本writer原生子任务不操作Chrome/user接管路径。

当前停止条件：稳定候选及证据已交付；停止产品/运行写入，等待父级本事件接收。新合成单据保留供UI与审查追溯；未清除旧输出/历史数据或备份。
