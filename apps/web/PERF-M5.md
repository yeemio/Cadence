# M5 性能验收报告（p50/p95）

测量日：2026-10-25 深夜（M5 收尾波）。测量者：code-writer-pro（GLM-5.3）。
脚本：`apps/web/scripts/perf-m5.mjs`（node 真实 fetch 计时，零新增依赖；
Playwright 不在 devDeps，按派发指示走 node fetch 通道）。

## 0. 结论

- **移动四页组合冷加载（文档 + 关键资产串行取完）p95 = 20.6 ms**，关键资产
  单项 p95 ≤ 18.9 ms；**核心 API 读端点 p95 全部 ≤ 2.0 ms**（零 DB 内存形态）；
  **零 DB 起服到 /health 首次 200 = 429 ms**。
- 规格源（交接文档 §9 M5 行）只写了"性能验收"，**无数值化 p95 阈值**（已
  grep 核实）。本报告以下方"自设基线"作验收口径：回环组合加载 p95 < 100 ms、
  API p95 < 50 ms、起服 < 5 s——实测全部 5~25 倍余量通过。

## 1. 数字表

### 1.1 移动四页·文档与组合加载（vite preview × 生产 build 产物）

| 测量点 | n | p50 (ms) | p95 (ms) | min (ms) | max (ms) | 均值 (ms) | 载荷 (B) |
|---|---|---|---|---|---|---|---|
| 文档 /m | 60 | 2.1 | 2.8 | 1.4 | 7.5 | 2.2 | 841 |
| 文档 /m/report | 60 | 2.4 | 12.3 | 0.9 | 18.4 | 3.6 | 841 |
| 文档 /m/hours | 60 | 2.0 | 2.8 | 0.8 | 4.4 | 2.1 | 841 |
| 文档 /m/stock | 60 | 2.7 | 10.8 | 1.1 | 21.5 | 3.8 | 841 |
| 组合冷加载 /m（文档+关键资产串行） | 60 | 18.7 | 20.6 | 17.2 | 22.0 | 18.8 | - |

说明：四页共享同一 index.html 文档（客户端路由，/m* 经 mobileRouteFallback
服务端窄域回落），载荷同为 841 B。/m/report 与 /m/stock 两行的 p95 抬升
（12.3 / 10.8 ms）来自单次回环抖动（max 18~21 ms 的孤立样本，均值 3.6 /
3.8 ms 与另两行同水位）——按原样报告，不做剔除。

### 1.2 关键资产（入口 html 引用的 /assets/*）

| 测量点 | n | p50 (ms) | p95 (ms) | min (ms) | max (ms) | 均值 (ms) | 载荷 (B) |
|---|---|---|---|---|---|---|---|
| 资产 main-Cb_AENje.js | 60 | 12.1 | 18.9 | 7.5 | 31.0 | 12.5 | 286,423 |
| 资产 index-o0vPrKK2.js | 60 | 6.7 | 7.3 | 5.3 | 11.4 | 6.8 | 197,425 |
| 资产 index-D8HaPnDr.css | 60 | 2.1 | 2.4 | 1.9 | 2.7 | 2.2 | 35,520 |

传输体积（真实网络 gzip 后）：main js 90,745 B（88.6 KiB）、入口 js
66,513 B（64.9 KiB）、css 7,021 B（6.9 KiB）——本测量回环未压缩原样传输，
线上开启压缩后传输时间按 gzip 体积折算更小。html5-qrcode 懒块（375 KB）
不在关键资产（首屏不加载，verify-pwa 断言锚定懒加载形态）。

### 1.3 核心 API（零 DB 内存形态，dev 头认证）

| 测量点 | n | p50 (ms) | p95 (ms) | min (ms) | max (ms) | 均值 (ms) | 载荷 (B) |
|---|---|---|---|---|---|---|---|
| GET /health（公开） | 60 | 1.5 | 1.7 | 0.3 | 1.8 | 1.5 | 34 |
| GET /workbench/summary | 60 | 1.7 | 1.9 | 0.5 | 2.3 | 1.7 | 48 |
| GET /workbench/todos | 60 | 1.6 | 1.8 | 0.5 | 2.0 | 1.6 | 12 |
| GET /hours/my | 60 | 1.7 | 2.0 | 0.6 | 2.0 | 1.7 | 69 |
| GET /inventory/stock | 60 | 1.7 | 1.8 | 0.3 | 1.9 | 1.6 | 13 |

端点选择 = 移动四页挂载即调的真实读 API（workbenchApi / hoursApi /
inventoryApi 的 request 路径）+ /health。认证经 `SMES_DEV_AUTH=on` 的
`x-smes-user` dev 头（生产 Bearer 路径在同一守卫内多一次会话查表，内存
会话下差异可忽略）。

### 1.4 起服（boot）

| 测量点 | 值 |
|---|---|
| 零 DB 起服 → /health 首次 200 | **429 ms**（6 模块内存形态，spawn 起计时，25 ms 轮询） |

## 2. 方法

- 每目标预热 5 次丢弃，60 次串行请求；计时 = fetch 发起 → 响应体完整收下
  （`arrayBuffer()`，含传输）；p50/p95 = nearest-rank；undici 全局连接池
  keep-alive 复用（模拟浏览器同源复用连接）。
- 认证与策略：启动开 `SMES_DEV_POLICY_ENDPOINT=on`，脚本 `POST /dev/policies`
  幂等注入 `perf-user → perf-role → workbench:read/hours:read/stock:read`，
  注入或采样遇非 200 即非零退出（脚本自带防呆）。
- 复跑：`node scripts/perf-m5.mjs --web http://localhost:4173 --api
  http://127.0.0.1:3988 --n 60 --markdown out.md`（参数可调；两张表落盘可选）。

## 3. 环境

| 项 | 值 |
|---|---|
| 机器 | Apple M5 Max，18 核，128 GB，macOS 27.0.1（darwin arm64） |
| Node | v24.18.0（nvm）；web 产物 = vite 7.3.7 build（本波最新提交态） |
| API 服务 | `apps/server` dist/main.js，PORT=3988，零 DB（内存 stores），`MODULES_ENABLED=core,org,masterdata,workbench,hours,inventory`，单机形态（租户恒 default） |
| Web 服务 | `vite preview --port 4173`（生产 build 产物；nginx 形态见 apps/web/nginx.conf，压缩/缓存差异见下） |
| 通道 | 本机回环（无真实网络 RTT）；preview 未开压缩（原样传输）；无并发干扰 |

## 4. 边界与未测面（如实）

- **不含浏览器端**：解析/执行/渲染、SW 拦截层、真实 3G/4G RTT 未测（无
  Playwright/devDeps 不新增）；组合冷加载是无缓存浏览器加载的**下界**。
- **API 数据面为空库**：零 DB 内存 stores，响应载荷 12~69 B；数据量放大后
  的查询/序列化开销不在本表（PG 形态 + 真实数据量的测量归部署期/对账阶段）。
- **写路径未测**：POST /reports 等写端点需要种子派工数据（零 DB 无种子），
  未纳入；读路径已覆盖移动页挂载的全部真实调用。
- **nginx 容器形态未测**：preview 与容器 nginx（gzip/长缓存/反代同源）行为
  有差异，容器栈实测归部署期验收；本报告为 node 形态基线。
- 自设基线（规格源无数值目标，见 §0）：回环组合 p95 < 100 ms / API
  p95 < 50 ms / 起服 < 5 s——供后续回归对照；Owner 可改判更严阈值。
