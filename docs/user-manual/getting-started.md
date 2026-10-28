# 快速上手：登录与界面

事实快照日 2026-10-27；以系统实态为准。

## 1. 前置条件

- 系统已部署并可访问（单机形态缺省地址：桌面 `http://localhost:8080`、移动 `http://localhost:8080/m`、API `http://localhost:3000`）。部署步骤见 [../../deploy/README.md](../../deploy/README.md)。
- 你有一个已开通的账号与口令。种子环境的账号清单见下节；正式环境由管理员在「用户与角色」页开通（见 [roles/admin.md](roles/admin.md)）。

## 2. 登录

1. 浏览器打开桌面入口 `http://localhost:8080`，未登录会落到登录页。
2. 输入用户名与口令，点登录。种子演示环境口令统一为 `demo-password`（来源：`noodle-test-output/ui-round2-20261027/BRIEF.md`、`deploy` 种子脚本 `packages/business-store/prisma/seed.mjs` / `seed-factory.mjs`）。
3. 登录成功进入工作台（桌面）或移动工作台（`/m`）。

**登录被拒绝的常见情形**（恢复办法）：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 提示口令或用户名错误 | 凭据不对（错误提示对「用户不存在」与「口令错」同一文案，不区分，防探测） | 找管理员核对账号；忘记口令由管理员重置（管理员建号/重置走口令策略校验，见 [roles/admin.md](roles/admin.md)） |
| 提示「登录尝试过于频繁，请稍后再试」并返回 429 | 连续失败触发了登录限流：同一账号 15 分钟窗口内失败 5 次即锁定 15 分钟；**锁定期内口令正确也拒**（防绕锁探测） | 等锁定期（缺省 15 分钟）过后再试，或由部署方调小窗口做演示（env：`SMES_LOGIN_MAX_FAILURES` / `SMES_LOGIN_WINDOW_SECONDS` / `SMES_LOGIN_LOCK_SECONDS`，来源：`packages/application/src/auth/login-attempt-stores.ts` L49-51、`apps/server/src/main.ts` L117-119） |
| SaaS 形态下某租户登录 401 | 该租户是静态清单里的新租户，尚未开通任何用户 | 属已知限制（租户开通流程未实现），见 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md) |

登录会话：访问令牌有效期 8 小时，续期窗口上限 7 天（来源：`packages/application/src/auth/auth.service.ts` L10-11 头注）。

## 3. 种子/演示环境账号清单

（来源：`packages/business-store/prisma/seed-factory.mjs` 头注、`TESTING-GUIDE.md` §3、`noodle-test-output/ui-round2-20261027/BRIEF.md`；口令统一 `demo-password`）

| 账号 | 角色 | 说明 |
| --- | --- | --- |
| `admin` | 种子管理员 | 管理员，权限全量放行 |
| `demo-admin` | 演示管理员 | 同管理员路径 |
| `plan01` | 计划岗 | 工厂种子六岗之一（角色 `plan-role`） |
| `purch01` | 采购岗 | 角色 `purch-role` |
| `prod01` | 生产岗 | 角色 `prod-role` |
| `qc01` | 质检岗 | 角色 `qc-role` |
| `wh01` | 仓管岗 | 角色 `wh-role` |
| `appr01` | 审批岗 | 角色 `appr-role` |
| `approver` | 精确授权演示账号 | 审批/工作台权限，走非 bypass 路径 |
| `viewer` | 只读观察（零策略形态） | 登录可、业务面全拒（403），用于权限拒绝验证 |

注意两点：

- 六岗账号由**工厂种子**（seed-factory）创建，只跑基础种子（compose 迁移服务缺省只跑 `db:seed`）时没有这六个账号。造厂步骤见 [demo-handover.md](demo-handover.md)。
- 多级审批演练用的 `level2-user` / `level3-user` 是测试夹具账号：能登录，但**不在登录页账号清单里**（已知注记，来源：`noodle-test-output/test-handoff-round2-20261027.md` 第六节）。

## 4. 界面总览

### 桌面端

