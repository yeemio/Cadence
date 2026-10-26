# 图文档管理模块 · 分阶段实施合同（P0 校准在途 / P1 集成深化 / P2 受控增强）

v1.0（2026-10-27 晨产出，**规划档**：P0 为在途线校准即冻结论域，P1/P2 为建议稿——派发前须过 §Owner 裁定项）｜编写者：code-writer-pro GLM-5.3｜依据：[RESEARCH.md](RESEARCH.md) 四面调研（源文档 73 份全量 grep / 我方实态 / 行业惯例 / 差距矩阵）+ PRD 13 册 D-WO-05（RREQ-WO-038）+ m3-drafts/03-drawing.md v1.0 冻结合同｜体例沿 fix-wave-6（Goal/写入面/不做/验收四件套）

## 0. 纪律

同 fix-wave-6 §0（code-writer-pro 实施+code-reviewer 验收、局部验证绿即停、不 commit/push、429 退避、并发 writer ≤3）＋本模块特有两条：

1. **两不变量是红线**（m3-03 §2）：查看必过保密门禁、查看必留痕（fileRef 唯一取得路径=viewRevision）——任何阶段任何工作包不得新增 fileRef 外泄路径、不得绕过 view 端点呈现内容。
2. **消费模块零 import 铁律**（m3-03 §4 差异表 #3）：workorder/dispatch/reporting/inspection 持钉版引用=结构同形字段；存在性校验与通知投递归组合根。P1 接线工作包只在组合根/apps 层动。

---

## P0 · 呈现面收口（= 在途线校准，唯一在途 Goal）

**Goal**：D-WO-05（RREQ-WO-038）按已冻结定义收口——图纸域桌面呈现面经测试钉形+验收 ACCEPT，零后端改动、零范围扩张。

**Done-when**：
1. 在途 writer 四文件（DrawingLibraryPage / DrawingAuditPage / WorkOrderDrawingsCard / drawingApi）+ menu/assembly/WorkOrdersPage 注册完成 `drawing-pages.test.ts` 落盘（页面头注已预告，尚未存在）——钉形至少覆盖：查看动作必经 view 端点（无旁路断言）、mutation 呈现不留幻影留痕、clearance 镜像值集防漂移（drawingApi 头注自述的取舍钉进测试）、三态清单呈现、同形 404 如实呈现；
2. code-reviewer 对照 RREQ-WO-038 验收口径四问（页面动作全经既有端点无旁路 / 查看必经 view / 六面覆盖 / 无越权呈现）出 ACCEPT；
3. writer 自登记"不做"三项（全库索引端点 / 上传通道 / 租户许可配置面）随回传登记进 PRD 13 册增补（见附录 A-3）。

