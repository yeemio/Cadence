# Cadence SaaS 复测 + 补测报告（R 波修复）

- **代码**：main `0b7cd352419c541b611d3f8379c9c590256961ca`（2026-10-26 15:24 UTC+8）；套件首跑于 `541ffffacebad9974ca7bdf0ee7e3bb5c320ee8f`。0b7cd35 相对 541ffff **只改了文档**（TESTING-GUIDE.md、architecture/status.md），`--build` 后镜像无变化，所以 541ffff 上的运行结果对 0b7cd35 同样有效。D-3、D-1 在 0b7cd35 栈上补做（见下）。
- **环境**：box（Linux）、Docker compose `--profile saas --build`，27 个模块全开，`SMES_TENANT_MODE=saas SMES_DOMAIN=smes.example.com SMES_TENANTS=default,tenant-a,tenant-b`，`SMES_RLS_SESSION=on`；proxy :80 / server :3000 / web :8080 / pg 127.0.0.1:55432。三租户 admin 夹具都在（不用 SQL 补建），口令 demo-password。Node 24.22.1，pnpm 11.28.5。
- **纪律**：没改代码，没推送；按 TESTING-GUIDE §5 的设计内行为判定（201+`status:"rejected"` 按信封语义算通过）。
- 复现脚本：`scripts/`（`lib.py` 是公共函数；`retest.py` `d2d4.py` `d1.py` `persona.py` `matrix.py` `crawl.mjs`）；原始结果：`raw/`；日志：`logs/`；541ffff 首跑快照：`run-541ffff/`；截图：`shots/`（127 张，按模块分目录）。

## 1. 关键数字
| 套件 | 本轮 | 上轮（c80319f） |
|---|---|---|
| 复测/补测 API 用例（retest-chain + D-2/D-4） | **85 条：80 通过 / 3 失败 / 2 观察** | API 93/115，另有 8 BLOCKED、7 N/A |
| 角色场景 + 跨角色（persona） | 48/49（唯一失败 PX-03 是本轮测试数据干扰，不是回归） | 48/49 |
| 权限矩阵 | 268 条路由，**0 个真缺陷**（4 条是设计内公开端点） | 268 条，1 个真缺陷（material-validations 500） |
| UI 页面爬取（4 个账号 × 桌面/移动，6 个 worker 并发） | 125/127（2 条是爬虫局限：移动端 /scan 没有入口链接） | 127/127 |
| event/outbox 孤儿行（本轮新产生） | **0**（本轮新写 117 条事件，全部有 outbox） | 有孤儿（D-8） |

