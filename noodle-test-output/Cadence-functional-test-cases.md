# Cadence SaaS 功能性测试用例全集

被测提交 `c80319f`；租户 tenant-a（Host 子域解析）；执行时间 2026-10-26（Asia/Shanghai）。

状态：PASS / FAIL(缺陷号) / BLOCKED（被前置缺陷阻断）/ N/A（用例参数与契约不符或属设计行为，不计缺陷）。

## 1. 业务链用例（API，115 条）

| 模块 | 编号 | 用例 | 身份 | 请求 | 期望 | 实际 | 状态 |
|---|---|---|---|---|---|---|---|
| masterdata | MD-01 | 创建物品 | admin | `POST /masterdata/items` | 201 | 201 | PASS |
| masterdata | MD-02 | 物品 code 重复 | admin | `POST /masterdata/items` | 409 | 409 | PASS |
| masterdata | MD-03 | 物品 code 非法字符(中文) | admin | `POST /masterdata/items` | 400 | 400 | PASS |
| masterdata | MD-04 | 编辑物品名称 | admin | `PUT /masterdata/items/01a17653-cde1-7185-85d3-5bcb23f3a287` | 200 | 200 | PASS |
| masterdata | MD-05 | 停用物品 | admin | `PUT /masterdata/items/01a17653-cde1-7185-85d3-5bcb23f3a287` | 200 | 200 | PASS |
| masterdata | MD-06 | 编辑不存在物品 | admin | `PUT /masterdata/items/01a10000-0000-7000-8000-000000000000` | 404 | 404 | PASS |
| masterdata | MD-07 | 创建资源 | admin | `POST /masterdata/resources` | 201/400 | 201 | PASS |
| masterdata | MD-08 | 创建计量单位 | admin | `POST /masterdata/units` | 201 | 201 | PASS |
| masterdata | MD-09 | 创建客户(超长 name 1000) | admin | `POST /masterdata/customers` | 400/201 | 400 | PASS |
| masterdata | MD-10 | viewer 创建物品被拒 | viewer | `POST /masterdata/items` | 403 | 403 | PASS |
| workorder | WO-01 | 创建工作令 | admin | `POST /workorder/work-orders` | 201 | 500 | FAIL(D-8) |
| workorder | WO-02 | 幂等：首次 operationId | admin | `POST /workorder/work-orders` | 201 | 500 | FAIL(D-8) |
| workorder | WO-03 | 重复 operationId → 409(设计内) | admin | `POST /workorder/work-orders` | 409/200/201 | 201 | PASS |
| workorder | WO-04 | 缺 projectName | admin | `POST /workorder/work-orders` | 400 | 400 | PASS |
| workorder | WO-05 | 未知命令 kind | admin | `POST /workorder/work-orders` | 400 | 400 | PASS |
| workorder | WO-06 | 工作令列表 | admin | `GET /workorder/work-orders` | 200 | 200 | PASS |
| workorder | WO-07 | 工作令详情 | admin | `GET /workorder/work-orders/undefined` | 200 | 404 | BLOCKED(D-8 级联) |
| workorder | WO-08 | 挂接图纸附件 | admin | `POST /workorder/work-orders/undefined/attachments` | 201 | 201 | PASS |
| workorder | WO-09 | 过期 expectedRevision → 409 | admin | `POST /workorder/work-orders/undefined/attachments` | 409 | 201 | BLOCKED(D-8 级联) |
| workorder | WO-10 | viewer 创建工作令被拒 | viewer | `POST /workorder/work-orders` | 403 | 403 | PASS |
| listing | LS-01 | Excel 导入加工件清单(xlsx) | admin | `POST /listing/imports` | 201 | 400 | BLOCKED(D-8 级联) |
| listing | LS-02 | 导入非法 base64(非 xlsx) | admin | `POST /listing/imports` | 400/422 | 400 | PASS |
| listing | LS-03 | 清单列表 | admin | `GET /listing/sheets` | 200 | 400 | BLOCKED(D-8 级联) |
| listing | LS-04 | upload-stats 409(设计内) | admin | `GET /listing/upload-stats` | 409 | 409 | PASS |
| listing | LS-05 | 缺口核查 | admin | `POST /listing/work-orders/undefined/gap-checks` | 200/201/400 | 400 | PASS |
| purchase(listing) | PU-01 | 提交采购订单 | admin | `POST /purchase/orders` | 201 | 500 | FAIL(D-8) |
| purchase(listing) | PU-02 | 数量为负 | admin | `POST /purchase/orders` | 400 | 400 | PASS |
| purchase(listing) | PU-03 | 空明细行 | admin | `POST /purchase/orders` | 400 | 400 | PASS |
| purchase(listing) | PU-04 | 非法日期 | admin | `POST /purchase/orders` | 400 | 400 | PASS |
| purchase(listing) | PU-05 | 采购订单列表 | admin | `GET /purchase/orders` | 200 | 200 | PASS |
| purchase(listing) | PU-06 | 采购明细导出 xlsx | admin | `GET /purchase/details/export` | 200 | 200 | PASS |
| purchase(listing) | PU-07 | 逾期列表 | admin | `GET /purchase/overdue` | 200 | 200 | PASS |
| dispatch | DP-01 | 创建派工单 | admin | `POST /dispatch/orders` | 201 | 201 | PASS |
| dispatch | DP-02 | 派工指派给 admin | admin | `POST /dispatch/orders/dsp-01a17653-cf9d-73b0-97d5-2e20e73e51b1/assign` | 201 | 201 | PASS |
| dispatch | DP-03 | 数量为 0 | admin | `POST /dispatch/orders` | 400 | 400 | PASS |
| dispatch | DP-04 | 派工列表 | admin | `GET /dispatch/orders` | 200 | 200 | PASS |
| reporting | RP-01 | 报工提交 | admin | `POST /reports` | 201 | 500 | FAIL(D-8) |
| reporting | RP-02 | 报工数量超派工量(11>10) | admin | `POST /reports` | 400/409/422 | 201 | FAIL(D-9) |
| reporting | RP-03 | 报工核查(verify) | admin | `POST /reports/undefined/verify` | 201 | 201 | PASS |
| reporting | RP-04 | 重复核查 | admin | `POST /reports/undefined/verify` | 409/400 | 201 | BLOCKED(D-8 级联) |
| reporting | RP-05 | 报工列表 | admin | `GET /reports` | 200 | 200 | PASS |
| hours | HR-01 | 工作令工时汇总 | admin | `GET /hours/work-orders/undefined` | 200 | 200 | PASS |
| hours | HR-02 | 我的工时(本月) | admin | `GET /hours/my?month=2026-10` | 200 | 200 | PASS |
| hours | HR-03 | 月度汇总 | admin | `GET /hours/months/2026-10/summary` | 200 | 200 | PASS |
| hours | HR-04 | 非法月份 | admin | `GET /hours/months/2026-13/summary` | 400 | 400 | PASS |
| payroll | PY-01 | 发布计薪规则 | admin | `POST /payroll/rules/commands` | 201 | 201 | PASS |
| payroll | PY-02 | 负费率 | admin | `POST /payroll/rules/commands` | 400 | 400 | PASS |
| payroll | PY-03 | 月度计薪跑批 | admin | `POST /payroll/runs/commands` | 201 | 201 | PASS |
| payroll | PY-04 | 计薪结果查询 | admin | `GET /payroll/runs?month=2026-10&personId=user-seed-admin-a` | 200 | 200 | PASS |
| payroll | PY-05 | 计薪导出 | admin | `POST /payroll/exports/commands` | 201 | 201 | PASS |
| costing | CS-01 | 未重建快照 → 404(设计内) | admin | `GET /costing/work-orders/undefined/summary` | 404 | 404 | PASS |
| costing | CS-02 | 发布成本模型 | admin | `POST /costing/models` | 201 | 201 | PASS |
| costing | CS-03 | 成本重建 | admin | `POST /costing/rebuild` | 201 | 400 | BLOCKED(D-8 级联) |
| costing | CS-04 | 重建后成本汇总 | admin | `GET /costing/work-orders/undefined/summary` | 200 | 200 | PASS |
| costing | CS-05 | 成本模型列表 | admin | `GET /costing/models` | 200 | 200 | PASS |
| costing | CS-06 | 项目成本 404(设计内) | admin | `GET /costing/project/summary?projectName=none` | 404/400 | 400 | PASS |
| maintenance | MT-01 | 发布保养计划 | admin | `POST /maintenance/plans/commands` | 201 | 201 | PASS |
| maintenance | MT-02 | 到期扫描 | admin | `POST /maintenance/plans/due-scan/commands` | 201 | 201 | PASS |
| maintenance | MT-03 | 建维修任务 | admin | `POST /maintenance/tasks/commands` | 201 | 201 | PASS |
| maintenance | MT-04 | 开始任务 | admin | `POST /maintenance/tasks/start/commands` | 201 | 400 | N/A(脚本/设计) |
| maintenance | MT-05 | 完成任务 | admin | `POST /maintenance/tasks/complete/commands` | 201 | 400 | N/A(脚本/设计) |
| maintenance | MT-06 | 完成后再取消(非法迁移) | admin | `POST /maintenance/tasks/cancel/commands` | 400/409 | 400 | PASS |
| maintenance | MT-07 | 任务列表/历史 | admin | `GET /maintenance/history` | 200 | 200 | PASS |
| drawing | DW-01 | 发布图纸 v1 | admin | `POST /drawing/revisions/commands` | 201 | 201 | PASS |
| drawing | DW-02 | 发布图纸 v2 | admin | `POST /drawing/revisions/commands` | 201 | 201 | PASS |
| drawing | DW-03 | 版本列表 | admin | `GET /drawing/revisions/qamvopwomo-DWG` | 200 | 400 | N/A(脚本/设计) |
| drawing | DW-04 | 非法密级 | admin | `POST /drawing/revisions/commands` | 400 | 400 | PASS |
| drawing | DW-05 | 查看审计 | admin | `GET /drawing/view-audit` | 200 | 200 | PASS |
| dispatch | DP-05 | 外协派工 | admin | `POST /dispatch/orders` | 201 | 500 | FAIL(D-8) |
| dispatch | DP-06 | 外协指派 | admin | `POST /dispatch/orders/undefined/assign` | 201 | 201 | PASS |
| dispatch | DP-07 | 外协开始 | admin | `POST /dispatch/orders/undefined/start` | 201 | 201 | PASS |
| dispatch | DP-08 | 外协完成→回厂质检联动 | admin | `POST /dispatch/orders/undefined/complete` | 201 | 201 | PASS |
| inspection | IN-01 | 回厂质检单读回 | admin | `GET /inspection/orders/undefined` | 200 | 404 | BLOCKED(D-8 级联) |
| inspection | IN-02 | 判定合格+不合格数超总数 | admin | `POST /inspection/orders/undefined/judgment` | 400/422 | 201 | BLOCKED(D-8 级联) |
| inspection | IN-03 | 质检判定 合格5 | admin | `POST /inspection/orders/undefined/judgment` | 201 | 201 | PASS |
| inspection | IN-04 | 质检汇总 | admin | `GET /inspection/summary` | 200 | 200 | PASS |
| inspection | IN-05 | 不合格品列表 | admin | `GET /inspection/nonconformities` | 200 | 200 | PASS |
| dispatch | DP-09 | 外协明细 | admin | `GET /outsourcing/lines` | 200 | 400 | N/A(脚本/设计) |
| metric-pack | MP-01 | 激活指标包 | admin | `POST /metric-pack/activations/commands` | 201/409 | 201 | PASS |
| metric-pack | MP-02 | 指标包列表 | admin | `GET /metric-pack/packs` | 200 | 200 | PASS |
| standardreports | SR-01 | 标准报表指标清单 | admin | `GET /standard-reports/metrics` | 200 | 200 | PASS |
| standardreports | SR-02 | 标准报表查询 | admin | `POST /standard-reports/query` | 200/201 | 201 | PASS |
| standardreports | SR-03 | 未知指标 | admin | `POST /standard-reports/query` | 400/404 | 404 | PASS |
| workbench | WB-01 | admin 给审批人派待办 | admin | `POST /workbench/todos` | 201 | 201 | PASS |
| workbench | WB-02 | 审批人工作台可见待办 | approver | `GET /workbench/todos` | 200 | 200 | PASS |
| workbench | WB-03 | 审批人完成待办(无 todo:write) | approver | `POST /workbench/todos/01a17653-d190-70b9-914b-985dc4f2fab7/done` | 403 | 403 | PASS |
| workbench | WB-04 | admin 完成待办 | admin | `POST /workbench/todos/01a17653-d190-70b9-914b-985dc4f2fab7/done` | 200/201 | 404 | N/A(脚本/设计) |
| notifications | NT-01 | 发送通知给审批人 | admin | `POST /notifications` | 201 | 400 | N/A(脚本/设计) |
| notifications | NT-02 | 审批人读通知(无 notification:read) | approver | `GET /notifications` | 403 | 403 | PASS |
| notifications | NT-03 | admin 未读数 | admin | `GET /notifications/unread-count` | 200 | 200 | PASS |
| notifications | NT-04 | 全部已读 | admin | `POST /notifications/read-all` | 200/201 | 201 | PASS |
| inventory | IV-01 | 创建仓库 | admin | `POST /inventory/warehouses` | 201 | 400 | N/A(脚本/设计) |
| inventory | IV-02 | 库存列表 | admin | `GET /inventory/stock` | 200 | 200 | PASS |
| inventory | IV-03 | 出库超库存(负库存) | admin | `POST /inventory/stock/issues` | 400/409/422 | 400 | PASS |
| inventory | IV-04 | 收发存流水 | admin | `GET /inventory/movements` | 200 | 200 | PASS |
| issue | IS-01 | 发料任务列表 | admin | `GET /issue/tasks` | 200 | 200 | PASS |
| issue | IS-02 | 发料记录列表 | admin | `GET /issue/records` | 200 | 200 | PASS |
| aftercare-claim | AC-01 | 售后索赔上下文 | admin | `GET /dispatch/aftercare/claims/context` | 200/400 | 400 | PASS |
| attachment | AT-01 | 上传附件 | admin | `POST /attachment/upload` | 201 | 201 | PASS |
| attachment | AT-02 | 按业务 id 列出 | admin | `GET /attachment/list-by-biz-id?bizId=qamvopwomo` | 200 | 200 | PASS |
| attachment | AT-03 | 文件名为空 | admin | `POST /attachment/upload` | 400 | 400 | PASS |
| attachment | AT-04 | 删除附件 | admin | `POST /attachment/remove` | 200/201 | 201 | PASS |
| attachment | AT-05 | 删除后列表为空 | admin | `GET /attachment/list-by-biz-id?bizId=qamvopwomo` | 200 | 200 | PASS |
| menu-config | MC-01 | 菜单配置列表 | admin | `GET /menu-config/configs` | 200 | 200 | PASS |
| menu-config | MC-02 | 非法配置 code | admin | `POST /menu-config/configs` | 400 | 400 | PASS |
| approval-config | AF-01 | 校验非法流配置 | admin | `POST /approval-config/validate` | 400 | 400 | PASS |
| approval-config | AF-02 | 流配置列表 | admin | `GET /approval-config/flows` | 200 | 200 | PASS |
| audit | AU-01 | 审计日志(含本轮写操作) | admin | `GET /audit/logs` | 200 | 200 | PASS |
| demo | DM-01 | demo ping(无鉴权) | None | `GET /demo/ping` | 200 | 200 | PASS |
| demo | DM-02 | demo data(viewer) | viewer | `GET /demo/data` | 403 | 403 | PASS |
| baseline | BL-01 | 工序列表 | admin | `GET /baseline/processes` | 200 | 200 | PASS |
| baseline | BL-02 | 非 UUID 物料校验 id → 应 400/404 | admin | `GET /baseline/material-validations/abc` | 400/404 | 500 | FAIL(D-7) |
| baseline | BL-03 | 故障上报列表 | admin | `GET /baseline/fault-reports` | 200 | 200 | PASS |
| org | OG-01 | 角色列表 | admin | `GET /org/roles` | 200 | 200 | PASS |
| core | CO-01 | /modules 27 个 | None | `GET /modules` | 200 | 200 | PASS |

