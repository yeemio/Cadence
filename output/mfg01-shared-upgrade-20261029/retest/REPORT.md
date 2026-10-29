# 共享环境原报告19项差量复测

**共享API的六项新增能力和采购→自动建检→判定→仓管释放→标准件领用/撤销闭环已完成；待主控接收。** 原报告19项失败/免测不改写，本表是准确候选的另份差量结果。

事件 `shared-delta-0425ded-v1`；执行者 `/root/shared_delta_retest`；提交 `0425ded838a87b8aeab3cfc300097a985bde2bd2`；候选 `26c3e0c141aad45ac7b77352ff231def9614465eef35cffb0091a180851935e5`（76路径）。API3000/Web8080，default租户；主控SHARED_READY后唯一业务writer，本执行者无产品、部署、迁移或账号权限写入。

| ID | 结论 | 实际保证和保留边界 | 共享证据 |
| --- | --- | --- | --- |
| P0-01 | PASS | 三资源冲突逐项409，草案不占用、运营批准后源派工assigned；旧assign入口409。共享不重复双进程强锁。 | [s03-conflict-1.http](s03-conflict-1.http), [s03-conflict-2.http](s03-conflict-2.http), [s03-conflict-3.http](s03-conflict-3.http), [s03-draft-readback.http](s03-draft-readback.http), [s03-assigned.http](s03-assigned.http) |
| P0-02 | PASS | E07/E08发布承诺403；运营发布/重诺保留原与前次承诺，计划日期保持原合同可填。 | [r1-18-promise-denied-mfg-e07.http](r1-18-promise-denied-mfg-e07.http), [r1-18-promise-denied-mfg-e08.http](r1-18-promise-denied-mfg-e08.http), [r1-20-repromise.http](r1-20-repromise.http), [r1-21-plan-date-preserved.http](r1-21-plan-date-preserved.http) |
| P0-03 | PASS | 生产/品质入库403，仓管判定403；仓管合法消费QC事实，职责分离。 | [b14-inbound-denied-prod01.http](b14-inbound-denied-prod01.http), [b14-inbound-denied-mfg-e10.http](b14-inbound-denied-mfg-e10.http), [b14-warehouse-judge-denied.http](b14-warehouse-judge-denied.http), [r2-49-wh-consumes-release1.http](r2-49-wh-consumes-release1.http) |
| P0-04 | PASS | 净额5万元E13复核→E02；同清单跨供方累计12.5万元→E01，E02越级403；净价未知和旧审批/未核价发出409。 | [r2-35-finance-review1.http](r2-35-finance-review1.http), [r2-36-ops-approve1.http](r2-36-ops-approve1.http), [r2-62-finance-review2.http](r2-62-finance-review2.http), [r2-63-under-authority-denied.http](r2-63-under-authority-denied.http), [r2-68-e01-approve2.http](r2-68-e01-approve2.http), [r2-33-unknown-net-denied.http](r2-33-unknown-net-denied.http) |
| P0-05 | PASS | 本轮两PO仓管收货自动创建standard_purchase待检，回执含inspectionId；物理先待检后释放不双增。其他合法采购来源复用既有隔离证据。 | [r2-40-physical-receipt1.http](r2-40-physical-receipt1.http), [r2-71-physical-receipt2.http](r2-71-physical-receipt2.http), [r2-46-pending-iq-source.http](r2-46-pending-iq-source.http), [r2-49-wh-consumes-release1.http](r2-49-wh-consumes-release1.http) |
| P0-06 | PASS | 待检/隔离/未知不可用，QC事实不直接增合格库存，仓管释放physicalDelta0；准确重试、超额度与消费后撤判拒绝；最终10/8/2/占用8/可用0。 | [r2-42-pending-not-issuable.http](r2-42-pending-not-issuable.http), [r2-45-unknown-not-available.http](r2-45-unknown-not-available.http), [r2-48-qc-fact-not-auto-stock.http](r2-48-qc-fact-not-auto-stock.http), [r2-51-release-retry.http](r2-51-release-retry.http), [r2-52-release-over-credit.http](r2-52-release-over-credit.http), [r2-53-revoke-consumed-quality.http](r2-53-revoke-consumed-quality.http), [b14-final-stock.http](b14-final-stock.http) |
| P0-07 | PASS | 故障及修好后仍禁放行，单签仍409；E02/E10独立签署后放行；新故障不能沿用旧签，重新双签后开工。 | [r2-04-fault-blocks-production.http](r2-04-fault-blocks-production.http), [r2-07-resolve-not-release.http](r2-07-resolve-not-release.http), [r2-09-single-sign-blocked.http](r2-09-single-sign-blocked.http), [r2-16b-production-release.http](r2-16b-production-release.http), [r2-20-old-signature-no-bypass.http](r2-20-old-signature-no-bypass.http), [r2-24-start-after-new-signatures.http](r2-24-start-after-new-signatures.http) |
| P1-01 | PARTIAL | 本次实际标准件领用2、撤销恢复原批次和占用、再领用2已证；完整RES/RTN业务单据状态机范围外。 | [r2-94-confirm-standard.http](r2-94-confirm-standard.http), [r2-95-after-standard-issue.http](r2-95-after-standard-issue.http), [r2-96-revoke-standard.http](r2-96-revoke-standard.http), [r2-97-after-standard-revoke.http](r2-97-after-standard-revoke.http), [r2-98-reconfirm-standard.http](r2-98-reconfirm-standard.http) |
| P1-02 | PASS | 50000元E05/E10两签；50000.01元需加E01，少签关闭拒绝；修订清空旧签、旧版409、末签准确重试。只证NC处置，不代表物理报废扣账。 | [r2-126-disposed-source-0.http](r2-126-disposed-source-0.http), [r2-116-high-revision.http](r2-116-high-revision.http), [r2-117-high-stale-sign.http](r2-117-high-stale-sign.http), [r2-120-old-close-partial.http](r2-120-old-close-partial.http), [r2-124-high-e01-sign.http](r2-124-high-e01-sign.http), [r2-125-high-sign-idempotent.http](r2-125-high-sign-idempotent.http) |
| P1-03 | OUT_OF_SCOPE | CLM01未纳入，不用aftercare替代。 |  |
| P1-04 | PARTIAL | 新PO原价null和独立净额保留，旧seed PO前后JSON完全相同；PO A/B业务版与应付模型范围外。 | [r2-37-approved-source1.http](r2-37-approved-source1.http), [history-before-po.http](history-before-po.http), [history-after-po.http](history-after-po.http) |
| P1-05 | PARTIAL | 外协完成产生待检和冻结约束沿用已接收隔离证据，本次共享未新增外协样本；完整SCN09/公司独立验收/新财务模型范围外。 |  |
| P1-06 | PASS | 真实清单/图纸/工艺A绑定后仅SO02冻结B；冻结拒建和拒开工、工程不能代运营批准、解冻仍拒旧A；新B可开工，最终A/B/A。三源冻结沿用隔离证据；历史成本未验。 | [r2-169-wo-a-applicability-1.http](r2-169-wo-a-applicability-1.http), [ec13-freeze.http](ec13-freeze.http), [ec13-frozen-create-denied.http](ec13-frozen-create-denied.http), [ec13-frozen-start-denied.http](ec13-frozen-start-denied.http), [ec13-engineer-approve-denied.http](ec13-engineer-approve-denied.http), [ec13-stale-a-start-denied.http](ec13-stale-a-start-denied.http), [ec13-b-start.http](ec13-b-start.http), [ec13-final-bindings.http](ec13-final-bindings.http) |
| P2-01 | PARTIAL | 本次共享证承诺/重诺留原值；两次分批发货后曾迟交保留复用隔离证据，未在共享重放发货。 | [r1-20-repromise.http](r1-20-repromise.http) |
| P2-02 | PARTIAL | 同收货源隔离→返工处置→复检→仓管释放已证；新增完整IQ/IP/FQ及工艺批准返工路线范围外。 | [r2-73-iq2-failed.http](r2-73-iq2-failed.http), [r2-76-rework-disposal.http](r2-76-rework-disposal.http), [r2-77-iq2-recheck.http](r2-77-iq2-recheck.http), [r2-79-wh-consumes-release2.http](r2-79-wh-consumes-release2.http) |
| P2-03 | PARTIAL | 库位分布与仓库过滤200，隔离禁发409；独立SCRAP/客户物权处分列、任意路由别名未新增。 | [b14-locations.http](b14-locations.http), [r2-75-quarantine-no-out.http](r2-75-quarantine-no-out.http) |
| P2-04 | UNVERIFIED | 计划员无权图纸卡隐藏属于主控UI读回，本执行者不操作浏览器，不扩大图纸权限。 |  |
| P2-05 | PASS | 仓管完整PO列表403但最小收货投影200，两次合法收货自动建检成功。 | [b14-warehouse-po-price-denied.http](b14-warehouse-po-price-denied.http), [b14-warehouse-minimal-receiving.http](b14-warehouse-minimal-receiving.http), [r2-40-physical-receipt1.http](r2-40-physical-receipt1.http) |
| P2-06 | UNVERIFIED | 本次不改旧项目经理审批映射或账号权限；新制造链真实E角色已证，原配件审批样本/旧审批流未重放。 |  |

