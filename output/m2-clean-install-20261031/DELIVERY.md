# M2 当前候选干净安装与剩余验证差量

日期：2026-10-31（Asia/Shanghai）｜执行及技术接收：`01a190b8-b764-7473-852d-cfe62d232c07`

**技术结论：准确提交的干净安装、单机启动、SaaS 租户路由及旧配件单级审批链的具名隔离验证 ACCEPT。** 本轮没有产品源码改动；安装说明及两项 Owner 决定形成未提交文档差量。M2 整体接受仍由 PM 对产品范围和可交付性的接收约束，不能由本报告推导。

## 准确输入与环境

- 从本地仓库干净 clone 并 detached checkout `346d46882afa908d70731a64c9ff0496950dd068`；产品源码为 `0425ded838a87b8aeab3cfc300097a985bde2bd2`。不包含原工作区未提交文件，clone 的已跟踪文件在验证前后均无差量。
- 单独构建 server、migrate、web 镜像；未复用常驻容器作为安装环境。使用隔离 Compose 项目 `cadence-m2-clean-20261031-2c07` 和新数据卷，所有发布端口均绑定 `127.0.0.1`。
- 安装配置独立保存在该副本的 `deploy/.env`，权限 600；本报告与日志不保存真实生成口令、签名密钥或登录令牌。源码目录与资源定位见 [ENTRY](ENTRY.json)、[配置摘要](compose-inputs.json)。
- 构建 [exit 0](build-result.json)，单机 [启动 exit 0](startup-result.json)，SaaS [启动 exit 0](saas-startup-result.json)。原始日志分别为 `build.log`、`startup.log`、`migrate.log`、`saas-startup.log`。

## 已证结果

| 边界 | 结果 | 原件 |
| --- | --- | --- |
| 空库安装 | 60 项迁移全部完成且逐项 SHA256 对应源码；121 张业务表全部启用 RLS 与 FORCE RLS | [schema-readback](schema-readback.json)、[单机结果](single-result.json) |
| 安装入口 | API/Web 健康、30 模块清单、桌面/登录/移动 HTML 与入口静态资源均成功；直连和代理响应包含四项安全头 | [HTTP 结果](http-results.json)、[单机运行绑定](single-runtime.json) |
| 演示初始化 | 基础种子随安装执行；工厂与制造角色两个显式初始化均成功。admin、六岗、viewer、七个制造职责共 15 账号登录/退出成功；制造职责无管理员权限，七岗看板可读 | [种子结果](seed-results.json)、[单机结果](single-result.json)、`factory-seed.log`、`manufacturing-seed.log` |
| 最小岗位可用性 | 计划岗可读原 seed 工作令且有既有 `parts:approve`；仓管可读最小收货投影和质量库存；viewer 读工作令 403、匿名 401 | `plan-seeded-workorder.json`、`warehouse-receiving-orders.json`、`warehouse-quality.json`、[HTTP 结果](http-results.json) |
| SaaS 差异 | 已知两租户 health 200，未知租户 404，域外/多级域 421；跨租户令牌 401；非默认租户不凭空出现 admin；切换形态后旧工作令及计划岗权限仍可读 | [SaaS 结果](saas-result.json)、[运行绑定](saas-runtime.json) |
| P2-06 补证 | 原 seed 工作令 manager 仍为 `user-factory-plan`；新配件申请待办派给该项目经理，制造 E02 未获旧审批权限时 403 且状态不变，plan01 批准到 approved@3 并完成待办；源工作令未改写 | [P2-06 结果](P2-06-RESULT.json)、`p206-created.json`、`p206-before-approval.json`、`p206-after-denied.json`、`p206-approved.json`、`p206-final.json` |

P2-06 接受限本候选、缺省单级链及上述隔离场景。单级链仍按原合同用 `parts:approve` 权限守门，不是“仅 manager 本人可审批”的新身份保证；多级链与发货未重放。原 2026-10-29 共享复测的 11 PASS / 6 PARTIAL / 1 OUT_OF_SCOPE / 1 UNVERIFIED 保留原时点，本补证不回写原报告。

