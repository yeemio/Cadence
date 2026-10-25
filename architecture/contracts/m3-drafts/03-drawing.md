# 03 · drawing —— 图纸专业包

v1.0（2026-10-26 冻结，审读 ACCEPT agent_4f276c04；Owner 保留推翻权）｜依据：功能项 37 工艺图纸管理（Web·工艺管理：图号与图纸/工艺附件绑定，web/移动查看）｜决策簿：图纸电子化与保密制度门槛高 → 激活价（落地难度"高"的依据即本包 §1 保密门槛与 §2 版本化纪律）

## 1. 包身份与边界（与 workorder/baseline 的分工）

**身份**：图纸域——图纸是**版本化文档**：一次修订=一条 DrawingRevision（append-only 链）；业务对象挂图纸用 DrawingRef **钉住修订号**（引用不漂移）；新修订发布发变更通知。核心价值=版本不乱（洞察 4"图纸就是BOM：图纸版本乱→附件同源挂接"）。
**In**：图纸修订发布与修订链管理、图号↔图纸绑定（drawingId 即图号，编码规则=数据约定）、变更通知、web/移动查看（含查看权限与保密管控）。
**Out（分工铁律）**：
- **工作令附件挂接与计数**（WorkOrderAttachment，`workorder.attach`）在 workorder——附件只透传挂接**事实**（挂在哪个工作令、多少个），是"下图统计"（88）的数据源；本包激活后挂接可**升级**为携带 DrawingRef（钉修订号），未激活时附件为普通文件引用——升级属 workorder 版本化 schema 增补（其 v1.1+），非本包反向侵入；
- **图纸-工序/工艺路线关联**在 baseline 工艺域（Routing 图号维度），本包不管工艺语义；
- 在线 CAD 解析/预览渲染**禁入**（草案非目标+ADR-0007 依赖树教训），预览=PDF/图片由实施层 fileRef 解释；
- 下图统计口径（88）归 metric-pack，本包只出修订事实（激活后可作口径升级数据源）。

激活语义：开关关闭时图纸域入口/权限码/通知消费不可见；工作令附件功能（标准版）照常。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| DrawingId | 图纸标识 | opaque 锚（"图号"编码规则=数据约定，不进类型）；Brand<string,'DrawingId'> |
| DrawingRevisionId | 图纸修订（DrawingRevision） | drawingId+version 唯一定位；fileRef（存储键/URL 由实施层解释）+changeNote+supersedesVersion（对齐证据列 supersedes；v1 缺省）；append-only 不改原修订 |
| DrawingChangeNoticeId | 变更通知 | from→to+changeNote+publishedAt；新修订发布时的事实 |

业务对象侧引用形状 `DrawingRef = { drawingId, version }`（钉修订号——挂在 v3 的派工/报工/检验不因 v4 发布而变义）。

**状态机**：无业务流转（版本化文档域）；修订链=append-only 发布事实（非状态机，证据列承载）。

**分层标注（ADR-0010 三层）**：内核概念=修订链 append-only 纪律与钉版引用语义（supersedes 对齐证据列）；模块 schema=上表实体/命令/事件（本包版本化）；默认配置=保密等级值集与查看留痕策略（租户配置，见下）。

**查看权限与保密门槛（落地难度"高"的依据，功能项 37"在 web 端移动端查看"）**：
- `drawing:read` 权限 + 保密等级（等级值集=租户配置数据，不进类型）按等级控制可见面；
- **查看留痕**：每次查看发 `DrawingViewed` 事件（谁、何时、哪修订）——保密审计的最低门槛；
- 水印（查看者名+时间）、下载控制、短时效签名 URL=fileRef 实施层解释（组合根/边缘），合同只锁"查看必须留痕+必须过权限"两不变量。

## 3. 命令与查询

命令（CommandEnvelope，`drawing.*.v1`，G1 沿用；G2 不适用——无状态机首迁移）：
- `drawing.publish.v1`——发布新修订（drawingId+fileRef+changeNote；version 由链尾+1，幂等；发布即发 `DrawingChangeNotice`）

查询：修订链（按 drawingId，含 changeNote）、变更通知读取（sinceVersion 游标——消费方轮询/对账："我引用的 v3 是否已有更新"）、按工作令图纸清单（消费 workorder 附件事实+修订升级视图）、查看留痕审计（保密管理员）。

## 4. 端口