计数 `{'PASS': 10, 'PARTIAL': 6, 'OUT_OF_SCOPE': 1, 'UNVERIFIED': 2}`。PASS仅对本轮接收合同内具名增量成立，不等于原报告全19项完成、M2、真实客户或完整模型验收。

## 实际单据与库存

[UI-SAMPLES.json](UI-SAMPLES.json)给出固定单据和源声明入口。以该文件为准；STATE.json早期ui字段含准备时猜测的路径，不作为有效UI链接。

工作令：`wo-01a1862a-ce7a-7cd8-81cf-3f2b042692c1`, `wo-01a1862a-ce8a-76d3-8451-b2a86ea1f23f`, `wo-01a1862a-ce98-7b5b-81a8-67368cecb368`（A/B/A）。

PO：`po-01a1862a-f15a-7f22-b321-1f63b64166a8`, `po-01a1862b-1873-7b2f-ac05-1aea370852be`；IQ：`insp-01a1862b-1613-7652-9306-657cdd7a1f69`, `insp-01a1862b-1aa9-7d2d-8170-e5e5399b35ee`。

领用撤销原记录 `irc-01a1862b-1eee-772f-9937-285ba89aab8b`，再领用有效记录 `irc-01a1862b-1f25-7b75-a055-209493073c62`。库存最终在手10、合格8、未知2、待检0、隔离0、有效占用8、可用0。