## 2. 缺陷逐项判定
| 缺陷 | 判定 | 证据 / 命令 |
|---|---|---|
| D-8 P0 四类写命令 500 | ✅ 已修复 | WO-01/02、PU-01、RP-01/RP-06、DP-05/DP-06 都返回 201 committed。孤儿检查 `select count(*) from event_records e where occurred_at>'2026-10-26T07:18:34Z' and not exists(select 1 from outbox_records o where o.event_id=e.event_id)` 结果为 0（`logs/orphan-check.txt`）；历史遗留 23 条是上一轮产生的 |
| D-1 P0 重启后只认第一个租户 | ✅ 已修复 | 541ffff 上重启 3 次（顺序 B→A→default、default→A→B、A→B→default）；**最后单独在 0b7cd35 上**再重启 2 次，顺序相反（B→A→default、default→A→B）。三租户 admin 调 `/org/users /org/roles /masterdata/items /audit/logs` 全部 200（`logs/d1-*.txt`，`python3 scripts/d1.py tenant-b,tenant-a,default`） |
| D-9 报工超量 | ✅ 已修复 | 派工 10、已报 6，再报 5 → 201 + rejected「累计有效报工 6+本次 5 超过派工数量 10」；报 4 刚好等于 10 → committed；满额后再报 1 → rejected（RP-02/02b/02c） |
| D-11 不存在的审批人 | ✅ 已修复 | `POST /approval/cases` approvers=['user-does-not-exist'] → 400「审批人…不存在或不可用」 |
| D-7 非 UUID id 返回 500 | ✅ 已修复 | `/baseline/material-validations/abc`、`/workorder/work-orders/not-a-uuid`、质检/报工/派工/采购/审批 `/abc` 全部 404；权限矩阵里不再有 500 |
| D-2 新用户没有口令 | ✅ 已修复 | 完整场景 15 条都按预期：带口令建号 201 → 登录 201 → 不带口令的账号登录 401 → viewer 重置 403 → admin 重置 200 → 旧口令 401、新口令 201 → **重置前签发的会话 401（全端撤销）** → B 租户 admin 重置 A 用户 404 → A token 打 B 子域 401 → A 用户在 B 登录 401 → 不存在的用户 404。观察：口令只校验 1~N 字符，没有强度策略（`short` 也能设），建议 P3 |
| D-12 approver/viewer 首页 403 | ⚠️ 部分修复 | 桌面端：approver、viewer 首页都不再发无权限请求（0 个 403）。**移动端 `/m`（viewer）仍然请求 `GET /workbench/todos` → 403**，控制台报错（`shots/m-/viewer-mobile-_m.png`，`raw/crawl.json`） |
| D-6 viewer 卡片一直“正在加载…” | ⚠️ 部分修复 | 桌面首页显示「当前身份无工作台读取权限（workbench:read），不发起数据请求」✅；移动端 `/m` 的“我的待办”仍然停在「正在加载…」 |
| D-13 成本页 UTC 时间 | ✅ 已修复 | 发布时刻显示为 `2026-10-26 15:20:03`（本地时间），上轮是 `2026-10-26T03:49:26.749Z`（`shots/costing/admin-desktop-_costing.png`） |
| D-4 签名 URL 不绑定租户 | ✅ 已修复 | `download-reference` 返回的 `url` 负载中带 tenantId；在 tenant-a 取回原文 200，在 tenant-b/default 都是 404（`raw/d4.json`） |
| D-5 未知租户口径 | ✅ 已对齐（按文档） | proxy:80 和直连 :3000 一致：域内未知 `rogue.smes.example.com` → 404「unknown tenant」；域外、多级子域、裸 IP → 421（`logs/d5.txt`），与 deploy/README「域内未知 404、域外/多级 421」一致 |
| D-3 附件重启后丢失 | ✅ 已修复（0b7cd35） | 上传 → PG `attachment_objects` 有行（tenant-a，16 字节）→ `docker restart cadence-server-1` → 用正确 bizId 重新取 `url` → 下载返回原文 `D3-persist-check`，200（`logs/d3-*.txt`）。观察：**重启前签发的旧 url 在重启后变成 404**（签名密钥疑似随进程重生），P3 |
| B-1 干净克隆 verify | ✅ 通过 | 541ffff 干净克隆 `pnpm install && pnpm verify` 退出码 0（另一 worker 的结果见 `B1-B2.md`；我本机 /tmp/clean 也复现了 exit 0）；0b7cd35 没有代码变动 |
| B-2 文档计数 | ⚠️ 部分修复 | 0b7cd35 文档：application 577 / business-store 186 / web 143+14 / product-ui 130 / testkit 77 都和实际一致；**server 仍写 65，实际 70**。注释“= typecheck + build”的顺序也没和实际脚本（build 在前）同步。详见 `B1-B2.md` |
| D-3 以外的未修项：桌面深链刷新 | 不判（待 Owner） | 直接整页打开 `/costing` 等桌面路由仍返回 `Cannot GET`；按约定不算缺陷，所以 UI 爬取改成应用内导航 |

