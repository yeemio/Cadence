# @smes/engine-reporting

口径驱动报表引擎（自研薄层，决策簿 ~25 人日）——**口径定义即数据**：可版本化、
可整体序列化、口径包 = 商业资产（可售卖单元）。**不做通用 BI**。纯域：无框架、
无存储 IO、无时钟（求值是纯函数）。

## 分层

| 模块 | 职责 |
| --- | --- |
| `filter.ts` | 过滤谓词（纯数据可序列化：比较 / 在集合内 / 区间 / 与或非组合）+ 求值纯函数 + dot-path 字段读取 |
| `definition.ts` | 口径定义 `MetricDefinition`（metricId + version + 时间口径 + 维度 + 度量 + 根过滤），`defineMetricDefinition` 校验即深冻结 |
| `pack.ts` | 口径包 `MetricPack`（packId + 包版本 + 口径清单 + 元数据——"可售卖单元"的载体）；包内 metricId 唯一；`findMetric` 按引用取口径 |
| `source.ts` | 数据源端口 `MetricSource`（按源种类 + 时间口径 + 时间窗 + 过滤取行）+ 单源内存实现（确定性，测试/演示用） |
| `evaluate.ts` | 计算端口：`MetricQuery`（口径引用 + 维度切片 + 时间窗 + 过滤 + 口径覆盖）→ `MetricResult`（行列 + 口径溯源）；`evaluateMetric` 纯函数求值；`buildSourceRequest` 组装下推请求 |

## 关键取舍

- **口径定义 = 版本化数据**：`defineMetricDefinition` 校验冻结纯数据；引擎不含任何
  硬编码口径。同一 metricId+version 构造两次产出冻结等价结果（幂等、无随机、无时钟）；
  口径演进 = 版本号 +1，历史口径不动（口径包只读旧版即可复算旧报表）。
- **时间口径三态**对齐证据标准三时间列（`architecture/contracts/evidence-columns.v1.md`
  / business-core `EvidenceColumns`）：`business` → business_time、`available` →
  available_time、`occurred` → occurredAt。两证据时间列可空（补录/入账时补），
  **缺省回落 occurredAt**——保证任一口径下每行都有时间锚。定义声明缺省口径
  （版本化口径的一部分）；查询可显式覆盖（对账场景：同一口径 business vs available
  比对），结果回显实际生效口径。
- **维度过滤 = 值域声明**：`DimensionDef.filter` 不过滤的贡献行被**整行剔除**
  （等价于与根过滤 AND，但跟随维度 authored——"这个维度只关心这些值"）。
- **正确性归属引擎，下推只是优化**：`MetricSource.read` 可按请求下推（时间窗 +
  过滤），`evaluateMetric` 对取回行**重复施加同一谓词**（同一套纯函数），下推与否
  结果一致（重复过滤幂等，全流程测试断言两种路径 JSON 等价）。
- **聚合语义全集**：sum / count / avg / min / max / distinct-count。count 数行数
  （不允许带 field）；sum/avg/min/max 跳过 null 值、遇非数值 fail-fast；
  空集：sum/count/distinct-count → 0，avg/min/max → null；无维度口径恒一行总量。
- **存储端口为异步形状**（与 engine-flow 同取舍）：PG/事件表实现天然异步，端口按
  Promise 定形，business-store 落地时不改调用方；内存实现即时 resolve。
- **deepFreeze / 正则按"零件各造"镜像** business-core internal 实现（ADR-0003）。

## ADR-0010 自证（领域内核通用性纪律）

- 全部词汇为跨行业通用词：**metric / dimension / measure / filter / aggregate /
  pack**——无任何行业专属概念进入本包。
- **不做通用 BI**：无自由 SQL / 无查询语言 / 无表达式求值 / 无图表与布局定义——
  只有口径（定义 + 求值）。行业差异 = 另一份口径包（预置口径集），引擎零改动，
  与"行业包 = 配置集 + 模块集"（ADR-0010 时序纪律）同构。
- 度量的 `format` 是纯展示提示（单位/小数位），不是图表定义。

## 非目标（M3 正式实施范围）

- server/NestJS 注册（组合根装配、应用注册表挂载）、报表 UI（ECharts 呈现层）
- PG 适配器（business-store 实现 `MetricSource`，本包只留端口接缝）
- 口径包的市场 / 授权 / 分发机制（"可售卖"只是形状定位：可序列化 + 版本化 + 自包含）
- 钻取（下钻到来源单据）、同环比、物化与缓存