**写入面**：apps/web/src/pages/drawing/**、apps/web/tests/**（menu.test.ts 已含）、零 apps/server / packages 改动。

**不做（登记）**：移动查看页（沿 m3-drafts README"移动查看=同 API，呈现归 M5"裁定→O4）；全库索引列表端点（→O3）；上传通道（→P2 评估）；水印/签名 URL（→P2）。

**验收分级**：Guarded（呈现面+保密语义域）——code-reviewer 必派。

---

## P1 · 集成深化（建议稿：逐项独立可派发，O1~O4 裁定后排期）

### P1-1 变更通知→挂接方待办接线（无裁争议，可首派）

- **缺口**：合同 §4"core 待办（通知→挂接方待办）"未接线——DrawingRevisionPublished 全 server 零消费（RESEARCH §2.6 实证）。
- **范围**：组合根消费 DrawingRevisionPublished → 对"挂有该 drawingId 钉版附件的工作令"项目经理产待办（沿 workbench source=workorder 先例：workorder 流转待办/齐套催办同形态）；复用 #23 装配的 refs 反查（或组合根扫描 workorder 附件域）；关闭/升级处理后销账语义沿 13 册 RREQ-WO-009 先例。
- **写入面**：apps/server/src/cross-module-wiring.ts（+注册/测试）；禁改 packages/drawing（通知事实已产）。
- **验收**：发布 vN+1 → 挂接方待办可见可销账；未挂接图纸不产待办；双租户隔离。

### P1-2 工艺路线互链（O1 裁定后）

- **候选形态**（三选一，Owner 裁定）：A. baseline Routing 增补可选 DrawingRef 字段（12 册 schema 增补，m3-03 §1 预留的升级路径）；B. 组合根校验器：Routing.drawingNo ↔ drawing.drawingId 同图号存在性对账（零 schema 改动，读面校验+告警）；C. 维持独立（登记不做）。
- **约束**：不改内核概念（两侧状态机/修订链纪律不动）；A 形态走 baseline 版本化 schema 增补先例（v1.1+，非反向侵入）。

### P1-3 #88 口径 v2 修订维度（O2 裁定后）

- **范围**：metric-pack 88 口径装载图纸包激活态时升 v2（口径版本化先例：machining-calib-pack.ts v1 注释已预留"未激活=附件计数口径"）；呈现面 report-center 20 册 RREQ-RP-011 已声明演进语义。
- **约束**：只动 metric-pack+装配；v1 口径不动（未激活租户零感知）。

### P1-4 图号索引查询最小端点（O3 裁定后）

- **范围（最小形态建议）**：drawing 域增只读索引查询（如 GET /drawing/index?…：drawingId 前缀/保密等级过滤+分页，clearance 过滤同链查询纪律）——解在途 writer 登记的"图纸库页无全库列表"缺口；完整图号主数据域（名称/类别/图幅/设计人，对齐源系统"零件图号主数据"）**另立裁定**（涉 11 册边界）。
- **约束**：索引面同形 404/许可过滤纪律不变；元数据口径不含 fileRef。

### P1-5 移动查看页（O4 裁定后；缺省=M5/21 册统一做）

- **范围**：m/drawing 查看页（drawingId 检索→链→查看留痕路径），消费既有 API 零后端改动；沿 m 页先例（pageAccess.tsx 框架）。

---

## P2 · 受控增强（对账驱动，不预设排期）

| 工作包 | 范围 | 依赖/锚点 |
|---|---|---|
| P2-1 查看内容短时签名引用 | fileRef 的查看回执组合 INT-005 HMAC 短时只读引用（已实现的 ObjectStoragePort+开门面），页面"打开内容"走短时引用而非裸 fileRef 呈现 | INT-004/005 已实现可复用；真 SDK 预签名=INT-007 部署期；13 册 §7 已归 22 册 |
| P2-2 水印/下载控制 | 查看呈现水印（查看者+时刻）与下载控制策略=实施层边缘能力（组合根/网关层），合同只锁两不变量不锁实现 | O5 裁定；租户制度对账后（R-M3-6 同批） |
| P2-3 租户保密许可配置面 | clearance 从显式请求参数→租户配置（drawing-http.module.ts 头注预留的替换位）；值集扩级（多级） | R-M3-6；13 册 §8-4 |
| P2-4 上传通道评估 | 发布表单接 INT 附件上传（ObjectStoragePort put）→回填 fileRef；评估后可降级"不做" | INT-004；客户实测反馈驱动 |

**P2 纪律**：全部实施层/边缘能力，drawing 包内核（修订链/钉版/留痕/门禁）零改动；逐项先问"失败会改变哪个 go/no-go"（无客户对账证据不启动）。

---

## 不做清单（防过度工程，详单=RESEARCH §4.3）

在线 CAD 解析/预览渲染（合同禁入，ADR-0007）｜图纸借阅/受控章/纸质发放（无需求）｜PDM/PLM 集成（无客户需求）｜上传通道进 drawing 包（字节归 INT 域）｜附件域反向侵入（挂接事实归 workorder）｜下图统计口径迁移（归 metric-pack 20 册）｜图号编码规则进类型（=数据约定，组成类型语义已在 14 册 listing 落位）｜钉版引用自动升级（升级是显式动作）。

## Owner 裁定项（P1/P2 派发前置；P0 不阻塞）

O1 工艺路线互链形态（A 挂 DrawingRef / B 组合根校验 / C 不做）｜O2 #88 v2 是否随图纸包捆绑（20 册已标 Owner 定）｜O3 图号面深度（最小索引端点 vs 完整主数据域）｜O4 移动查看页落点（M5 统一 vs P1 提前）｜O5 保密值集扩级+许可配置面+水印同批节奏（R-M3-6，对账驱动）。

---

## 附录 A · PRD 13 册增补登记建议（只列不改，交总控落册）

现 13 册 v1.0 冻结正文不动，以下建议走 §增补登记（append-only）：

1. **A-1（P0 完成后）**：RREQ-WO-038 状态"已定义待实现"→"已实现"，锚点补 apps/web/src/pages/drawing/ 四文件+menu.ts 图纸文档组+WorkOrdersPage 入口卡片+drawing-pages.test.ts；D-WO-05 关闭（桌面面），移动查看面拆出为独立登记（沿"呈现归 M5"裁定，建议新差异码 D-WO-06 或归 21 册 MB 域登记——总控定归属）。
2. **A-2（P1 派发时逐项）**：P1-1 通知→待办接线=13 册 §6 跨域关系"core 待办消费变更通知"行的状态注记（合同 §4 承诺方向的落地证据）；P1-2 互链若裁定 A 形态=12 册 baseline schema 增补+13 册 §6 图纸域侧注记；P1-3 若裁定升 v2=20 册 RREQ-RP-011 状态翻牌；P1-4 若裁定最小端点=13 册 drawing 节新增 RREQ 条目（索引查询）。
3. **A-3（随 P0 回传即登记）**：三项"登记不做"显式化——全库索引端点（转 O3 裁定项）、文件上传通道（转 P2-4 评估）、clearance 自声明（转 P2-3/O5）——防后续轮次被当"漏做"反复翻起。
4. **A-4（建议性，总控裁量）**：13 册 §8 开放问题 4（保密等级扩展）补链本合同 O5 与 RESEARCH G7/G8，形成"开放问题→裁定项→工作包"可追溯链。

## 附录 B · 图文档管理完整定义 vs 现有 drawing 节的扩展面（供 PRD 增补参考）

若 Owner 认可本报告的行业对照（RESEARCH §3），图文档管理在本产品的完整定义=**三层**：
- **核心层（已实现，13 册 §4.7 即现有 drawing 节）**：版本化修订链+钉版引用+保密门禁+查看留痕+变更通知+审计；
- **呈现层（P0+P1-5）**：桌面六面+工作令入口+移动查看；
- **受控层（P2，租户制度对账后按需）**：短时签名引用/水印/下载控制/租户许可配置面/值集扩级。
三层分界即售卖/实施话术边界（激活价=核心层+呈现层；受控层=增值项）——是否入 PRD 13 册 §1 域定位一句话，交总控裁定。