## 3. 上轮 BLOCKED（8 条）/ N/A（7 条）补测结果
| 用例 | 结果 |
|---|---|
| WO-07 按 id 查工作令 | ✅ 200 |
| WO-09 旧版本号重复挂附件 | 观察：两次 attach 都 committed，newRevision 都是 1，说明 attach 不推进 objectVersion，乐观锁不适用。请 Owner 确认是否设计如此 |
| LS-01 清单导入（骨架 + Excel 行） | ✅ committed |
| LS-03 按工作令查四类清单 | ✅ 200，含 part |
| CS-03 成本重建 | ✅ committed，laborMinor=6000（1h×6000）；对不存在的工作令重建 → rejected ✅ |
| IN-01 按 id 查质检单 | ✅ 200（末道报工自动建出的自制质检单） |
| IN-02 判定数量超过送检数 | ✅ 201+rejected「判定数量 10 超过送检数量 6」 |
| RP-04 旧版本重复核查 | ✅ 201+rejected 乐观锁冲突；核查后工时入账 entryCount=1 ✅ |
| RP-01 报工（复跑） | ✅ committed |
| MT-04 / MT-05 维修任务开始 / 完成 | ✅ committed（MT-02 到期扫描上轮是 indeterminate，本轮 committed） |
| DW-03 带 clearance 查图纸修订 | ✅ 200 |
| DP-09 外协明细带 supplierRef | ✅ 200 |
| NT-01 通知（source 小写） | ✅ 201 |
| IV-01 建仓 warehouse.define.v1 | ✅ committed |
| WB-04 | 保持上轮结论：设计内（待办只对本人可见） |

**新行为验证**：未定义的工序报工 → 201+rejected「工序…不在 baseline 工序库中」✅；先建工序 + 工艺路线后报工链全通 ✅。末道报工 → 自制质检单 ✅（IN-06）；外协 assign→start→complete → 回厂质检单 ✅（IN-08）；assigned 态直接 complete → rejected ✅（DP-08）。**采购收货 → 采购质检单 ❌**（见 D-15）。

## 4. 新缺陷
### D-14（P1）库存入库在 SaaS / RLS=on 下返回 500
- 复现：`POST /inventory/stock/receipts`，信封 `stock.receive.v1`，kind=production，带上已存在的 warehouseId（tenant-a，`scripts/retest.py` 用例 IV-05）→ HTTP 500。
- 日志：`PrismaClientKnownRequestError … 42501 new row violates row-level security policy for table "stock_accounts"`，出错位置 `PgStockAccountStore.adjust`（`packages/business-store/src/inventory/pg-inventory-stores.ts:549`）。
- 原因：inventory 有 3 处用客户端级 `this.prisma.$executeRaw` 做 upsert（549、610、772 行）。`rls-session.ts` 第 172–176 行自己写明了这个边界：raw 入口不经过租户钩子，不会 SET `app.current_tenant`，所以在 app_user 下写入被 RLS 拒绝。实际影响：SaaS 部署下所有改动库存余额的命令（入库、发料、调拨等）都走不通。上一轮 IV-01 是 N/A，没有走到这一步，所以这次才暴露。
### D-15（P1）采购收货确认在部署态总是被拒，采购质检链路不通
- 复现：采购申请 → 下单 → approve → issue → `POST /purchase/orders/:id/receipts` `purchase.order.receive.v1 {lines:[{lineNo:1,receivedQty:8}]}` → 201+rejected「入库指令被拒绝（行 1）：未指定收货仓且未配置默认仓（服务选项 defaultWarehouseId）」。`standard_purchase` 质检单不会生成（PU-10、IN-07）。
- 原因：收货载荷（`listing-input.ts:374` `PurchaseOrderReceivePayload`）没有仓库字段，`InventoryService.receivePurchaseStock` 只能退回到 `options.defaultWarehouseId`，而 server 组合根和 compose 都没有配置这个值。即使配置了，也会撞上 D-14。对应修复说明里“采购收货确认→采购质检单”这一路。
### 观察（P3，不计入失败）
- D-3 附属：重启前签发的下载 url 在重启后失效（404）。
- D-2 附属：口令没有强度策略。
- 成本页“版本”列显示「—」（上轮也是这样）。
- WO-09：attach 不推进 objectVersion。

## 5. 回归汇总
- persona 48/49：PX-03（审批完成后审批人待办清空）失败，是因为本轮 AP-01 用例刚好给同一位审批人派了一张待审批，不是回归。
- 权限矩阵：noauth→401、viewer→403、admin/approver 无 5xx，全部满足；例外 4 条是公开端点（login 400、/auth/me、storage token 404、/demo/ping）。上轮那条真缺陷（material-validations 500）已消失。
- UI：127 个页面里 125 个正常、没有 5xx；移动端 viewer 仍有 1 个 403（D-12 残留）。
