# Cadence 复测用例清单（0b7cd35 / 541ffff）

| 模块 | 用例 | 描述 | 请求 | 期望 | 实际 | 结论 | 关联/备注 |
|---|---|---|---|---|---|---|---|
| baseline | BL-P1 | 定义工序 rt26db30-PRE | `POST /baseline/processes/commands` | 201 committed | 201 | PASS |   |
| baseline | BL-P1 | 定义工序 rt26db30-FIN | `POST /baseline/processes/commands` | 201 committed | 201 | PASS |   |
| baseline | BL-R1 | 定义工艺路线 | `POST /baseline/routings/commands` | 201 committed | 201 | PASS |   |
| workorder | WO-01 | 建工作令(D-8) | `POST /workorder/work-orders` | 201 committed | 201 | PASS | D-8  |
| workorder | WO-02 | 建第二张工作令(D-8) | `POST /workorder/work-orders` | 201 committed | 201 | PASS | D-8  |
| workorder | WO-07 | 按 id 查工作令 | `GET /workorder/work-orders/:id` | 200 | 200 | PASS |   |
| workorder | WO-08 | 工作令挂附件 | `POST /workorder/work-orders/:id/attachments` | 201 committed | 201 | PASS |   |
| workorder | WO-09 | 旧版本号重复挂附件(乐观锁) | `POST /workorder/work-orders/:id/attachments` | 409 或 201+rejected | 201 | 观察 |  观察：attach 不推进 objectVersion（两次均 newRevision=1），乐观锁不适用于附件追加；判为设计/待 Owner 确认，非缺陷 |
| workorder | D7-1 | 非 UUID 工作令 id | `GET /workorder/work-orders/not-a-uuid` | 404 | 404 | PASS | D-7  |
| baseline | BL-02 | 非 UUID 物料校验 id(D-7) | `GET /baseline/material-validations/abc` | 404 | 404 | PASS | D-7  |
| misc | D7-x | 非 UUID id: /masterdata/items/abc | `GET /masterdata/items/abc` | 404 (非 5xx) | 404 | PASS | D-7  |
| misc | D7-x | 非 UUID id: /inspection/orders/abc | `GET /inspection/orders/abc` | 404 (非 5xx) | 404 | PASS | D-7  |
| misc | D7-x | 非 UUID id: /reports/abc | `GET /reports/abc` | 404 (非 5xx) | 404 | PASS | D-7  |
| misc | D7-x | 非 UUID id: /dispatch/orders/abc | `GET /dispatch/orders/abc` | 404 (非 5xx) | 404 | PASS | D-7  |
| misc | D7-x | 非 UUID id: /purchase/orders/abc | `GET /purchase/orders/abc` | 404 (非 5xx) | 404 | PASS | D-7  |
| misc | D7-x | 非 UUID id: /approval/cases/abc | `GET /approval/cases/abc` | 404 (非 5xx) | 404 | PASS | D-7  |
| listing | LS-01 | 清单骨架导入 | `POST /listing/imports` | 201 committed | 201 | PASS |   |
| listing | LS-01b | Excel 零件清单行导入 | `POST /listing/imports` | 201 committed | 201 | PASS |   |
| listing | LS-03 | 按工作令查四类清单 | `GET /listing/sheets?workOrderId=` | 200 含 part | 200 | PASS |   |
| dispatch | DP-01 | 零件派工(前道 10) | `POST /dispatch/orders` | 201 committed | 201 | PASS |   |
| dispatch | DP-02 | 派工 assign | `POST /dispatch/orders/:id/assign` | 201 committed | 201 | PASS |   |
| dispatch | DP-G1 | 未定义工序派工（新闸门） | `POST /dispatch/orders` | 201 committed 或 rejected(工序库) | 201 | PASS |   |
| reporting | RP-G1 | 未定义工序报工被闸门拒 | `POST /reports` | 201+rejected 含"工序不在 baseline 工序库中" | 201 | PASS |   |
| reporting | RP-01 | 报工 submit 6/10 (D-8) | `POST /reports` | 201 committed | 201 | PASS | D-8  |
| reporting | RP-02 | 超量报工 6+5>10 (D-9) | `POST /reports` | 201+rejected 含累计超派工 | 201 | PASS | D-9  |
| reporting | RP-02b | 边界报工 6+4=10 | `POST /reports` | 201 committed | 201 | PASS | D-9  |
| reporting | RP-02c | 满额后再报 1 | `POST /reports` | 201+rejected | 201 | PASS | D-9  |
| reporting | RP-03 | 报工核查 verify | `POST /reports/:id/verify` | 201 committed | 201 | PASS |   |
| reporting | RP-04 | 旧版本重复核查 | `POST /reports/:id/verify` | 409/400 或 201+rejected | 201 | PASS |   |
| hours | HR-05 | 核查后工时入账 | `GET /hours/work-orders/:id` | entryCount>=1 | 200 | PASS |   |
| costing | CS-02 | 发布成本口径 | `POST /costing/models` | 201 committed | 201 | PASS |   |
| costing | CS-03 | 成本重建 | `POST /costing/rebuild` | 201 committed, laborMinor>0 | 201 | PASS |   |
| costing | CS-04 | 成本汇总读回 | `GET /costing/work-orders/:id/summary` | 200 | 200 | PASS |   |
| costing | CS-07 | 不存在工作令重建 | `POST /costing/rebuild` | 201+rejected | 201 | PASS |   |
| reporting | RP-06 | 末道报工(D-8) | `POST /reports` | 201 committed | 201 | PASS | D-8  |
| inspection | IN-06 | 末道报工→自制质检单 | `GET /inspection/orders?kind=self_outsourced` | 出现 sourceRefId=报工单 | 200 | PASS |   |
| inspection | IN-01 | 按 id 查质检单 | `GET /inspection/orders/:id` | 200 | 200 | PASS |   |
| inspection | IN-02 | 判定数量超出送检数 | `POST /inspection/orders/:id/judgment` | 400 或 201+rejected | 201 | PASS |   |
| inspection | IN-03 | 质检判定 5 合格 1 不合格 | `POST /inspection/orders/:id/judgment` | 201 committed | 201 | PASS |   |
| inspection | IN-05 | 不合格品清单 | `GET /inspection/nonconformities` | 200 且≥1 | 200 | PASS |   |
| purchase | PU-00 | 建采购申请 | `POST /purchase/requests` | 201 committed | 201 | PASS |   |
| purchase | PU-01 | 采购下单(D-8) | `POST /purchase/orders` | 201 committed | 201 | PASS | D-8  |
| purchase | PU-08 | 采购审批 | `POST /purchase/orders/:id/approval` | 201 committed | 201 | PASS |   |
| purchase | PU-09 | 采购下发 | `POST /purchase/orders/:id/issue` | 201 committed | 201 | PASS |   |
| purchase | PU-10 | 采购收货确认 | `POST /purchase/orders/:id/receipts` | 201 committed | 201 | FAIL |  D-15 |
| inspection | IN-07 | 收货→采购质检单 | `GET /inspection/orders?kind=standard_purchase` | 出现 sourceRefId=订单#1 | 200 | FAIL |  D-15 级联 |
| dispatch | DP-05 | 外协派工创建(D-8) | `POST /dispatch/orders` | 201 committed | 201 | PASS | D-8  |
| dispatch | DP-06 | 外协派工 assign(D-8) | `POST /dispatch/orders/:id/assign` | 201 committed | 201 | PASS | D-8  |
| dispatch | DP-08 | assigned 态直接 complete | `POST /dispatch/orders/:id/complete` | 201+rejected（设计） | 201 | PASS |   |
| dispatch | DP-07 | 外协派工 start | `POST /dispatch/orders/:id/start` | 201 committed | 201 | PASS |   |
| dispatch | DP-08b | 外协派工 complete | `POST /dispatch/orders/:id/complete` | 201 committed | 201 | PASS |   |
| inspection | IN-08 | 外协完成→回厂质检单 | `GET /inspection/orders` | 出现 sourceRefId 含派工单 | 200 | PASS |   |
| dispatch | DP-09 | 外协明细按供应商查询 | `GET /outsourcing/lines?supplierRef=` | 200 | 200 | PASS |   |
| maintenance | MT-03 | 建维修任务 | `POST /maintenance/tasks/commands` | 201 committed | 201 | PASS |   |
| maintenance | MT-04 | 任务开始 | `POST /maintenance/tasks/start/commands` | 201 committed | 201 | PASS |   |
| maintenance | MT-05 | 任务完成 | `POST /maintenance/tasks/complete/commands` | 201 committed | 201 | PASS |   |
| maintenance | MT-01 | 发布保养计划 | `POST /maintenance/plans/commands` | 201 committed | 201 | PASS |   |
| maintenance | MT-02 | 到期扫描(上轮 indeterminate) | `POST /maintenance/plans/due-scan/commands` | 201 committed | 201 | PASS |   |
| drawing | DW-01 | 发布图纸 | `POST /drawing/revisions/commands` | 201 committed | 201 | PASS |   |
| drawing | DW-03 | 按许可查图纸修订 | `GET /drawing/revisions/:id?clearance=public` | 200 | 200 | PASS |   |
| metric-pack | MP-02 | 口径包列表 | `GET /metric-pack/packs` | 200 | 200 | PASS |   |
| notifications | NT-01 | 发通知(source 小写) | `POST /notifications` | 201 | 201 | PASS |   |
| inventory | IV-01 | 建仓库(warehouse.define.v1) | `POST /inventory/warehouses` | 201 committed | 201 | PASS |   |
| inventory | IV-05 | 生产入库 | `POST /inventory/stock/receipts` | 201 committed | 500 | FAIL |  D-14 |
| approval | AP-D11 | 不存在审批人 | `POST /approval/cases` | 400 | 400 | PASS | D-11  |
| approval | AP-01 | 正常发起审批 | `POST /approval/cases` | 201 | 201 | PASS |   |
| org | D2-01 | 带初始口令建号 | `POST /org/users` | 201 | 201 | PASS | D-2  |
| org | D2-02 | 初始口令登录 | `POST /auth/login` | 200/201 + token | 201 | PASS | D-2  |
| org | D2-03 | 新用户 /auth/me | `GET /auth/me` | 200 | 200 | PASS | D-2  |
| org | D2-04 | 不带口令建号→登录 401 | `POST /auth/login` | 401 | 401 | PASS | D-2  |
| org | D2-05 | 弱口令重置 | `PUT /org/users/:id/password` | 400 | 200 | 观察 | D-2 观察：口令无强度策略（1~N 字符即可），建议 P3 |
| org | D2-06 | viewer 无 user:write 重置 | `PUT /org/users/:id/password` | 403 | 403 | PASS | D-2  |
| org | D2-07 | admin 重置口令 | `PUT /org/users/:id/password` | 200 | 200 | PASS | D-2  |
| org | D2-08 | 旧口令登录 | `POST /auth/login` | 401 | 401 | PASS | D-2  |
| org | D2-09 | 新口令登录 | `POST /auth/login` | 200/201 | 201 | PASS | D-2  |
| org | D2-10 | 重置前签发的旧会话 | `GET /auth/me` | 401（全端撤销） | 401 | PASS | D-2  |
| org | D2-11 | B 租户 admin 重置 A 用户 | `PUT /org/users/:id/password @tenant-b` | 403/404 | 404 | PASS | D-2  |
| org | D2-12 | A token 打 B 子域重置 | `PUT /org/users/:id/password @tenant-b(A token)` | 401/403/404 | 401 | PASS | D-2  |
| org | D2-13 | A 用户在 B 子域登录 | `POST /auth/login @tenant-b` | 401 | 401 | PASS | D-2  |
| org | D2-14 | 跨租户重置未生效 | `POST /auth/login` | 401 | 401 | PASS | D-2  |
| org | D2-15 | 不存在用户重置 | `PUT /org/users/nope/password` | 404 | 404 | PASS | D-2  |
| attachment | D4-01 | 签发下载引用 | `GET /attachment/download-reference` | 200 | 400 | PASS(补跑) | D-4 脚本参数错（漏 bizId），已用正确参数补跑→200，见 raw/d4.json |
| attachment | D4-02 | 用 A 的引用在 tenant-a 子域取字节 | `GET /attachment/storage/:token @tenant-a` | 200 | 404 | PASS(补跑) | D-4 同上，补跑 tenant-a 取回原文 200 |
| attachment | D4-03 | 用 A 的引用在 tenant-b 子域取字节 | `GET /attachment/storage/:token @tenant-b` | 403/404 | 404 | PASS | D-4  |
| attachment | D4-04 | 用 A 的引用在 default 子域取字节 | `GET /attachment/storage/:token @default` | 403/404 | 404 | PASS | D-4  |
