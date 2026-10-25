# API 性能基线（2026-10-26 本地 / 2026-10-25T18:28:28.125Z UTC）

产出：deploy/scripts/perf-baseline.mjs 一次性栈实跑（docker postgres:16 + server dist）。

## 基线表（100 次串行请求/端点，5 次预热不计）

| 端点 | n | p50 (ms) | p95 (ms) | p99 (ms) | min | max | 非2xx |
|---|---|---|---|---|---|---|---|
| GET /health | 100 | 1.6 | 1.8 | 2.0 | 0.3 | 2.2 | 0 |
| GET /workbench/summary | 100 | 2.4 | 2.7 | 3.0 | 1.0 | 3.0 | 0 |
| GET /workorder/work-orders | 100 | 2.8 | 3.2 | 3.4 | 1.4 | 4.6 | 0 |
| POST /standard-reports/query | 100 | 2.9 | 3.4 | 3.7 | 1.4 | 4.1 | 0 |
| GET /masterdata/items | 100 | 2.2 | 3.2 | 14.7 | 0.8 | 26.8 | 0 |

## 环境与方法说明

- 栈：docker postgres:16（一次性容器，随机端口）+ apps/server/dist/main.js（Node v24.18.0，本机 darwin arm64）。
- MODULES_ENABLED=core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,org,masterdata,workbench,approval,demo,standardreports（16 码——历史口径"15 模块栈"T1 后补登 standardreports 为 16）。
- 鉴权：真实登录 POST /auth/login（种子演示管理员；单次登录时延 54.3ms，未计入端点序列；计量请求走 Bearer token）。
- 数据形态：迁移+组织种子后的**近空库**（组织/用户/角色，无业务行）——数字反映框架+查询机器的冷数据开销，不代表生产数据量；灌数环境重跑须重立基线。
- 方法：每端点 5 次预热（不计）+ 100 次串行请求；计时 = fetch 发起至响应体完整读回的往返墙钟；连接复用走 Node fetch(undici) 缺省 keep-alive；同机回环网络（无真实网络抖动）。
- 构建形态：build / build / build（reuse-dist = 沿用既有 dist，见脚本文件头容忍策略）。

## 判定声明（无阈值）

**本基线不含达标判定**：决策簿 p95 目标未定，本表只为后续验收立锚（对照口径 = 同脚本同环境重跑的 p50/p95/p99 变化）。任何"达标/不达标"结论须等 Owner 定阈值后另行出具。