## 2. 角色场景与跨角色交接（49 条）

| 角色 | 编号 | 场景 | 请求 | 期望 | 实际 | 状态 |
|---|---|---|---|---|---|---|
| admin | PA-01 | 创建部门 | `POST /org/departments` | 201 | 201 | PASS |
| admin | PA-02 | 部门 code 重复 | `POST /org/departments` | [400, 409] | 409 | PASS |
| admin | PA-03 | 部门缺必填 name | `POST /org/departments` | 400 | 400 | PASS |
| admin | PA-04 | 创建岗位 | `POST /org/positions` | 201 | 201 | PASS |
| admin | PA-05 | 创建角色 qa-clerk | `POST /org/roles` | 201 | 201 | PASS |
| admin | PA-06 | 给角色授予 customer:read | `PUT /org/roles/qa113309-clerk/permissions` | [200, 201] | 200 | PASS |
| admin | PA-07 | 创建用户 | `POST /org/users` | 201 | 201 | PASS |
| admin | PA-08 | 用户名重复 | `POST /org/users` | [400, 409] | 409 | PASS |
| admin | PA-09 | 分配角色给用户 | `PUT /org/users/01a17644-e6e8-7613-95d4-bf745c5cfd84/roles` | [200, 201] | 200 | PASS |
| admin | PA-10 | 停用用户 | `PUT /org/users/01a17644-e6e8-7613-95d4-bf745c5cfd84/status` | [200, 201] | 200 | PASS |
| admin | PA-11 | 创建物品 | `POST /masterdata/items` | 201 | 201 | PASS |
| admin | PA-12 | 列表可见新建物品 | `GET /masterdata/items` | 含新物品 | True | PASS |
| admin | PA-13 | 物品 code 超长(300) | `POST /masterdata/items` | 400 | 400 | PASS |
| admin | PA-14 | 物品空字符串 name | `POST /masterdata/items` | 400 | 400 | PASS |
| admin | PA-15 | 创建供应商 | `POST /masterdata/suppliers` | 201 | 201 | PASS |
| admin | PA-16 | 审批流配置列表 | `GET /approval-config/flows` | 200 | 200 | PASS |
| admin | PA-17 | 菜单配置读取 | `GET /menu-config/configs` | 200 | 200 | PASS |
| admin | PA-18 | 审计日志可读 | `GET /audit/logs` | 200 | 200 | PASS |
| demo-admin(提交人) | PS-01 | 发起审批案件(引用物品) | `POST /approval/cases` | 201 | 201 | PASS |
| demo-admin(提交人) | PS-02 | 空审批人被拒 | `POST /approval/cases` | 400 | 400 | PASS |
| demo-admin(提交人) | PS-03 | 发起第二个案件(用于驳回) | `POST /approval/cases` | 201 | 201 | PASS |
| demo-admin(提交人) | PS-04 | 发起审批:不存在的审批人 | `POST /approval/cases` | [400, 404, 422] | 201 | FAIL(D-11) |
| demo-admin(提交人) | PS-05 | 提交采购申请 | `POST /purchase/requests` | [201, 400] | 400 | PASS |
| approver | PP-01 | 工作台汇总可读 | `GET /workbench/summary` | 200 | 200 | PASS |
| approver | PP-02 | 待办列表可读 | `GET /workbench/todos` | 200 | 200 | PASS |
| approver | PP-03 | 审批案件列表 | `GET /approval/cases` | 200 | 200 | PASS |
| approver | PP-04 | 批准 case1(错误 objectVersion) | `POST /approval/cases/case-681b5033-f8af-45f2-988d-491b7592cdd3/decisions` | 409 | 409 | PASS |
| approver | PP-05 | 批准 case1 | `POST /approval/cases/case-681b5033-f8af-45f2-988d-491b7592cdd3/decisions` | [200, 201] | 201 | PASS |
| approver | PP-06 | 重复审批已结案件 | `POST /approval/cases/case-681b5033-f8af-45f2-988d-491b7592cdd3/decisions` | [400, 409] | 409 | PASS |
| approver | PP-07 | 驳回 case2 | `POST /approval/cases/case-8afd156a-6952-41d4-aa5b-04eb78d67d8b/decisions` | [200, 201] | 201 | PASS |
| approver | PP-08 | 非法决策值 | `POST /approval/cases/case-8afd156a-6952-41d4-aa5b-04eb78d67d8b/decisions` | 400 | 400 | PASS |
| approver | PP-09 | 案件详情含事件与记录 | `GET /approval/cases/case-681b5033-f8af-45f2-988d-491b7592cdd3` | 200 | 200 | PASS |
| approver | PP-10 | 越权:创建物品 | `POST /masterdata/items` | 403 | 403 | PASS |
| approver | PP-11 | 越权:读用户 | `GET /org/users` | 403 | 403 | PASS |
| approver | PP-12 | 越权:读审计 | `GET /audit/logs` | 403 | 403 | PASS |
| viewer | PV-01 | 无策略访客 GET /approval/cases 应被拒 | `GET /approval/cases` | 403 | 403 | PASS |
| viewer | PV-02 | 无策略访客 GET /masterdata/items 应被拒 | `GET /masterdata/items` | 403 | 403 | PASS |
| viewer | PV-03 | 无策略访客 GET /org/users 应被拒 | `GET /org/users` | 403 | 403 | PASS |
| viewer | PV-04 | 无策略访客 POST /masterdata/items 应被拒 | `POST /masterdata/items` | 403 | 403 | PASS |
| viewer | PV-05 | 无策略访客 POST /approval/cases/case-8afd156a-6952-41d4-aa5b-04eb78d67d8b/decisions 应被拒 | `POST /approval/cases/case-8afd156a-6952-41d4-aa5b-04eb78d67d8b/decisions` | 403 | 403 | PASS |
| viewer | PV-06 | 无策略访客 PUT /org/users/01a17644-e6e8-7613-95d4-bf745c5cfd84/status 应被拒 | `PUT /org/users/01a17644-e6e8-7613-95d4-bf745c5cfd84/status` | 403 | 403 | PASS |
| viewer | PV-07 | 无策略访客 POST /org/roles 应被拒 | `POST /org/roles` | 403 | 403 | PASS |
| viewer | PV-08 | 无策略访客 GET /workbench/summary 应被拒 | `GET /workbench/summary` | 403 | 403 | PASS |
| viewer | PV-09 | /auth/me 可用且 admin=false | `GET /auth/me` | 200 | 200 | PASS |
| 跨角色 | PX-01 | 提交→审批→提交人可见 approved | `GET /approval/cases/case-681b5033-f8af-45f2-988d-491b7592cdd3 as demo-admin` | approved | approved | PASS |
| 跨角色 | PX-02 | 驳回后提交人可见 rejected | `GET /approval/cases/case-8afd156a-6952-41d4-aa5b-04eb78d67d8b` | rejected | rejected | PASS |
| 跨角色 | PX-03 | 审批完成后审批人待办清空 | `GET /workbench/summary as approver` | approval open=0 | {"user": "user-seed-approver-a", "openTotal": 0, "bySource": []} | PASS |
| 跨角色 | PX-04 | 审批结果对 viewer(无策略)不可见 | `GET case as viewer` | 403 | 403 | PASS |
| 跨角色 | PX-05 | 审计日志记录审批写操作 | `GET /audit/logs` | >=4 条 approval 记录 | 10 | PASS |