本轮未做新的可见浏览器走查；HTTP 200/静态资源和账号读回不冒充视觉验收。原共享候选的可见 UI 接收仍按原覆盖复用，产品字节未变。SaaS 验证使用 Host 头，不声称真实 DNS、TLS 或非默认租户开通流程已交付。

## 文档与 Owner 决定

1. 修正 [部署手册](../../deploy/README.md) 中“模板不随 clone 分发”和“仍需未提交源码”的旧说法，统一为当前 30 模块，明确持久化 `.env`、独立项目名和端口；如实标明当前 Compose 未透传的可选登录/口令策略参数。
2. [演示说明](../../docs/user-manual/demo-handover.md) 复用同一配置，以 `--no-deps` 运行显式造厂，并补齐已存在制造角色脚本的使用说明。上述命令已在隔离环境执行成功。
3. Owner 在本聊天明确选择：“维持现状：有效短时签名链接可直接打开”。SP-5/裁-11 依原合同“不加严则销项”，记录于 [决策销账](../../architecture/DECISIONS-QUEUE.md)、[安全合同 SP-5](../../architecture/contracts/m2-security/CONTRACT.md) 和 [客户说明 A1/B9/D](../../docs/user-manual/KNOWN-BEHAVIORS.md)。没有新增登录门，也不关闭 P2-3/O5 身份保密许可配置议题。
4. Owner 随后明确选择：“按现有语言范围收口，第 3 波待客户语言确认后再排”。已在 [ADR-0012](../../architecture/decisions/ADR-0012-多语言i18n架构决定.md) 与决策销账记录，本轮按中文完整＋现有英文骨架接受语言范围；第 3 波方案保留，未启动数据库或页面改造。

部署/演示文档的准确差量及哈希见 [installation-docs.patch](installation-docs.patch)、[CLOSEOUT](CLOSEOUT.json)。其余决策说明文件另在本工作区保留未提交差量。PM 的三个入口由 PM 自行维护，本执行聊天没有编辑。

本次拟提交的准确文件与 SHA256 见 [文档候选清单](DOCUMENT-CANDIDATE.json)。仅选择本轮六份文档差量、接管包和精简脱敏证据；完整构建日志、校验脚本及其失败原件仍留本机，不承诺精简提交包含全部原件。三个 PM 入口、旧 output 脏文件、数据库/配置/镜像恢复源不在本次拟提交范围。

## 失败、恢复与停止边界

- 保留两次校验脚本失败：`smoke.log` 把 `order.id` 误按顶层 `id` 读取；`smoke-continued.log` 误把 UI 路径 `/purchase/receiving` 当 API，当前 API 为 `/purchase/receiving-orders`。均由响应和控制器源码定位，修正校验后从断点继续；未改产品、未重放已完成账号检查。原脚本为 `smoke-v1.py`、`smoke-v2.py`，最终输出 `smoke-final.log`。
- 验证后仅收起本轮 5 个隔离容器和其网络，保留新数据卷、镜像、私有配置和原始证据。常驻 `cadence` 四个容器的 ID、镜像和启动时刻与开始前完全一致，见 [before](shared-before.json)、[after](shared-after.json)、[关闭记录](CLOSEOUT.json)。旧 output、备份、镜像恢复源保持原状。
- 未 commit、push、发布、升级共享环境或部署客户环境；未新增依赖，未迁移或冒用旧 RunKit 账本。本仓没有当前 M2 的有效 RunKit 发包绑定，尚未正式委派子代理。
- 多语言第 3 波已由 Owner 明确延期，不再阻塞本轮语言范围收口。PDF 视觉、历史成本样本及三个历史 404 对象出处仍未补齐，保持原记录；D-18 保留非阻断，原合同外业务不自动进入实施。技术与文档差量已完成，下一动作是取得本次准确文档/精简证据提交权限；此前提交授权只绑定上一轮候选。PM 的产品范围/整体可交付性接受与未来发布、客户部署仍为各自边界。
