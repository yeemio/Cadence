# MFG01 共享升级与原报告差量复测

**Owner 授权的前三步已完成，并按具名范围接收。** 截点 2026-10-29 13:48（Asia/Shanghai）。代码提交 `0425ded838a87b8aeab3cfc300097a985bde2bd2` 已推送，76路径产品聚合仍为 `26c3e0c141aad45ac7b77352ff231def9614465eef35cffb0091a180851935e5`；复测未改产品源码。之后文档收口提交不改变运行产品字节。

## 共享环境

共享 Web `http://localhost:8080`、API `http://localhost:3000`、PG `127.0.0.1:55432` 已采用该源码构建的独立镜像。三个镜像从准确Git提交导出目录构建，未混入未跟踪证据/备份。API/Web均healthy，实际页面HTML与容器内容及已接收候选一致；见[运行读回](RUNTIME-READBACK.json)、[最终检查](FINAL-RUNTIME-CHECK.json)。

升级前停止应用写入，保存旧镜像及受限访问数据库备份；5项迁移成功且校验和对应源码。原107表1051行旧字段全部保持一致，现121表强制RLS。仅执行制造岗位增量seed，未重跑基础/工厂seed，原账号角色和旧业务事实不重写。见[备份记录](BACKUP-RESULT.json)、[迁移保全](PRESERVATION-RESULT.json)。备份已检查归档目录可读，未做恢复演练。

## 差量结果

最终 **11 PASS / 6 PARTIAL / 1 OUT_OF_SCOPE / 1 UNVERIFIED**。七项P0在本轮合同口径内均通过；六项新增能力及采购收货→自动建检→QC判断→仓管释放→标准件领用/撤销已在共享环境实际完成。PASS不代表原报告所有建议都纳入。

主控核对原始HTTP、实际状态与失败；可见IAB补齐计划/运营/财务/工程/仓管、桌面和390×844移动读回，[UI结果](ui/RESULT.json)。当前标准件在手10、合格8、未知2、有效占用8、可用0。主控仅登录和读取，没有再写业务。原子并发、同人叠加等已接收隔离证据按源码/覆盖复用，未冒充本轮共享新增实测。

