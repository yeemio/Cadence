# @smes/drawing（图纸专业包）

状态：**M3 已实施**（冻结合同 `architecture/contracts/m3-drafts/03-drawing.md`
v1.0）。图纸=版本化文档：修订链 append-only（发布 v4 不改 v3）、业务对象挂图
纸用 DrawingRef 钉修订号（引用不漂移）、`drawing.publish.v1` 发布命令联动变更
通知（from→to，sinceVersion 游标轮询）、查看留痕 + 两级保密门禁（公开/受限，
R-M3-6 推荐默认——查看必过权限+必留痕两不变量在服务层承载，超等级不可见与
不存在同形 404 不泄漏存在性）。零框架业务类（不 import @nestjs/*）——注册进
组合根与激活开关接线归总控（开关关闭 = 入口/权限码/通知消费全不可见，见
`src/index.ts` 文件头）。

实施版面（M3 第三包，体例对齐 packages/payroll 先例）：

| 文件 | 职责 |
| --- | --- |
| `src/ports.ts` | DrawingRef 钉版引用 / DrawingViewer 查看者 / 变更通知端口（发布联动事实存储面） |
| `src/drawing-config.ts` | 保密等级值集两级公开/受限 + 门禁判定（classificationAllows）/ 权限码 |
| `src/drawing-ids.ts` | 品牌化 DrawingId / DrawingRevisionId / DrawingChangeNoticeId（defineId 增补） |
| `src/drawing-errors.ts` | Input/NotFound/Conflict（含跨包结构同形防线 isDrawingConflict） |
| `src/drawing-events.ts` | DrawingRevisionPublished / DrawingViewed（谁/何时/哪修订/当时等级） |
| `src/drawing-stores.ts` | 存储端口：修订行 / 通知 / 留痕行 / 事件 / 幂等账本 |
| `src/drawing-input.ts` | 命令面解析（drawing.publish.v1；G1 前置校验；图号=数据约定不做模式校验） |
| `src/drawing.service.ts` | 用例编排：发布/查看（门禁+留痕）/修订链/通知/按工作令图纸清单/留痕审计 |
| `src/in-memory-drawing-stores.ts` | 内存先行实现（零 DB boot）；PG 适配在 business-store `./drawing` |

## 组合根装配（已实施，R-M3-3 形态）

REST/HTTP 面**不在本包**（R-M3-3 裁定：专业包零框架耦合，控制器/装配归组合根——
本包保持"不 import @nestjs/*"，与 `pro-pack-tier-edges` 一致）：

- HTTP 模块：`apps/server/src/drawing-http.module.ts`
  （`DrawingHttpModule.register({ stores, workOrderDrawingRefs })`，每路由挂
  `@RequirePermission`；权限码=合同 §5 最小集 `drawing:read / publish /
  audit-read`，`<通用词>:<动作>` 形状）；
- 错误映射：`apps/server/src/drawing-error.filter.ts`（Input→400 /
  NotFound→404 / Conflict→409）；
- 注册挂载：`apps/server/src/app-registry.ts` 的 `MODULE_DEFINITIONS.drawing`
  （stores 缺省内存回落；PG 形态经 business-store `connectDrawingStore` 注入
  `drawingStores`；激活价=MODULES_ENABLED 显式开启）。

## e2e（PG 形态）

`scripts/e2e-maintenance-drawing-pg.mjs`（仓根，与 maintenance 共用）：一次性
docker postgres:16 + 全量 migrate deploy + 服务层 e2e（本包 DrawingService ×
business-store PG 五端口，结构同形注入；覆盖版本链/钉版本/门禁/留痕/游标/
租户收口/PG 重启存活）。前置 `pnpm build`，运行
`node scripts/e2e-maintenance-drawing-pg.mjs`。RLS 三面实证归
`deploy/scripts/rls-proof.mjs`（80 表全量）。


与 workorder 的分工（合同 §1 铁律）：工作令附件挂接事实（WorkOrderAttachment）
归 workorder（"下图统计"88 的数据源）；本包管图纸本体；激活后挂接载荷可升级
为携带 DrawingRef（钉修订号）——属 workorder 版本化 schema 增补，非本包反向
侵入；组合根粘合（附件引用 → drawingsForWorkOrder 升级视图）归总控。

以下预热草案记录保留作设计沿革（ADR-0010 三问表与依赖方向裁定仍然有效；
草案端口形状已按合同 §8 差异表定稿升级——详见上表与合同）。

## 领域概念与 ADR-0010 三问记录

| 概念 | 三问记录（1 单一行业？2 可重述为通用上位+配置？3 已有上位可挂靠？） | 落点 |
| --- | --- | --- |
| 图纸 | 2：重述为**版本化文档**（revision 是通用词；"图号"编码规则是数据约定） | `DrawingRevision` |
| 图纸修订 | 通用 append-only 发布事实；`supersedesVersion` 对齐证据列 supersedes 语义 | `DrawingRevision.supersedesVersion` |
| 挂图纸 | 2：重述为**钉版本的引用**（引用不漂移——业务对象挂 v3 不随 v4 变义） | `DrawingRef` |
| 变更通知 | 通用发布/订阅事实（from → to + 变更说明 + 时间） | `DrawingChangeNotice` + 端口 |
| 文件 | 3：挂靠实施层存储（fileRef = 字符串引用，存储键/URL 由实现解释） | `DrawingRevision.fileRef` |

包身份词 drawing（图纸）留在包级（专业包层），不进 business-core 内核词汇白名单。

## 依赖方向

```
@smes/drawing ──(仅类型)──▶ @smes/business-core（UserId 品牌化身份）
```

零其他依赖：文件存储、消息通道、权限都是实施层/组合根职责（M3 正式实施接线）。
消费方（dispatch/reporting/inspection 等环节模块）持 `DrawingRef` 钉版本引用，
感知新版走变更通知端口——不直接耦合本包之外的任何实现。

## 端口清单

| 类型 | 形状 |
| --- | --- |
| `DrawingRevision` | drawingId + version + fileRef + changeNote + changedBy/changedAt + supersedesVersion? |
| `DrawingRef` | drawingId + version（钉修订号；业务对象侧的最小引用形状） |
| `DrawingChangeNotice` | noticeId + drawingId + fromVersion/toVersion + changeNote + publishedAt |
| `DrawingChangeNoticePort` | `publish(notice)` + `readByDrawing(drawingId, sinceVersion?)` |

## 非目标（本草案）

文件预览/在线看图、CAD 格式解析（禁入风险见 ADR-0007/0009 依赖树教训）、
图纸-工序关联建模（属 baseline 工艺域）、权限、通知推送通道选型、任何运行时逻辑与存储。