低额/高额报废NC：`nc-01a1862c-b686-7c07-a3a5-d9e9726a34fb`, `nc-01a1862c-b820-745a-966f-26321ea85e8d`；复机 `mfg-030302a2-bef3-4158-8213-f8b1b19e7441`；EC `mfg-a7d08081-6952-4884-a406-abf745dc8870`。

## 原报告历史只读结果

| 对象 | GET路径 | 前/后 | 结论 |
| --- | --- | --- | --- |
| wo | `/workorder/work-orders/wo-01a181f2-3c2b-7cbd-a86d-d1d2c3001dc0` | 404/404 | UNVERIFIED_404；JSON相同=True |
| po | `/purchase/orders/po-seed-factory-01` | 200/200 | UNCHANGED；JSON相同=True |
| nc | `/inspection/nonconformities/nc-01a17d8b-e091-7783-82ed-c007b5c81061` | 404/404 | UNVERIFIED_404；JSON相同=True |
| iq | `/inspection/orders/insp-01a181f9-834f-73c2-96c2-81ca6e991c6b` | 404/404 | UNVERIFIED_404；JSON相同=True |

WO/NC/IQ的404只记未验证，不推断本次升级丢失。主控的升级即时107旧表1051行保全证据在[迁移保全结果](../PRESERVATION-RESULT.json)，可证明本次迁移未删旧行；原报告未绑定提交/数据卷，不能据此判断404原因。未扫库找旧对象、未恢复旧备份。

## 失败、复用与停止边界

首次复机末步因同一合成派工已有有效排程正确409（[原HTTP](r2-16-production-release.http)）；只取消本轮旧排程。10b因局部planned变量ReferenceError在下个HTTP前失败；原失败文件保留。两次harness错误后已停止并取得主控有界续行决定，10c按持久state.productionDraft续接，后续11–14成功；未重跑01–09、未重签旧故障、未改产品。

7阶段曾沿用旧console摘要的“角色叠加自审拒绝”两字段并非本次共享实测，已在脚本摘要改正，本表仅以原HTTP为证。共享未改变用户角色；同人叠加、双进程排程/同需求、事务故障、受限角色RLS、三真实源冻结、分批曾迟交引用[原主控接收](../../mfg01-capabilities-20261028/PARENT-ACCEPTANCE.md)与其原件，不写成本次共享结果。

脚本静态语法检查通过；每成功阶段前后76路径hash和提交固定。完整HTTP与请求逐份保留，登录响应/凭据未落盘。当前业务数据已冻结供主控只读UI，达到本worker停止条件。没有新增修复流水线或声称总体接收。