| ID | 最终结论 | 实际保证和保留边界 | 证据 |
| --- | --- | --- | --- |
| P0-01 | PASS | 三资源冲突逐项409，草案不占用、运营批准后源派工assigned；旧assign入口409。共享不重复双进程强锁。 | [s03-conflict-1.http](retest/s03-conflict-1.http), [s03-conflict-2.http](retest/s03-conflict-2.http), [s03-conflict-3.http](retest/s03-conflict-3.http), [s03-draft-readback.http](retest/s03-draft-readback.http), [s03-assigned.http](retest/s03-assigned.http) |
| P0-02 | PASS | E07/E08发布承诺403；运营发布/重诺保留原与前次承诺，计划日期保持原合同可填。 | [r1-18-promise-denied-mfg-e07.http](retest/r1-18-promise-denied-mfg-e07.http), [r1-18-promise-denied-mfg-e08.http](retest/r1-18-promise-denied-mfg-e08.http), [r1-20-repromise.http](retest/r1-20-repromise.http), [r1-21-plan-date-preserved.http](retest/r1-21-plan-date-preserved.http) |
| P0-03 | PASS | 生产/品质入库403，仓管判定403；仓管合法消费QC事实，职责分离。 | [b14-inbound-denied-prod01.http](retest/b14-inbound-denied-prod01.http), [b14-inbound-denied-mfg-e10.http](retest/b14-inbound-denied-mfg-e10.http), [b14-warehouse-judge-denied.http](retest/b14-warehouse-judge-denied.http), [r2-49-wh-consumes-release1.http](retest/r2-49-wh-consumes-release1.http) |
| P0-04 | PASS | 净额5万元E13复核→E02；同清单跨供方累计12.5万元→E01，E02越级403；净价未知和旧审批/未核价发出409。 | [r2-35-finance-review1.http](retest/r2-35-finance-review1.http), [r2-36-ops-approve1.http](retest/r2-36-ops-approve1.http), [r2-62-finance-review2.http](retest/r2-62-finance-review2.http), [r2-63-under-authority-denied.http](retest/r2-63-under-authority-denied.http), [r2-68-e01-approve2.http](retest/r2-68-e01-approve2.http), [r2-33-unknown-net-denied.http](retest/r2-33-unknown-net-denied.http) |
| P0-05 | PASS | 本轮两PO仓管收货自动创建standard_purchase待检，回执含inspectionId；物理先待检后释放不双增。其他合法采购来源复用既有隔离证据。 | [r2-40-physical-receipt1.http](retest/r2-40-physical-receipt1.http), [r2-71-physical-receipt2.http](retest/r2-71-physical-receipt2.http), [r2-46-pending-iq-source.http](retest/r2-46-pending-iq-source.http), [r2-49-wh-consumes-release1.http](retest/r2-49-wh-consumes-release1.http) |
| P0-06 | PASS | 待检/隔离/未知不可用，QC事实不直接增合格库存，仓管释放physicalDelta0；准确重试、超额度与消费后撤判拒绝；最终10/8/2/占用8/可用0。 | [r2-42-pending-not-issuable.http](retest/r2-42-pending-not-issuable.http), [r2-45-unknown-not-available.http](retest/r2-45-unknown-not-available.http), [r2-48-qc-fact-not-auto-stock.http](retest/r2-48-qc-fact-not-auto-stock.http), [r2-51-release-retry.http](retest/r2-51-release-retry.http), [r2-52-release-over-credit.http](retest/r2-52-release-over-credit.http), [r2-53-revoke-consumed-quality.http](retest/r2-53-revoke-consumed-quality.http), [b14-final-stock.http](retest/b14-final-stock.http) |
| P0-07 | PASS | 故障及修好后仍禁放行，单签仍409；E02/E10独立签署后放行；新故障不能沿用旧签，重新双签后开工。 | [r2-04-fault-blocks-production.http](retest/r2-04-fault-blocks-production.http), [r2-07-resolve-not-release.http](retest/r2-07-resolve-not-release.http), [r2-09-single-sign-blocked.http](retest/r2-09-single-sign-blocked.http), [r2-16b-production-release.http](retest/r2-16b-production-release.http), [r2-20-old-signature-no-bypass.http](retest/r2-20-old-signature-no-bypass.http), [r2-24-start-after-new-signatures.http](retest/r2-24-start-after-new-signatures.http) |
| P1-01 | PARTIAL | 本次实际标准件领用2、撤销恢复原批次和占用、再领用2已证；完整RES/RTN业务单据状态机范围外。 | [r2-94-confirm-standard.http](retest/r2-94-confirm-standard.http), [r2-95-after-standard-issue.http](retest/r2-95-after-standard-issue.http), [r2-96-revoke-standard.http](retest/r2-96-revoke-standard.http), [r2-97-after-standard-revoke.http](retest/r2-97-after-standard-revoke.http), [r2-98-reconfirm-standard.http](retest/r2-98-reconfirm-standard.http) |
| P1-02 | PASS | 50000元E05/E10两签；50000.01元需加E01，少签关闭拒绝；修订清空旧签、旧版409、末签准确重试。只证NC处置，不代表物理报废扣账。 | [r2-126-disposed-source-0.http](retest/r2-126-disposed-source-0.http), [r2-116-high-revision.http](retest/r2-116-high-revision.http), [r2-117-high-stale-sign.http](retest/r2-117-high-stale-sign.http), [r2-120-old-close-partial.http](retest/r2-120-old-close-partial.http), [r2-124-high-e01-sign.http](retest/r2-124-high-e01-sign.http), [r2-125-high-sign-idempotent.http](retest/r2-125-high-sign-idempotent.http) |
| P1-03 | OUT_OF_SCOPE | CLM01未纳入，不用aftercare替代。 |  |
| P1-04 | PARTIAL | 新PO原价null和独立净额保留，旧seed PO前后JSON完全相同；PO A/B业务版与应付模型范围外。 | [r2-37-approved-source1.http](retest/r2-37-approved-source1.http), [history-before-po.http](retest/history-before-po.http), [history-after-po.http](retest/history-after-po.http) |
| P1-05 | PARTIAL | 外协完成产生待检和冻结约束沿用已接收隔离证据，本次共享未新增外协样本；完整SCN09/公司独立验收/新财务模型范围外。 |  |
| P1-06 | PASS | 真实清单/图纸/工艺A绑定后仅SO02冻结B；冻结拒建和拒开工、工程不能代运营批准、解冻仍拒旧A；新B可开工，最终A/B/A。三源冻结沿用隔离证据；历史成本未验。 | [r2-169-wo-a-applicability-1.http](retest/r2-169-wo-a-applicability-1.http), [ec13-freeze.http](retest/ec13-freeze.http), [ec13-frozen-create-denied.http](retest/ec13-frozen-create-denied.http), [ec13-frozen-start-denied.http](retest/ec13-frozen-start-denied.http), [ec13-engineer-approve-denied.http](retest/ec13-engineer-approve-denied.http), [ec13-stale-a-start-denied.http](retest/ec13-stale-a-start-denied.http), [ec13-b-start.http](retest/ec13-b-start.http), [ec13-final-bindings.http](retest/ec13-final-bindings.http) |
| P2-01 | PARTIAL | 本次共享证承诺/重诺留原值；两次分批发货后曾迟交保留复用隔离证据，未在共享重放发货。 | [r1-20-repromise.http](retest/r1-20-repromise.http) |
| P2-02 | PARTIAL | 同收货源隔离→返工处置→复检→仓管释放已证；新增完整IQ/IP/FQ及工艺批准返工路线范围外。 | [r2-73-iq2-failed.http](retest/r2-73-iq2-failed.http), [r2-76-rework-disposal.http](retest/r2-76-rework-disposal.http), [r2-77-iq2-recheck.http](retest/r2-77-iq2-recheck.http), [r2-79-wh-consumes-release2.http](retest/r2-79-wh-consumes-release2.http) |
| P2-03 | PARTIAL | 库位分布与仓库过滤200，隔离禁发409；独立SCRAP/客户物权处分列、任意路由别名未新增。 | [b14-locations.http](retest/b14-locations.http), [r2-75-quarantine-no-out.http](retest/r2-75-quarantine-no-out.http) |
| P2-04 | PASS | 主控以plan01打开真实旧seed工作令详情，无无权图纸读取卡/403；按原合同隐藏入口，未增加图纸读权。 | [13-plan-workorder-visibility.txt](ui/13-plan-workorder-visibility.txt) |
| P2-05 | PASS | 仓管完整PO列表403但最小收货投影200，两次合法收货自动建检成功。 | [b14-warehouse-po-price-denied.http](retest/b14-warehouse-po-price-denied.http), [b14-warehouse-minimal-receiving.http](retest/b14-warehouse-minimal-receiving.http), [r2-40-physical-receipt1.http](retest/r2-40-physical-receipt1.http) |
| P2-06 | UNVERIFIED | 主控已读旧seed工作令项目经理仍为user-factory-plan，新制造E职责独立；原配件申请审批执行链未重放，因此本项仍UNVERIFIED，不把保留映射当作新运营审批。 | [13-plan-workorder-visibility.txt](ui/13-plan-workorder-visibility.txt) |

