# 机加域术语表（zh → en）

i18n 波 2 随批产出（proposal R4：专业术语表随波 2 产出）。用途：五个高频模块 namespace（workorder/dispatch/inspection/inventory/reporting）与 menu/common 的英文骨架共用同一术语；后续新目标语言（M3 客户点向后）翻译时以本表为锚，不造同义异形。事实源=本表+各 namespace json 现值；两处不一致时**以本表为准修正 json**。

## 单据与主数据

| 中文 | 英文 | 用于 |
| --- | --- | --- |
| 工作令 | work order | workorder/menu |
| 项目名 | project name | workorder |
| 客户引用 | customer reference | workorder |
| 项目经理 | project manager | workorder |
| 销售 | sales rep | workorder |
| 计划交付（日期） | planned delivery (date) | workorder |
| 派工单 | dispatch order | dispatch/reporting |
| 装配 | assembly | dispatch |
| 外协 | outsourcing | dispatch/inspection |
| 报工（单） | work report | reporting |
| 工序 | operation | dispatch/reporting |
| 图号 | drawing number | reporting/dispatch |
| 质检单 | inspection order | inspection |
| 配件申请 | parts request | workorder |
| 审批 | approval | workorder/menu |
| 报表 | report | reporting/menu |

## 清单与齐套

| 中文 | 英文 | 用于 |
| --- | --- | --- |
| 清单 | listing(s) | menu/workorder（菜单名=Listings） |
| 零件清单 | parts list | workorder/listing |
| 标准件清单 | standard parts list | 同上 |
| 电气件清单 | electrical parts list | 同上 |
| 设备采购清单 | equipment procurement list | 同上 |
| 缺口核查 | gap check(s) | menu/workorder（菜单名=Gap Checks） |
| 齐套 | kit readiness | workorder |

## 质检域

| 中文 | 英文 | 用于 |
| --- | --- | --- |
| 判定 | judgment | inspection |
| 复检 | recheck | inspection |
| 特采（让步接收） | concession | inspection |
| 判定撤销 | judgment revocation | inspection |
| 不合格处置 | nonconformity disposal | inspection |
| 返工 | rework | inspection |
| 报废 | scrap | inspection |
| 闭环 | close | inspection |
| 待检 | pending | inspection |
| 合格 | passed | inspection/reporting |
| 不合格 | failed | inspection |
| 处置 | disposal | inspection |

## 库存域

| 中文 | 英文 | 用于 |
| --- | --- | --- |
| 库存 | inventory | inventory/menu |
| 仓库 | warehouse | inventory |
| 库位 | location | inventory |
| 入库 | stock-in | inventory |
| 出库 | stock-out | inventory |
| 调拨 | transfer | inventory |
| 可用量 | available qty | inventory |
| 流水号 | transaction number | inventory |

## 报工域

| 中文 | 英文 | 用于 |
| --- | --- | --- |
| 核查 | verify / verification | reporting |
| 撤销冲销 | revoke（write-off） | reporting |
| 修正版 | corrected version | reporting |
| 完工/产出数量 | done qty / output qty | reporting |
| 工时（分钟） | labor minutes | reporting/dispatch |
| 申报人 | reporter | reporting |
| 趋势 | trend | reporting |
| 验证 | verify | reporting |

## 通用

| 中文 | 英文 | 用于 |
| --- | --- | --- |
| 状态 | state | 各域（值标签） |
| 类别 | kind | 各域 |
| 版本 | version | 各域 |
| 创建时刻 | created at | 各域 |
| 流转（记录） | state transition (log) | 各域 |
| 列显隐 | column visibility | 各域 |
| 空态 | empty | 各域 |