## 3. UI 页面巡检（Playwright，127 页次，4 角色 × 桌面 1440x900 / 移动 390x844 并行）

| 角色 | 端 | 路由 | 模块 | 渲染 | ≥400 响应 | 截图 |
|---|---|---|---|---|---|---|
| admin | 桌面 | / | home | PASS | — | saas-func-shots/home/admin-desktop-_.png |
| admin | 桌面 | /overview | overview | PASS | — | saas-func-shots/overview/admin-desktop-_overview.png |
| admin | 桌面 | /masterdata/items | m-asterdata | PASS | — | saas-func-shots/m-asterdata/admin-desktop-_masterdata_items.png |
| admin | 桌面 | /masterdata/resources | m-asterdata | PASS | — | saas-func-shots/m-asterdata/admin-desktop-_masterdata_resources.png |
| admin | 桌面 | /masterdata/customers | m-asterdata | PASS | — | saas-func-shots/m-asterdata/admin-desktop-_masterdata_customers.png |
| admin | 桌面 | /masterdata/suppliers | m-asterdata | PASS | — | saas-func-shots/m-asterdata/admin-desktop-_masterdata_suppliers.png |
| admin | 桌面 | /masterdata/units | m-asterdata | PASS | — | saas-func-shots/m-asterdata/admin-desktop-_masterdata_units.png |
| admin | 桌面 | /workorders | workorders | PASS | — | saas-func-shots/workorders/admin-desktop-_workorders.png |
| admin | 桌面 | /workorders/parts | workorders | PASS | — | saas-func-shots/workorders/admin-desktop-_workorders_parts.png |
| admin | 桌面 | /listings/sheets | listings | PASS | — | saas-func-shots/listings/admin-desktop-_listings_sheets.png |
| admin | 桌面 | /listings/gap-checks | listings | PASS | — | saas-func-shots/listings/admin-desktop-_listings_gap_checks.png |
| admin | 桌面 | /dispatches | dispatches | PASS | — | saas-func-shots/dispatches/admin-desktop-_dispatches.png |
| admin | 桌面 | /outsourcing/lines | outsourcing | PASS | — | saas-func-shots/outsourcing/admin-desktop-_outsourcing_lines.png |
| admin | 桌面 | /scan | scan | PASS | — | saas-func-shots/scan/admin-desktop-_scan.png |
| admin | 桌面 | /reports | reports | PASS | — | saas-func-shots/reports/admin-desktop-_reports.png |
| admin | 桌面 | /reports/verification | reports | PASS | — | saas-func-shots/reports/admin-desktop-_reports_verification.png |
| admin | 桌面 | /purchase/requests | purchase | PASS | — | saas-func-shots/purchase/admin-desktop-_purchase_requests.png |
| admin | 桌面 | /purchase/orders | purchase | PASS | — | saas-func-shots/purchase/admin-desktop-_purchase_orders.png |
| admin | 桌面 | /purchase/returns | purchase | PASS | — | saas-func-shots/purchase/admin-desktop-_purchase_returns.png |
| admin | 桌面 | /purchase/details | purchase | PASS | — | saas-func-shots/purchase/admin-desktop-_purchase_details.png |
| admin | 桌面 | /inspections | inspections | PASS | — | saas-func-shots/inspections/admin-desktop-_inspections.png |
| admin | 桌面 | /inspections/nonconformities | inspections | PASS | — | saas-func-shots/inspections/admin-desktop-_inspections_nonconformities.png |
| admin | 桌面 | /inventory/warehouses | inventory | PASS | — | saas-func-shots/inventory/admin-desktop-_inventory_warehouses.png |
| admin | 桌面 | /inventory/stock | inventory | PASS | — | saas-func-shots/inventory/admin-desktop-_inventory_stock.png |
| admin | 桌面 | /inventory/stock-operations | inventory | PASS | — | saas-func-shots/inventory/admin-desktop-_inventory_stock_operations.png |
| admin | 桌面 | /inventory/stocktakes | inventory | PASS | — | saas-func-shots/inventory/admin-desktop-_inventory_stocktakes.png |
| admin | 桌面 | /inventory/shipping-orders | inventory | PASS | — | saas-func-shots/inventory/admin-desktop-_inventory_shipping_orders.png |
| admin | 桌面 | /hours/stats | hours | PASS | — | saas-func-shots/hours/admin-desktop-_hours_stats.png |
| admin | 桌面 | /costing | costing | PASS | — | saas-func-shots/costing/admin-desktop-_costing.png |
| admin | 桌面 | /standard-reports | standard-reports | PASS | — | saas-func-shots/standard-reports/admin-desktop-_standard_reports.png |
| admin | 桌面 | /baseline/processes | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_processes.png |
| admin | 桌面 | /baseline/routings | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_routings.png |
| admin | 桌面 | /baseline/standard-times | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_standard_times.png |
| admin | 桌面 | /baseline/equipment | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_equipment.png |
| admin | 桌面 | /baseline/fault-reports | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_fault_reports.png |
| admin | 桌面 | /baseline/outsourcing-rules | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_outsourcing_rules.png |
| admin | 桌面 | /baseline/material-validations | baseline | PASS | — | saas-func-shots/baseline/admin-desktop-_baseline_material_validations.png |
| admin | 桌面 | /system/users | system | PASS | — | saas-func-shots/system/admin-desktop-_system_users.png |
| admin | 桌面 | /system/roles | system | PASS | — | saas-func-shots/system/admin-desktop-_system_roles.png |
| admin | 桌面 | /system/departments | system | PASS | — | saas-func-shots/system/admin-desktop-_system_departments.png |
| admin | 桌面 | /system/positions | system | PASS | — | saas-func-shots/system/admin-desktop-_system_positions.png |
| admin | 桌面 | /system/audit | system | PASS | — | saas-func-shots/system/admin-desktop-_system_audit.png |
| admin | 桌面 | /system/menus | system | PASS | — | saas-func-shots/system/admin-desktop-_system_menus.png |
| admin | 桌面 | /system/approval-config | system | PASS | — | saas-func-shots/system/admin-desktop-_system_approval_config.png |
| admin | 桌面 | /notifications | notifications | PASS | — | saas-func-shots/notifications/admin-desktop-_notifications.png |
| admin | 移动 | /m | m- | PASS | — | saas-func-shots/m-/admin-mobile-_m.png |
| admin | 移动 | /m/report | m-report | PASS | — | saas-func-shots/m-report/admin-mobile-_m_report.png |
| admin | 移动 | /scan | scan | PASS | — | saas-func-shots/scan/admin-mobile-_scan.png |
| admin | 移动 | /m/stock | m-stock | PASS | — | saas-func-shots/m-stock/admin-mobile-_m_stock.png |
| admin | 移动 | /m/hours | m-hours | PASS | — | saas-func-shots/m-hours/admin-mobile-_m_hours.png |
| admin | 移动 | /m/verify | m-verify | PASS | — | saas-func-shots/m-verify/admin-mobile-_m_verify.png |
| admin | 移动 | /m/parts | m-parts | PASS | — | saas-func-shots/m-parts/admin-mobile-_m_parts.png |
| admin | 移动 | /m/parts-approval | m-parts-approval | PASS | — | saas-func-shots/m-parts-approval/admin-mobile-_m_parts_approval.png |
| admin | 移动 | /m/inspection | m-inspection | PASS | — | saas-func-shots/m-inspection/admin-mobile-_m_inspection.png |
| admin | 移动 | /m/fault | m-fault | PASS | — | saas-func-shots/m-fault/admin-mobile-_m_fault.png |
| admin | 移动 | /m/receipt | m-receipt | PASS | — | saas-func-shots/m-receipt/admin-mobile-_m_receipt.png |
| admin | 移动 | /m/transfer | m-transfer | PASS | — | saas-func-shots/m-transfer/admin-mobile-_m_transfer.png |
| admin | 移动 | /m/stocktake | m-stocktake | PASS | — | saas-func-shots/m-stocktake/admin-mobile-_m_stocktake.png |
| admin | 移动 | /m/progress | m-progress | PASS | — | saas-func-shots/m-progress/admin-mobile-_m_progress.png |
| admin | 移动 | /m/op-progress | m-op-progress | PASS | — | saas-func-shots/m-op-progress/admin-mobile-_m_op_progress.png |
| admin | 移动 | /m/mine | m-mine | PASS | — | saas-func-shots/m-mine/admin-mobile-_m_mine.png |
| approver | 桌面 | / | home | PASS | GET 403 /menu-config/configs, GET 403 /notifications/unread-count | saas-func-shots/home/approver-desktop-_.png |
| approver | 桌面 | /overview | overview | PASS | GET 403 /workorder/delivery-situation | saas-func-shots/overview/approver-desktop-_overview.png |
| approver | 移动 | /m | m- | PASS | GET 403 /menu-config/configs | saas-func-shots/m-/approver-mobile-_m.png |
| viewer | 桌面 | / | home | PASS | GET 403 /menu-config/configs, GET 403 /workbench/todos, GET 403 /notifications/unread-count, GET 403 /workbenc | saas-func-shots/home/viewer-desktop-_.png |
| viewer | 移动 | /m | m- | PASS | GET 403 /workbench/todos, GET 403 /menu-config/configs | saas-func-shots/m-/viewer-mobile-_m.png |
| demo-admin | 桌面 | / | home | PASS | — | saas-func-shots/home/demo-admin-desktop-_.png |
| demo-admin | 桌面 | /overview | overview | PASS | — | saas-func-shots/overview/demo-admin-desktop-_overview.png |
| demo-admin | 桌面 | /masterdata/items | m-asterdata | PASS | — | saas-func-shots/m-asterdata/demo-admin-desktop-_masterdata_items.png |
| demo-admin | 桌面 | /masterdata/resources | m-asterdata | PASS | — | saas-func-shots/m-asterdata/demo-admin-desktop-_masterdata_resources.png |
| demo-admin | 桌面 | /masterdata/customers | m-asterdata | PASS | — | saas-func-shots/m-asterdata/demo-admin-desktop-_masterdata_customers.png |
| demo-admin | 桌面 | /masterdata/suppliers | m-asterdata | PASS | — | saas-func-shots/m-asterdata/demo-admin-desktop-_masterdata_suppliers.png |
| demo-admin | 桌面 | /masterdata/units | m-asterdata | PASS | — | saas-func-shots/m-asterdata/demo-admin-desktop-_masterdata_units.png |
| demo-admin | 桌面 | /workorders | workorders | PASS | — | saas-func-shots/workorders/demo-admin-desktop-_workorders.png |
| demo-admin | 桌面 | /workorders/parts | workorders | PASS | — | saas-func-shots/workorders/demo-admin-desktop-_workorders_parts.png |
| demo-admin | 桌面 | /listings/sheets | listings | PASS | — | saas-func-shots/listings/demo-admin-desktop-_listings_sheets.png |
| demo-admin | 桌面 | /listings/gap-checks | listings | PASS | — | saas-func-shots/listings/demo-admin-desktop-_listings_gap_checks.png |
| demo-admin | 桌面 | /dispatches | dispatches | PASS | — | saas-func-shots/dispatches/demo-admin-desktop-_dispatches.png |
| demo-admin | 桌面 | /outsourcing/lines | outsourcing | PASS | — | saas-func-shots/outsourcing/demo-admin-desktop-_outsourcing_lines.png |
| demo-admin | 桌面 | /scan | scan | PASS | — | saas-func-shots/scan/demo-admin-desktop-_scan.png |
| demo-admin | 桌面 | /reports | reports | PASS | — | saas-func-shots/reports/demo-admin-desktop-_reports.png |
| demo-admin | 桌面 | /reports/verification | reports | PASS | — | saas-func-shots/reports/demo-admin-desktop-_reports_verification.png |
| demo-admin | 桌面 | /purchase/requests | purchase | PASS | — | saas-func-shots/purchase/demo-admin-desktop-_purchase_requests.png |
| demo-admin | 桌面 | /purchase/orders | purchase | PASS | — | saas-func-shots/purchase/demo-admin-desktop-_purchase_orders.png |
| demo-admin | 桌面 | /purchase/returns | purchase | PASS | — | saas-func-shots/purchase/demo-admin-desktop-_purchase_returns.png |
| demo-admin | 桌面 | /purchase/details | purchase | PASS | — | saas-func-shots/purchase/demo-admin-desktop-_purchase_details.png |
| demo-admin | 桌面 | /inspections | inspections | PASS | — | saas-func-shots/inspections/demo-admin-desktop-_inspections.png |
| demo-admin | 桌面 | /inspections/nonconformities | inspections | PASS | — | saas-func-shots/inspections/demo-admin-desktop-_inspections_nonconformities.png |
| demo-admin | 桌面 | /inventory/warehouses | inventory | PASS | — | saas-func-shots/inventory/demo-admin-desktop-_inventory_warehouses.png |
| demo-admin | 桌面 | /inventory/stock | inventory | PASS | — | saas-func-shots/inventory/demo-admin-desktop-_inventory_stock.png |
| demo-admin | 桌面 | /inventory/stock-operations | inventory | PASS | — | saas-func-shots/inventory/demo-admin-desktop-_inventory_stock_operations.png |
| demo-admin | 桌面 | /inventory/stocktakes | inventory | PASS | — | saas-func-shots/inventory/demo-admin-desktop-_inventory_stocktakes.png |
| demo-admin | 桌面 | /inventory/shipping-orders | inventory | PASS | — | saas-func-shots/inventory/demo-admin-desktop-_inventory_shipping_orders.png |
| demo-admin | 桌面 | /hours/stats | hours | PASS | — | saas-func-shots/hours/demo-admin-desktop-_hours_stats.png |
| demo-admin | 桌面 | /costing | costing | PASS | — | saas-func-shots/costing/demo-admin-desktop-_costing.png |
| demo-admin | 桌面 | /standard-reports | standard-reports | PASS | — | saas-func-shots/standard-reports/demo-admin-desktop-_standard_reports.png |
| demo-admin | 桌面 | /baseline/processes | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_processes.png |
| demo-admin | 桌面 | /baseline/routings | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_routings.png |
| demo-admin | 桌面 | /baseline/standard-times | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_standard_times.png |
| demo-admin | 桌面 | /baseline/equipment | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_equipment.png |
| demo-admin | 桌面 | /baseline/fault-reports | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_fault_reports.png |
| demo-admin | 桌面 | /baseline/outsourcing-rules | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_outsourcing_rules.png |
| demo-admin | 桌面 | /baseline/material-validations | baseline | PASS | — | saas-func-shots/baseline/demo-admin-desktop-_baseline_material_validations.png |
| demo-admin | 桌面 | /system/users | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_users.png |
| demo-admin | 桌面 | /system/roles | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_roles.png |
| demo-admin | 桌面 | /system/departments | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_departments.png |
| demo-admin | 桌面 | /system/positions | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_positions.png |
| demo-admin | 桌面 | /system/audit | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_audit.png |
| demo-admin | 桌面 | /system/menus | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_menus.png |
| demo-admin | 桌面 | /system/approval-config | system | PASS | — | saas-func-shots/system/demo-admin-desktop-_system_approval_config.png |
| demo-admin | 桌面 | /notifications | notifications | PASS | — | saas-func-shots/notifications/demo-admin-desktop-_notifications.png |
| demo-admin | 移动 | /m | m- | PASS | — | saas-func-shots/m-/demo-admin-mobile-_m.png |
| demo-admin | 移动 | /m/report | m-report | PASS | — | saas-func-shots/m-report/demo-admin-mobile-_m_report.png |
| demo-admin | 移动 | /scan | scan | PASS | — | saas-func-shots/scan/demo-admin-mobile-_scan.png |
| demo-admin | 移动 | /m/stock | m-stock | PASS | — | saas-func-shots/m-stock/demo-admin-mobile-_m_stock.png |
| demo-admin | 移动 | /m/hours | m-hours | PASS | — | saas-func-shots/m-hours/demo-admin-mobile-_m_hours.png |
| demo-admin | 移动 | /m/verify | m-verify | PASS | — | saas-func-shots/m-verify/demo-admin-mobile-_m_verify.png |
| demo-admin | 移动 | /m/parts | m-parts | PASS | — | saas-func-shots/m-parts/demo-admin-mobile-_m_parts.png |
| demo-admin | 移动 | /m/parts-approval | m-parts-approval | PASS | — | saas-func-shots/m-parts-approval/demo-admin-mobile-_m_parts_approval.png |
| demo-admin | 移动 | /m/inspection | m-inspection | PASS | — | saas-func-shots/m-inspection/demo-admin-mobile-_m_inspection.png |
| demo-admin | 移动 | /m/fault | m-fault | PASS | — | saas-func-shots/m-fault/demo-admin-mobile-_m_fault.png |
| demo-admin | 移动 | /m/receipt | m-receipt | PASS | — | saas-func-shots/m-receipt/demo-admin-mobile-_m_receipt.png |
| demo-admin | 移动 | /m/transfer | m-transfer | PASS | — | saas-func-shots/m-transfer/demo-admin-mobile-_m_transfer.png |
| demo-admin | 移动 | /m/stocktake | m-stocktake | PASS | — | saas-func-shots/m-stocktake/demo-admin-mobile-_m_stocktake.png |
| demo-admin | 移动 | /m/progress | m-progress | PASS | — | saas-func-shots/m-progress/demo-admin-mobile-_m_progress.png |
| demo-admin | 移动 | /m/op-progress | m-op-progress | PASS | — | saas-func-shots/m-op-progress/demo-admin-mobile-_m_op_progress.png |
| demo-admin | 移动 | /m/mine | m-mine | PASS | — | saas-func-shots/m-mine/demo-admin-mobile-_m_mine.png |