## 未验与原件保留

原报告指定WO、NC、IQ在本共享库复测前后均404；原seed PO前后200且完整JSON相同。原报告没有绑定提交/数据卷，不能由404推断本次升级丢数据；迁移即时保全证明旧行未删改。没有扫描其它库或重放旧单据。P2-06旧配件审批链仍未验证。

CLM01、完整RES/RTN、PO业务版/应付、SCN09、完整IQ/IP/FQ及工艺批准返工路线仍按原范围保留。分批发货曾迟交及三源冻结只复用既有隔离证明，本次共享覆盖见上表。PDF视觉与历史成本样本未补齐；M2整体售卖就绪、客户部署及真实客户接受未发生。

204份HTTP及对应请求保留于本机retest目录。两次脚本失败原件保留：样本派工已有有效排程导致合法409，随后续接文件局部变量未携带导致ReferenceError；主控批准限定续行后完成，未修改产品或重放已成功步骤。worker原报告和结果保持原时点：[报告](retest/REPORT.md)、[结果](retest/RESULT.json)；本文件/主控接收补齐其当时待验UI，不篡改原报告或失败记录。

本次Git只随附精简结果与关键UI截图；数据库/容器配置备份、凭据、完整原始HTTP、构建日志留在本机，不声称clean clone包含所有原件。保护此前output、旧失败夹具、原报告和隔离环境。本轮到此停止，不自动启动M2下一阶段或范围外实施。

当前运行配置保存在本机 `recovery/runtime-override.json`（600权限，含既有连接配置，不入Git）。后续维护须同时使用仓库deploy/compose.yaml和该覆盖文件；不直接用默认六模块配置替换当前运行实例。旧镜像分别标记 `cadence-server:pre-mfg01-20261029` / `cadence-web:pre-mfg01-20261029`，数据库恢复源取BACKUP-RESULT；本次未执行回退。