登录后左侧为菜单树，顶栏有语言切换器与通知中心铃铛。菜单分组以系统实态为准，当前为：工作台（`/`）、运营总览、基础数据、制造运营（工作令/配件申请/清单/缺口核查/派工/外协明细/扫码）、报工管理（报工单/报工核查/移动报工）、采购管理（申请/订单/收货/退货/明细）、质量管理（质检队列/不合格处置）、仓储管理（仓库与库位/实时库存/收发存操作/库存盘点/发货任务）、成本与工时、标准报表、图纸文档、工艺与设备、系统管理；另有会话审计与通知中心两个入口不进侧栏（会话审计走系统管理组隐藏项、通知中心走顶栏铃铛）（来源：`apps/web/src/menu.ts` 菜单树实态，48 路由条目）。每个菜单项是否可见由角色权限决定（菜单可见 = 接口可达）。

### 移动端（PWA）

入口 `http://localhost:8080/m`。四个底部标签：工作台、报工、工时、库存，另有工作台快捷入口下的 11 个子页（报故障、入库、移库、盘点、查料、配件审批等）（来源：`apps/web/src/mobile.ts`，15 页注册；`TESTING-GUIDE.md` §4）。

### 桌面「移动报工」是引导页

桌面菜单里的「移动报工」打开的是引导页（`/reports/mobile`），不会直接跳到移动报工页 `/m/report`——这是设计如此（桌面与移动是两个入口），不是缺陷（来源：`noodle-test-output/test-handoff-round2-20261027.md` §三.6、ui-round2 报告 §4 表第 6 行）。

## 5. 语言切换（zh-CN / en-US）

- 登录页右上与主壳顶栏各有一个语言切换器；切换后整页生效，**刷新后保持**（存于浏览器 localStorage 键 `smes.locale`；来源：`architecture/decisions/ADR-0012-多语言i18n架构决定.md`）。
- 缺省中文（zh-CN）。**英文（en-US）当前是骨架**：登录页、主壳菜单与高频通用文案有英文，业务模块页面缺失的文案会**回落显示中文**——这是设计内形态，不是故障（来源：ADR-0012 决定 5；`noodle-test-output/test-handoff-round2-20261027.md` §五.3）。
- 管理员在菜单配置里自定义的菜单名、用户录入的各类名称属于业务数据，任何语言下按原文显示、不翻译（来源：交接文件 §五.5、ADR-0012 决定 4）。

## 6. 通用界面约定（先读，避免误报问题）

（来源：`noodle-test-output/test-handoff-round2-20261027.md` §四「语义变化注意」；ui-round2 报告 §5 抽查表）

| 约定 | 说明 |
| --- | --- |
| 成功提示 | 命令类操作成功统一提示「操作已生效。」 |
| 采购单价按**元**填写 | 输入 `128.50` 即 128 元 5 角（系统内部按分存储为 12850）。不要按「分」填，也不要输入带「元」字的文本 |
| 时间显示 | 列表/多数详情按浏览器本地时区显示；悬停可看完整原始时间。少数页面（如派工详情、质检不合格列表）仍显示原始 UTC 格式——已登记的差异，见 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md) |
| 超长编号显示 | 超过 20 字符的单号/ID 显示为「头 8 …尾 4」短码；复制选中的文字得到的也是短码而非全号（已登记的使用注意，见 KNOWN-BEHAVIORS） |
| 状态文案 | 采购五态、派工、质检、报工过滤等状态已中文化；个别角落仍有英文枚举或英文键（如工作台来源列 `workorder`）——已知残留，见 KNOWN-BEHAVIORS |
| 错误提示 | 操作被拒绝时显示原因。部分拒绝场景的原因仍是服务端原文（可能含命令名/英文枚举）——人话化改造未完成，属已知限制，见 KNOWN-BEHAVIORS |
| 表单候选列表 | 部分表单的候选下拉（如派工建单选工作令/人员）在你无对应查询权限时会静默降级为手工输入框——设计内降级，不是故障 |

## 7. 遇到问题的排查顺序

1. 先查 [KNOWN-BEHAVIORS.md](KNOWN-BEHAVIORS.md)——是否为已登记的设计内行为/已知限制/已登记缺陷。
2. 换一个有权限的账号（如 admin）重试同一操作，判断是否权限问题。
3. 仍无法解决：按 [../../deploy/README.md](../../deploy/README.md)「日志定位」收集信息，向实施方报告（附页面、账号、操作步骤、完整报错文案、时间）。