- **依赖（合法面）**：仅 business-core（UserId）；存储与 DrawingChangeNoticePort（publish/readByDrawing）由实施层实现、组合根接线。v1 无 engine 依赖。
- **被消费（关键方向裁定）**：workorder/dispatch/reporting/inspection 等环节模块持 DrawingRef 时**不 import 本包**（`application-only-core` 禁止 application→专业包）——各模块以**结构同形字段** `{ drawingId: string; version: number }` 进自己版本化 schema（激活前载荷=普通图号字符串，激活后可升级钉版引用）；引用存在性校验与通知投递归组合根。
- **被依赖**：metric-pack（图纸修订事实可作 88 下图统计的口径升级数据源）；core 待办（通知→挂接方待办）。

## 5. 权限码（最小集）

`drawing:read`（+保密等级过滤）、`drawing:publish`（发布修订，工艺/技术角色）、`drawing:audit-read`（查看留痕审计）。

## 6. 事件（append-only + Outbox）

`DrawingRevisionPublished`（→变更通知+挂接方待办）、`DrawingViewed`（查看留痕，保密审计）。

## 7. Done-when 与对账要点

- **Done-when**：发布新修订=append-only 链+自动变更通知；已挂接对象不漂移（钉修订号行为可证：v4 发布后 v3 引用读回仍 v3）；有权限者 web/移动可查看且每次查看留痕；无权限/超保密等级/未激活均不可见；修订链全程可追溯（谁、何时、改了什么）。
- **对账**：同一发布序列的修订链与通知 from→to 集合和活系统行为等价；钉版引用的读回行为等价；查看留痕完整性（无漏记）——保密门槛的对账锚点。

## 8. 与预热端口草案的差异表（草案 → 合同定稿）

| # | 草案（packages/drawing/src/ports.ts） | 合同定稿 | 依据 |
|---|---|---|---|
| 1 | 只有 NoticePort.publish（通知发布），**修订发布本身无命令面** | 补 `drawing.publish.v1`（发布修订=通知的上游动作；通知为发布联动，不是独立入口） | 命令层纪律（一切写操作走 CommandEnvelope）；草案 publish 是实施层端口方法，合同把领域命令补齐 |
| 2 | DrawingId=普通 string | 品牌化 `DrawingId / DrawingRevisionId / DrawingChangeNoticeId` | m2 通用纪律 5 |
| 3 | "消费方（dispatch/reporting 等）持 DrawingRef"未定 import 方向 | **裁定：消费模块结构同形字段，不 import 本包**；存在性校验/通知投递归组合根 | `application-only-core` 禁 application→专业包；激活前后的载荷升级路径写进 §1 |
| 4 | 无查看权限与保密概念 | **新增 `drawing:read`+保密等级+`DrawingViewed` 查看留痕**（两不变量：查看必过权限、必留痕） | 功能项 37"web 端移动端查看"+拆解判定"保密制度门槛高"——激活价的价值主张必须有合同载体 |
| 5 | 与 workorder 附件关系未写 | §1 分工铁律：附件事实归 workorder（88 数据源），本包管图纸本体；激活=挂接载荷可升级 DrawingRef（workorder schema 增补） | 01-baseline §8"本模块只出事实，口径归 engine-reporting"+02-workorder 附件对象；任务边界要求"baseline 只透传事实，包做图纸域" |
| 6 | fileRef 无保密语义 | 水印/下载控制/签名 URL=实施层解释（合同锁不变量不锁实现） | 防过早绑定存储选型；R-M3-6 |

ADR-0011 合规结论：草案 import 面仅 business-core，**字面零违规**；#3 为消费方向裁定收口（草案 README"消费方持 DrawingRef"若读作 import 类型即违规，合同钉死为结构同形）。

## 9. 人日估算对照决策簿

建议 7 人日（M3 总盘 30 内，见 README 人日表）。范围=修订链/通知/查看留痕全套命令查询、权限与保密等级配置面、组合根接线、对账测试；在线预览与水印实现属实施层评估，超支挂对账阶段。

## 10. 开放问题

- 保密等级值集与管控强度分级（R-M3-6）——初版两级（普通/保密）+查看留痕，客户制度对账后扩。
- 大文件存储选型（对象存储 vs 本地卷）与 fileRef 语义——实施层 M3 首波 spike。
- 图纸与工艺路线（baseline Routing 图号维度）是否互链（Routing 挂 DrawingRef）——baseline schema 增补候选，出现需求再定。
- 变更通知的推送通道（站内待办已有；IM 推送是否必达）——对账阶段按客户习惯配置。