## 4. 权限矩阵（268 条路由 × 无令牌/admin/approver/viewer）

| 模块 | 方法 | 路由 | 权限 | 无令牌 | admin | approver | viewer |
|---|---|---|---|---|---|---|---|
| reporting | POST | `/reports` | report:submit | 401 | 400 | 403 | 403 |
| reporting | POST | `/reports/batch` | report:submit | 401 | 400 | 403 | 403 |
| reporting | GET | `/reports` | report:read | 401 | 200 | 403 | 403 |
| reporting | GET | `/reports/mine` | report:read | 401 | 200 | 403 | 403 |
| reporting | GET | `/reports/pending-verification` | report:read | 401 | 200 | 403 | 403 |
| reporting | GET | `/reports/:id` | report:read | 401 | 404 | 403 | 403 |
| reporting | POST | `/reports/:id/audit-edit` | report:audit | 401 | 400 | 403 | 403 |
| reporting | POST | `/reports/:id/verify` | report:verify | 401 | 400 | 403 | 403 |
| reporting | POST | `/reports/:id/revoke` | report:revoke | 401 | 400 | 403 | 403 |
| reporting | GET | `/reporting/drawings/:drawingNo/operation-progress` | report:read | 401 | 200 | 403 | 403 |
| reporting | GET | `/reporting/output-trend` | report:read | 401 | 200 | 403 | 403 |
| workorder | POST | `/workorder/work-orders` | workorder:write | 401 | 400 | 403 | 403 |
| workorder | GET | `/workorder/work-orders` | workorder:read | 401 | 200 | 403 | 403 |
| workorder | GET | `/workorder/work-orders/:id` | workorder:read | 401 | 404 | 403 | 403 |
| workorder | POST | `/workorder/work-orders/:id/update` | workorder:write | 401 | 400 | 403 | 403 |
| workorder | POST | `/workorder/work-orders/:id/transitions` | workorder:transition | 401 | 400 | 403 | 403 |
| workorder | POST | `/workorder/work-orders/:id/close` | workorder:close | 401 | 400 | 403 | 403 |
| workorder | POST | `/workorder/work-orders/:id/attachments` | workorder:write | 401 | 400 | 403 | 403 |
| workorder | POST | `/workorder/work-orders/:id/kit-checks` | kit:refresh | 401 | 400 | 403 | 403 |
| workorder | GET | `/workorder/work-orders/:id/progress` | workorder:read | 401 | 404 | 403 | 403 |
| workorder | GET | `/workorder/work-orders/:id/machining-progress` | workorder:read | 401 | 404 | 403 | 403 |
| workorder | GET | `/workorder/work-orders/:id/assembly-progress` | workorder:read | 401 | 404 | 403 | 403 |
| workorder | GET | `/workorder/kit-board` | kit:read | 401 | 200 | 403 | 403 |
| workorder | GET | `/workorder/delivery-situation` | workorder:read | 401 | 200 | 403 | 403 |
| workorder | POST | `/workorder/parts-requests` | parts:request | 401 | 400 | 403 | 403 |
| workorder | GET | `/workorder/parts-requests` | parts:read | 401 | 200 | 403 | 403 |
| workorder | GET | `/workorder/parts-requests/:id` | parts:read | 401 | 404 | 403 | 403 |
| workorder | POST | `/workorder/parts-requests/:id/approval` | parts:approve | 401 | 400 | 403 | 403 |
| workorder | POST | `/workorder/parts-requests/:id/shipment` | parts:request | 401 | 400 | 403 | 403 |
| menu-config | GET | `/menu-config/configs` | menu:read | 401 | 200 | 403 | 403 |
| menu-config | POST | `/menu-config/configs` | menu:write | 401 | 400 | 403 | 403 |
| menu-config | GET | `/menu-config/configs/:id` | menu:read | 401 | 404 | 403 | 403 |
| menu-config | PUT | `/menu-config/configs/:id` | menu:write | 401 | 404 | 403 | 403 |
| menu-config | GET | `/menu-config/permission-codes` | menu:read | 401 | 200 | 403 | 403 |
| auth | POST | `/auth/login` | — | 400 | 400 | 400 | 400 |
| auth | GET | `/auth/me` | — | 401 | 200 | 200 | 200 |
| standardreports | GET | `/standard-reports/metrics` | report:read | 401 | 200 | 403 | 403 |
| standardreports | POST | `/standard-reports/query` | report:read | 401 | 400 | 403 | 403 |
| dispatch | POST | `/dispatch/orders` | dispatch:write | 401 | 400 | 403 | 403 |
| dispatch | GET | `/dispatch/orders` | dispatch:read | 401 | 200 | 403 | 403 |
| dispatch | GET | `/dispatch/orders/:id` | dispatch:read | 401 | 404 | 403 | 403 |
| dispatch | POST | `/dispatch/orders/:id/assign` | dispatch:assign | 401 | 400 | 403 | 403 |
| dispatch | POST | `/dispatch/orders/:id/start` | dispatch:write | 401 | 400 | 403 | 403 |
| dispatch | POST | `/dispatch/orders/:id/complete` | dispatch:write | 401 | 400 | 403 | 403 |
| dispatch | POST | `/dispatch/orders/:id/cancel` | dispatch:cancel | 401 | 400 | 403 | 403 |
| dispatch | GET | `/dispatch/tasks` | dispatch:read | 401 | 400 | 403 | 403 |
| dispatch | GET | `/dispatch/work-orders/:id/tasks` | dispatch:read | 401 | 200 | 403 | 403 |
| dispatch | GET | `/dispatch/work-orders/:id/progress-facts` | dispatch:read | 401 | 200 | 403 | 403 |
| dispatch | GET | `/outsourcing/lines` | outsourcing:read | 401 | 400 | 403 | 403 |
| dispatch | POST | `/outsourcing/lines/:id/price-backfill` | outsourcing:price | 401 | 400 | 403 | 403 |
| dispatch | GET | `/outsourcing/orders/:id/print-data` | outsourcing:read | 401 | 404 | 403 | 403 |
| dispatch | POST | `/outsourcing/orders/:id/print` | outsourcing:read | 401 | 404 | 403 | 403 |
| dispatch | GET | `/dispatch/aftercare/claims/by-dispatch/:id` | aftercare:read | 401 | 200 | 403 | 403 |
| dispatch | GET | `/dispatch/aftercare/claims/context` | aftercare:read | 401 | 400 | 403 | 403 |
| dispatch | POST | `/dispatch/aftercare/claims/save` | aftercare:claim | 401 | 400 | 403 | 403 |
| dispatch | POST | `/dispatch/aftercare/claims/update/:id` | aftercare:claim | 401 | 400 | 403 | 403 |
| workbench | GET | `/workbench/summary` | workbench:read | 401 | 200 | 200 | 403 |
| workbench | GET | `/workbench/todos` | workbench:read | 401 | 200 | 200 | 403 |
| workbench | POST | `/workbench/todos` | todo:write | 401 | 400 | 403 | 403 |
| workbench | POST | `/workbench/todos/:id/done` | todo:write | 401 | 404 | 403 | 403 |
| org | GET | `/org/users` | user:read | 401 | 200 | 403 | 403 |
| org | POST | `/org/users` | user:write | 401 | 400 | 403 | 403 |
| org | PUT | `/org/users/:id/roles` | user:write | 401 | 404 | 403 | 403 |
| org | PUT | `/org/users/:id/status` | user:write | 401 | 400 | 403 | 403 |
| org | GET | `/org/roles` | role:read | 401 | 200 | 403 | 403 |
| org | POST | `/org/roles` | role:write | 401 | 400 | 403 | 403 |
| org | PUT | `/org/roles/:name/permissions` | role:write | 401 | 404 | 403 | 403 |
| org | GET | `/org/departments` | department:read | 401 | 200 | 403 | 403 |
| org | POST | `/org/departments` | department:write | 401 | 400 | 403 | 403 |
| org | PUT | `/org/departments/:id` | department:write | 401 | 404 | 403 | 403 |
| org | GET | `/org/positions` | position:read | 401 | 200 | 403 | 403 |
| org | POST | `/org/positions` | position:write | 401 | 400 | 403 | 403 |
| org | PUT | `/org/positions/:id` | position:write | 401 | 404 | 403 | 403 |
| hours | POST | `/hours/ingest` | hours:rebuild | 401 | 400 | 403 | 403 |
| hours | POST | `/hours/rebuild-month` | hours:rebuild | 401 | 400 | 403 | 403 |
| hours | GET | `/hours/machining/stats` | hours:read | 401 | 200 | 403 | 403 |
| hours | GET | `/hours/months/:month/summary` | hours:read | 401 | 400 | 403 | 403 |
| hours | GET | `/hours/months/:month/details` | hours:read | 401 | 400 | 403 | 403 |
| hours | GET | `/hours/months/:month/ledgers` | hours:read | 401 | 400 | 403 | 403 |
| hours | GET | `/hours/my` | hours:read | 401 | 200 | 403 | 403 |
| hours | GET | `/hours/work-orders/:id` | hours:read | 401 | 200 | 403 | 403 |
| hours | GET | `/hours/entries/:id` | hours:read | 401 | 404 | 403 | 403 |
| hours | GET | `/hours/events` | hours:read | 401 | 200 | 403 | 403 |
| audit | GET | `/audit/logs` | audit:read | 401 | 200 | 403 | 403 |
| approval | POST | `/approval/cases` | approval:write | 401 | 400 | 400 | 403 |
| approval | GET | `/approval/cases` | approval:read | 401 | 200 | 200 | 403 |
| approval | GET | `/approval/cases/:id` | approval:read | 401 | 404 | 404 | 403 |
| approval | POST | `/approval/cases/:id/decisions` | approval:write | 401 | 400 | 400 | 403 |
| inventory | POST | `/inventory/warehouses` | warehouse:write | 401 | 400 | 403 | 403 |
| inventory | GET | `/inventory/warehouses` | warehouse:read | 401 | 200 | 403 | 403 |
| inventory | GET | `/inventory/warehouses/:id` | warehouse:read | 401 | 404 | 403 | 403 |
| inventory | POST | `/inventory/stock/receipts` | stock:receive | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/stock/issues` | stock:issue | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/stock/transfers` | stock:transfer | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/stocktakes` | stocktake:record | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/stocktakes/:id/records` | stocktake:record | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/stocktakes/:id/approval` | stocktake:approve | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/shipping-orders` | shipping:execute | 401 | 400 | 403 | 403 |
| inventory | POST | `/inventory/shipping-orders/:id/confirm` | shipping:execute | 401 | 400 | 403 | 403 |
| inventory | GET | `/inventory/shipping-orders` | shipping:read | 401 | 200 | 403 | 403 |
| inventory | GET | `/inventory/shipping-orders/:id` | shipping:read | 401 | 404 | 403 | 403 |
| inventory | GET | `/inventory/stock` | stock:read | 401 | 200 | 403 | 403 |
| inventory | GET | `/inventory/stock/locations` | stock:read | 401 | 200 | 403 | 403 |
| inventory | GET | `/inventory/movements` | stock:read | 401 | 200 | 403 | 403 |
| inventory | GET | `/inventory/stocktakes` | stocktake:read | 401 | 200 | 403 | 403 |
| inventory | GET | `/inventory/stocktakes/:id` | stocktake:read | 401 | 404 | 403 | 403 |
| costing | POST | `/costing/project/rebuild` | costing:rebuild | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/project/summary` | costing:read | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/project/detail` | costing:read | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/project/snapshots` | costing:read | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/project/entries` | costing:read | 401 | 400 | 403 | 403 |
| costing | POST | `/costing/price-entry` | costing:rebuild | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/price-entries` | costing:read | 401 | 400 | 403 | 403 |
| costing | POST | `/costing/models` | costing:model-manage | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/models/compare` | costing:read | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/models/:code` | costing:read | 401 | 404 | 403 | 403 |
| costing | GET | `/costing/models` | costing:read | 401 | 200 | 403 | 403 |
| costing | POST | `/costing/rebuild` | costing:rebuild | 401 | 400 | 403 | 403 |
| costing | POST | `/costing/export` | costing:read | 401 | 400 | 403 | 403 |
| costing | GET | `/costing/work-orders/:id/summary` | costing:read | 401 | 404 | 403 | 403 |
| costing | GET | `/costing/work-orders/:id/details` | costing:read | 401 | 200 | 403 | 403 |
| costing | GET | `/costing/work-orders/:id/snapshots` | costing:read | 401 | 200 | 403 | 403 |
| costing | GET | `/costing/events` | costing:read | 401 | 200 | 403 | 403 |
| baseline | POST | `/baseline/processes/commands` | process:write | 401 | 400 | 403 | 403 |
| baseline | GET | `/baseline/processes` | process:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/processes/:code` | process:read | 401 | 404 | 403 | 403 |
| baseline | POST | `/baseline/outsourcing-rules/commands` | outsourcing-rule:write | 401 | 400 | 403 | 403 |
| baseline | GET | `/baseline/outsourcing-rules` | outsourcing-rule:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/outsourcing-rules/:code` | outsourcing-rule:read | 401 | 404 | 403 | 403 |
| baseline | POST | `/baseline/equipment/commands` | equipment:write | 401 | 400 | 403 | 403 |
| baseline | GET | `/baseline/equipment` | equipment:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/equipment/:code` | equipment:read | 401 | 404 | 403 | 403 |
| baseline | GET | `/baseline/material-validations` | material-validation:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/material-validations/:id` | material-validation:read | 401 | 500 | 403 | 403 |
| baseline | POST | `/baseline/routings/commands` | routing:write | 401 | 400 | 403 | 403 |
| baseline | GET | `/baseline/routings` | routing:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/routings/:drawingNo` | routing:read | 401 | 404 | 403 | 403 |
| baseline | POST | `/baseline/standard-times/commands` | standardtime:write | 401 | 400 | 403 | 403 |
| baseline | GET | `/baseline/standard-times` | standardtime:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/standard-times/:code` | standardtime:read | 401 | 404 | 403 | 403 |
| baseline | POST | `/baseline/fault-reports/commands` | fault:report | 401 | 400 | 403 | 403 |
| baseline | POST | `/baseline/fault-reports/:id/resolution` | fault:resolve | 401 | 400 | 403 | 403 |
| baseline | GET | `/baseline/fault-reports` | fault:read | 401 | 200 | 403 | 403 |
| baseline | GET | `/baseline/fault-reports/:id` | fault:read | 401 | 404 | 403 | 403 |
| notifications | GET | `/notifications` | notification:read | 401 | 200 | 403 | 403 |
| notifications | GET | `/notifications/unread-count` | notification:read | 401 | 200 | 403 | 403 |
| notifications | POST | `/notifications/:id/read` | notification:write | 401 | 404 | 403 | 403 |
| notifications | POST | `/notifications/read-all` | notification:write | 401 | 201 | 403 | 403 |
| notifications | POST | `/notifications` | notification:write | 401 | 400 | 403 | 403 |
| masterdata | GET | `/masterdata/items` | item:read | 401 | 200 | 403 | 403 |
| masterdata | POST | `/masterdata/items` | item:write | 401 | 400 | 403 | 403 |
| masterdata | PUT | `/masterdata/items/:id` | item:write | 401 | 404 | 403 | 403 |
| masterdata | GET | `/masterdata/resources` | resource:read | 401 | 200 | 403 | 403 |
| masterdata | POST | `/masterdata/resources` | resource:write | 401 | 400 | 403 | 403 |
| masterdata | PUT | `/masterdata/resources/:id` | resource:write | 401 | 404 | 403 | 403 |
| masterdata | GET | `/masterdata/customers` | customer:read | 401 | 200 | 403 | 403 |
| masterdata | POST | `/masterdata/customers` | customer:write | 401 | 400 | 403 | 403 |
| masterdata | PUT | `/masterdata/customers/:id` | customer:write | 401 | 404 | 403 | 403 |
| masterdata | GET | `/masterdata/suppliers` | supplier:read | 401 | 200 | 403 | 403 |
| masterdata | POST | `/masterdata/suppliers` | supplier:write | 401 | 400 | 403 | 403 |
| masterdata | PUT | `/masterdata/suppliers/:id` | supplier:write | 401 | 404 | 403 | 403 |
| masterdata | GET | `/masterdata/units` | unit:read | 401 | 200 | 403 | 403 |
| masterdata | POST | `/masterdata/units` | unit:write | 401 | 400 | 403 | 403 |
| masterdata | PUT | `/masterdata/units/:id` | unit:write | 401 | 404 | 403 | 403 |
| issue | POST | `/issue/tasks/sync` | issue:write | 401 | 400 | 403 | 403 |
| issue | POST | `/issue/tasks/cleanup` | issue:write | 401 | 400 | 403 | 403 |
| issue | GET | `/issue/tasks` | issue:read | 401 | 200 | 403 | 403 |
| issue | GET | `/issue/tasks/:id` | issue:read | 401 | 404 | 403 | 403 |
| issue | GET | `/issue/tasks/:id/lines` | issue:read | 401 | 404 | 403 | 403 |
| issue | POST | `/issue/tasks/:id/confirm` | issue:write | 401 | 400 | 403 | 403 |
| issue | GET | `/issue/tasks/:id/ship-heads` | issue:read | 401 | 200 | 403 | 403 |
| issue | GET | `/issue/records` | issue:read | 401 | 200 | 403 | 403 |
| issue | GET | `/issue/records/:id` | issue:read | 401 | 404 | 403 | 403 |
| issue | POST | `/issue/records/:id/revoke` | issue:revoke | 401 | 400 | 403 | 403 |
| listing | POST | `/listing/imports` | listing:import | 401 | 400 | 403 | 403 |
| listing | GET | `/listing/sheets` | listing:read | 401 | 400 | 403 | 403 |
| listing | GET | `/listing/sheets/:id` | listing:read | 401 | 404 | 403 | 403 |
| listing | POST | `/listing/lines/:id/update` | listing:write | 401 | 400 | 403 | 403 |
| listing | POST | `/listing/work-orders/:id/gap-checks` | gap:read | 401 | 400 | 403 | 403 |
| listing | GET | `/listing/work-orders/:id/gap-checks/latest` | gap:read | 401 | 200 | 403 | 403 |
| listing | GET | `/listing/upload-stats` | listing:read | 401 | 409 | 403 | 403 |
| listing | POST | `/purchase/requests` | purchase:request | 401 | 400 | 403 | 403 |
| listing | GET | `/purchase/requests` | purchase:read | 401 | 200 | 403 | 403 |
| listing | GET | `/purchase/requests/:id` | purchase:read | 401 | 404 | 403 | 403 |
| listing | POST | `/purchase/orders` | purchase:order | 401 | 400 | 403 | 403 |
| listing | GET | `/purchase/orders` | purchase:read | 401 | 200 | 403 | 403 |
| listing | GET | `/purchase/orders/:id` | purchase:read | 401 | 404 | 403 | 403 |
| listing | POST | `/purchase/orders/:id/approval` | purchase:approve | 401 | 400 | 403 | 403 |
| listing | POST | `/purchase/orders/:id/issue` | purchase:order | 401 | 400 | 403 | 403 |
| listing | POST | `/purchase/orders/:id/receipts` | purchase:receive | 401 | 400 | 403 | 403 |
| listing | POST | `/purchase/returns` | purchase:return | 401 | 400 | 403 | 403 |
| listing | GET | `/purchase/returns` | purchase:read | 401 | 400 | 403 | 403 |
| listing | POST | `/purchase/returns/:id/revoke` | purchase:return | 401 | 400 | 403 | 403 |
| listing | POST | `/purchase/overdue-scan` | purchase:order | 401 | 400 | 403 | 403 |
| listing | GET | `/purchase/overdue` | purchase:read | 401 | 200 | 403 | 403 |
| listing | GET | `/purchase/overdue-lines` | purchase:read | 401 | 200 | 403 | 403 |
| listing | GET | `/purchase/details/export` | purchase:read | 401 | 200 | 403 | 403 |
| listing | GET | `/purchase/details` | purchase:read | 401 | 200 | 403 | 403 |
| listing | POST | `/listing/process-materials/replace` | listing:write | 401 | 400 | 403 | 403 |
| listing | GET | `/listing/process-materials` | listing:read | 401 | 400 | 403 | 403 |
| attachment | POST | `/attachment/upload` | attachment:write | 401 | 400 | 403 | 403 |
| attachment | POST | `/attachment/save` | attachment:write | 401 | 400 | 403 | 403 |
| attachment | POST | `/attachment/save-batch` | attachment:write | 401 | 400 | 403 | 403 |
| attachment | GET | `/attachment/list-by-biz-id` | attachment:read | 401 | 400 | 403 | 403 |
| attachment | POST | `/attachment/remove` | attachment:write | 401 | 400 | 403 | 403 |
| attachment | GET | `/attachment/download-reference` | attachment:read | 401 | 400 | 403 | 403 |
| attachment | GET | `/attachment/storage/:token` | — | 404 | 404 | 404 | 404 |
| inspection | POST | `/inspection/orders` | inspection:judge | 401 | 400 | 403 | 403 |
| inspection | GET | `/inspection/orders` | inspection:read | 401 | 200 | 403 | 403 |
| inspection | GET | `/inspection/orders/:id` | inspection:read | 401 | 404 | 403 | 403 |
| inspection | POST | `/inspection/orders/:id/judgment` | inspection:judge | 401 | 400 | 403 | 403 |
| inspection | POST | `/inspection/orders/:id/recheck` | inspection:judge | 401 | 400 | 403 | 403 |
| inspection | GET | `/inspection/summary` | inspection:read | 401 | 200 | 403 | 403 |
| inspection | POST | `/inspection/overdue-scans` | inspection:judge | 401 | 400 | 403 | 403 |
| inspection | GET | `/inspection/nonconformities` | nonconform:read | 401 | 200 | 403 | 403 |
| inspection | GET | `/inspection/nonconformities/:id` | nonconform:read | 401 | 404 | 403 | 403 |
| inspection | POST | `/inspection/nonconformities/:id/disposal` | nonconform:dispose | 401 | 400 | 403 | 403 |
| inspection | POST | `/inspection/nonconformities/:id/close` | nonconform:close | 401 | 400 | 403 | 403 |
| demo | GET | `/demo/ping` | — | 200 | 200 | 200 | 200 |
| demo | GET | `/demo/data` | demo:read | 401 | 200 | 403 | 403 |
| approval-config | GET | `/approval-config/flows` | approval-config:read | 401 | 200 | 403 | 403 |
| approval-config | POST | `/approval-config/flows` | approval-config:write | 401 | 400 | 403 | 403 |
| approval-config | GET | `/approval-config/flows/:id` | approval-config:read | 401 | 404 | 403 | 403 |
| approval-config | PUT | `/approval-config/flows/:id` | approval-config:write | 401 | 404 | 403 | 403 |
| approval-config | POST | `/approval-config/flows/:id/activate` | approval-config:write | 401 | 404 | 403 | 403 |
| approval-config | POST | `/approval-config/validate` | approval-config:write | 401 | 400 | 403 | 403 |
| payroll | POST | `/payroll/rules/commands` | payroll:rule-manage | 401 | 400 | 403 | 403 |
| payroll | POST | `/payroll/runs/commands` | payroll:run | 401 | 400 | 403 | 403 |
| payroll | POST | `/payroll/exports/commands` | payroll:export | 401 | 400 | 403 | 403 |
| payroll | GET | `/payroll/rules` | payroll:read | 401 | 200 | 403 | 403 |
| payroll | GET | `/payroll/rules/detail/:ruleId` | payroll:read | 401 | 404 | 403 | 403 |
| payroll | GET | `/payroll/rules/compare` | payroll:read | 401 | 400 | 403 | 403 |
| payroll | GET | `/payroll/runs` | payroll:read | 401 | 400 | 403 | 403 |
| payroll | GET | `/payroll/runs/chain` | payroll:read | 401 | 400 | 403 | 403 |
| payroll | GET | `/payroll/runs/detail/:payRunId` | payroll:read | 401 | 404 | 403 | 403 |
| payroll | GET | `/payroll/my` | payroll:read | 401 | 200 | 403 | 403 |
| payroll | GET | `/payroll/earnings/by-source/:sourceRef` | payroll:read | 401 | 200 | 403 | 403 |
| payroll | GET | `/payroll/events` | payroll:read | 401 | 200 | 403 | 403 |
| maintenance | POST | `/maintenance/plans/commands` | maintenance:plan-write | 401 | 400 | 403 | 403 |
| maintenance | POST | `/maintenance/plans/due-scan/commands` | maintenance:task-arrange | 401 | 400 | 403 | 403 |
| maintenance | POST | `/maintenance/tasks/commands` | maintenance:task-arrange | 401 | 400 | 403 | 403 |
| maintenance | POST | `/maintenance/tasks/start/commands` | maintenance:record | 401 | 400 | 403 | 403 |
| maintenance | POST | `/maintenance/tasks/complete/commands` | maintenance:record | 401 | 400 | 403 | 403 |
| maintenance | POST | `/maintenance/tasks/cancel/commands` | maintenance:record | 401 | 400 | 403 | 403 |
| maintenance | POST | `/maintenance/records/commands` | maintenance:record | 401 | 400 | 403 | 403 |
| maintenance | GET | `/maintenance/fault-linkage` | maintenance:task-arrange | 401 | 200 | 403 | 403 |
| maintenance | POST | `/maintenance/fault-linkage/commands` | maintenance:task-arrange | 401 | 201 | 403 | 403 |
| maintenance | GET | `/maintenance/plans` | maintenance:read | 401 | 200 | 403 | 403 |
| maintenance | GET | `/maintenance/plans/:planId/versions` | maintenance:read | 401 | 404 | 403 | 403 |
| maintenance | GET | `/maintenance/tasks` | maintenance:read | 401 | 200 | 403 | 403 |
| maintenance | GET | `/maintenance/my` | maintenance:read | 401 | 200 | 403 | 403 |
| maintenance | GET | `/maintenance/tasks/:taskId` | maintenance:read | 401 | 404 | 403 | 403 |
| maintenance | GET | `/maintenance/due-calendar` | maintenance:read | 401 | 200 | 403 | 403 |
| maintenance | GET | `/maintenance/history` | maintenance:read | 401 | 200 | 403 | 403 |
| maintenance | GET | `/maintenance/events` | maintenance:read | 401 | 200 | 403 | 403 |
| drawing | POST | `/drawing/revisions/commands` | drawing:publish | 401 | 400 | 403 | 403 |
| drawing | GET | `/drawing/revisions/:drawingId` | drawing:read | 401 | 400 | 403 | 403 |
| drawing | GET | `/drawing/revisions/:drawingId/view` | drawing:read | 401 | 400 | 403 | 403 |
| drawing | GET | `/drawing/notices/:drawingId` | drawing:read | 401 | 200 | 403 | 403 |
| drawing | GET | `/drawing/work-orders/:workOrderId/drawings` | drawing:read | 401 | 400 | 403 | 403 |
| drawing | GET | `/drawing/view-audit` | drawing:audit-read | 401 | 200 | 403 | 403 |
| drawing | GET | `/drawing/events` | drawing:read | 401 | 200 | 403 | 403 |
| metric-pack | POST | `/metric-pack/activations/commands` | metric-pack:activate | 401 | 400 | 403 | 403 |
| metric-pack | POST | `/metric-pack/exports/commands` | metric-pack:read | 401 | 400 | 403 | 403 |
| metric-pack | GET | `/metric-pack/evaluate` | metric-pack:read | 401 | 400 | 403 | 403 |
| metric-pack | GET | `/metric-pack/packs` | metric-pack:read | 401 | 200 | 403 | 403 |
| metric-pack | GET | `/metric-pack/packs/versions` | metric-pack:read | 401 | 200 | 403 | 403 |
| metric-pack | GET | `/metric-pack/metrics/resolve` | metric-pack:read | 401 | 400 | 403 | 403 |
