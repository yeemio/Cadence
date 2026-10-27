# SP-6 token httpOnly cookie 评估（研究项，不改代码）

依据：M2-SEC 合同 SP-6 节（status.md L344"token localStorage→httpOnly cookie 权衡"登记）；ROADMAP M2 定位为**评估**——本文档是产出，不含任何代码变更。
实施：M2 安全前置批波 a 线 B（code-writer-pro，GLM-5.3）｜2026-10-27。
**结论先行：建议选项 C——维持 Bearer+localStorage，叠加补偿措施（安全响应头/CSP、SSE 流票独立收敛），httpOnly 迁移设为条件触发项；触发条件与预案路线见 §4。**

所有实态锚点均为本次评估第一手读回（文件:行号），非转述。

---

## 1. 现状盘点：Bearer + localStorage 的完整实态

### 1.1 token 形态与会话语义

- **opaque 256-bit 随机令牌**（base64url，43 字符）而非 JWT：`generateSessionToken`（packages/application/src/auth/token.ts L12-14）。服务端会话表只存 sha256 摘要（token.ts L17-19 文件头注："明文 token 不落库：拖库不等于可冒用"）——token 明文只出现在签发响应、浏览器存储、请求头三处。
- **生命周期双上限**（packages/application/src/auth/auth.service.ts L29-32）：访问 TTL 8h（`SESSION_TOKEN_TTL_MS`）+ 续期窗口 7d（`SESSION_REFRESH_WINDOW_MS`，自首签起绝对上限不随续期滑动）。refresh 即轮换：旧 token 立即失效（auth.controller.ts L6 路由注释"旧 token 即刻失效"）；refresh 口复查用户存在且 active（auth.service.ts L14-16）——漏撤销会话在续期口被拦。
- **撤销即时生效**：服务端会话表是唯一事实源，撤销 = 一行 UPDATE。改密与停用均写时全端撤会话（org.service.ts L131 停用、L159-161 重置口令 `revokeAllForUser`——D-2 交付）。

### 1.2 前端存储与消费链

- 存储实态：`apps/web/src/auth.ts` L13 `createBrowserTokenSessionStore(window.localStorage)`，键 `cadence.session.v2`（packages/product-ui/src/token-session.ts L33）。存储内容 = 整个 TokenSession JSON：明文 token + userId + tenantId + displayName + permissions + expiresAt（token-session.ts L17-25）。
- 消费单点：`apps/web/src/data/apiClient.ts` L21 独立建同键 store，L57-60 每请求注入 `Authorization: Bearer <token>`。其余全部 *Api.ts 经 `request()` 复用；移动路由组（apps/web/src/mobile.ts，/m 页）与桌面主壳同 bundle 同 apiClient——Bearer 注入面是**单一注入点**。
- MPA 双 bundle 只共享存储不共享运行时（ADR-0009 隔离前提）：登录入口 login.html 与主壳 index.html 是两套互不重叠的 bundle（apps/web/vite.config.ts L5、L239-241 rollupOptions.input），凭 localStorage 同键交接会话。
- product-ui 存储抽象：`TokenSessionStore` 端口（read/write/clear）+ 内存/浏览器两适配（token-session.ts L27-71）——存储介质可注入，这是迁移评估中唯一的抽象缓冲层。

### 1.3 服务端 token 解析点（全量枚举——任何迁移方案须逐点覆盖）

| # | 解析点 | 形态 | 锚点 |
|---|---|---|---|
| 1 | 全局 AuthGuard | 仅 `Authorization: Bearer` 头 | apps/server/src/auth.guard.ts L141-153 `readBearerToken`（纯头解析，无 cookie 路径） |
| 2 | /auth/refresh、/auth/logout、/auth/me | 控制器自解 Bearer 头 | packages/application/src/auth/auth.controller.ts L66-86（`requireBearerToken`） |
| 3 | SSE 大屏通道 | `?token=` 查询参 | apps/server/src/screen-http.module.ts L17-19 头注（"EventSource 不能带 Authorization 头"）、L130-135、L182-202 `authorized` |
| 4 | 图纸开门面 | HMAC 签名 token 即凭证，**不读会话** | apps/server/src/drawing-http.module.ts L186-199（无权限码无登录门） |
| 5 | 附件开门面 | 同上，TTL 60s | packages/application/src/attachment/attachment.controllers.ts L110-120（`storage/:token`）；TTL 常量 attachment.service.ts L31 |

解析点 4/5 与会话模型**零耦合**：token 自足（claims 含租户，HMAC 防篡改，过期即拒），浏览器地址栏直开可用——这正是其设计语义（drawing 引用是"复制-粘贴转递"凭证，web 侧把相对 URL 拼绝对后整链展示/复制：DrawingLibraryPage.tsx L447-456、L476）。**这两条浏览器直开路径今天不依赖 cookie，也不依赖 Bearer**。

### 1.4 会话行为三规则（ADR-0009 参照清单的产品化落地）——全部依赖 JS 可读 token

1. 临期主动续期：剩余 < TTL/3（≈2h40m）起每 60s 一次 refresh（apps/web/src/session-keepalive.ts L22-26）——续期调用须携带旧 token（authApi.ts `bearer(token)`）。
2. 网络失败不清会话 + **refresh 竞态防误清**：请求 401 且存储内 token 已被保活换新时，用新 token 原样重试一次（apiClient.ts L74-81）——该逻辑靠**比对存储 token 与本次请求 token 是否不同**实现。
3. 空闲登出 30min 仅页面可见且无进行中请求时累计（session-keepalive.ts L28-30、L52-56）。

规则 1/2 的实现细节（发送旧 token、比对 token 变化）都以 **token 对 JS 可见**为前提——这是迁移成本的核心敏感点（§3.8）。

### 1.5 部署拓扑：现有全部形态同源，无 CORS、无 cookie 基建

- 容器栈：web 容器 nginx 静态 + `@server` 反代 server:3000（apps/web/nginx.conf L54-63），`VITE_API_BASE_URL` 缺省 '' = 同源（nginx.conf L12-13 注释"容器栈选同源代理免 CORS 配置"）。
- e2e preview：vite 原生 proxy 同样反代到 server 端口，"server 未开 CORS（NestFactory.create 缺省），跨源直连会被浏览器拦"（packages/testkit/e2e/scripts/start-preview.ts 头注）。
- SaaS 形态：子域 nginx 代理 `{tenant}.{SMES_DOMAIN}` → server:3000 透传 Host（deploy/compose.yaml saas_proxy_conf L165-180）；租户解析 hostBased（apps/server/src/main.ts L352-387，缺省 single-node）。
- **服务端无 enableCors、无 cookie-parser 依赖、无任何安全响应头**（helmet/CSP/X-Frame-Options/X-Content-Type-Options 全仓均无——本次 grep 实证）。**web 源码 0 处 innerHTML/dangerouslySetInnerHTML**（本次 grep 实证）。

### 1.6 依赖 token 可见性的外围（脚本与测试）

- Playwright e2e：登录一次后 storageState 落盘 localStorage 键 `cadence.session.v2` 供全项目复用（packages/testkit/e2e/specs/auth-setup.spec.ts L7-11）；desktop-real-chain.spec.ts L142、L205 两处手工构造 `authorization: Bearer` 头做 API 读回。
- 性能脚本：deploy/scripts/perf-baseline.mjs L229-234 真实登录取响应体 token 后逐端点携带。
- dev/test 回落：`SMES_DEV_AUTH=on` + `x-smes-user` 头（auth.guard.ts L48-51）——与会话存储模型无关，任何方案下不动。

### 1.7 PWA 形态

vite-plugin-pwa generateSW（vite.config.ts L17、L144-145），SW precache 仅静态资产（workbox 配置注释 L108-119 口径），API 请求不入 SW 缓存；manifest start_url='/m'（nginx.conf L7-10 移动回落规则）。PWA 安装态与浏览器同源同存储——localStorage 与 cookie 在安装态的行为差异（如 iOS standalone 存储独立性）对两者**对称存在**，不构成方案间的决定性差异。

---

## 2. 威胁模型

### 2.1 现状 XSS 窃取面（Bearer+localStorage 的真实暴露）

- **攻击链**：任一 XSS 得手 → `localStorage.getItem('cadence.session.v2')` 拿明文 token → 外传 → 攻击者在任意客户端冒用，直至 8h 访问期到点；在 7d 窗口内攻击者也可自行调 /auth/refresh 轮换取新（refresh 即轮换，受害者与攻击者竞速——谁先刷谁持有效 token，但旧 token 在窗口内任意时刻可被攻击者先刷续命）。
- **现有缓解**（已全部落地）：8h 访问期硬上限；7d 绝对窗口；refresh 轮换（被窃 token 在受害者下次续期后死亡）；写时撤销 + 改密/停用全端撤（§1.1）；30min 空闲登出（仅客户端，对攻击者无效——如实登记）；SP-1 登录限速与 SP-2 scrypt 升档（本批线 A）保护的是凭据侧不是会话侧。
- **收益边界必须写清**：XSS 得手时攻击者**并不需要偷 token**——同源脚本可直接以当前身份发任意请求（在线冒用），httpOnly 只消除"离线持久冒用"（偷走 token 带走会话），不消除在线滥用。即 httpOnly 的净收益 = XSS 瞬时窗口之外的持久化窃取被阻断。
- **现状 XSS 面实况**：React 全程自动转义、0 处 innerHTML（§1.5 实证）、无第三方运行时脚本注入点；但**无 CSP 响应头**——纵深防御缺一层，这是当前最廉价可补的缺口（§4 补偿措施）。供应链面（refine/shadcn/workbox 等 npm 依赖）为常态风险，与存储模型无关。

### 2.2 现状 CSRF 面：≈ 零（结构性，非配置性）

Bearer 头凭证 = 浏览器不自动携带：跨站表单/图片/导航均无法附加 `Authorization` 头；所有改状态端点都过 AuthGuard Bearer 解析（解析点 1/2，§1.3），开门面是 GET+只读。服务端未开 CORS（§1.5），跨源带凭据 fetch 直接被浏览器拦截。**现状 CSRF 防御不依赖任何 SameSite 缺省行为或令牌比对——是凭证形态的结构属性。**

### 2.3 httpOnly cookie 引入的新攻击面

1. **CSRF 变实**：浏览器自动附 cookie ⇒ 全部改状态端点暴露于跨站伪造。SameSite=Lax（Chrome 系缺省）挡跨站 POST，但策略须显式固化（老浏览器/嵌入 WebView 场景不保证），且需叠 Origin/Referer 校验或 double-submit token 作纵深——**仓内目前零 CSRF 防御基建**，须从零建一个横切中间件 + 全端点覆盖测试。SameSite=Strict 破坏"从外部链接/新标签进入即已登录"体验（登录跳转回环会出现"看似未登录"）。
2. **SaaS 子域 Domain 属性是租户隔离红线**：hostBased 形态租户在主机名上（`{tenant}.{SMES_DOMAIN}`）。cookie **必须省略 Domain 属性（host-only cookie）**；若误设 `Domain=.SMES_DOMAIN` ⇒ 任一租户的会话 cookie 被所有兄弟子域自动携带 ⇒ 租户隔离击穿（违反 ADR-0005）。host-only 下兄弟租户子域的 XSS 也无法跨租户附 cookie——这是 cookie 方案在该形态下必须钉死的配置不变量。单租户形态无此题。
3. **CORS 凭据面**：一旦未来出现跨源 API 消费（独立大屏盒、集成方直连），cookie 形态必须开 `Access-Control-Allow-Credentials` + 精确 Origin 白名单 + `SameSite=None; Secure`——SameSite=None 把 CSRF 面重新放大到全站。Bearer 形态下跨源消费只需普通 CORS，无凭据耦合。
4. **refresh/logout 被自动凭据化**：CSRF-logout（骚扰级）、CSRF-refresh（轮换骚扰级）成为新面，须纳入同一 CSRF 中间件覆盖。
5. **Secure 属性与反代终止 TLS**：生产 TLS 在 nginx 终止，cookie 须按部署形态定 Secure——配置矩阵再增一维（single-node http 内网 / saas https 公网）。

### 2.4 SSE `?token=` 现状泄漏向量（独立于迁移的已知项，如实登记）

token 在 URL 查询参：反代 access log、浏览器历史可能记录（EventSource 连接 URL）。这是现状形态中**比 localStorage 更具体的 token 落日志面**，但可独立收敛（登录态换短时流票再连流，§4），**不构成整体迁移的必要条件**。反向收益如实登记：EventSource 同源自动带 cookie——cookie 形态会自然消灭该向量（迁移收益之一）。

### 2.5 移动端与 PWA

移动页全走 apiClient 单点（§1.2），迁移改动被该单点吸收；安装态 PWA 的存储怪癖对两种方案对称（§1.7）。无移动端特有增量。

### 2.6 开门面浏览器直开链路：与迁移正交，与 SP-5 相交

- **现状零影响**：drawing read-references 与 attachment storage 开门面不读会话（§1.3 解析点 4/5），token 即唯一凭证——换任何会话存储模型，这两条浏览器地址栏直开路径行为不变。**它们依赖的恰是"无 cookie 语义也无 Bearer 语义"的自足凭证。**
- **SP-5 相交点**（本批 Owner 裁定项）：若裁定图纸兑现加登录门，浏览器直开将需要会话凭证。届时 **cookie 是天然配套**（直开请求自动带 cookie，登录用户地址栏直开即过门）；Bearer 形态下直开无 Authorization 头必 401，需要 SP-5 合同已含的 in-app 兑现入口页承接。即：开门面加严会让 cookie 从"中性"变"使能技术"——这是 §4 条件触发的第一条。

---

## 3. 迁移成本：选项 A（全迁）/ B（双轨）逐项改动面

### 3.1 服务端（约 5 点位 + 1 新横切面）

| # | 改动 | 实态锚点与体量 |
|---|---|---|
| S1 | cookie 解析基建：引入 cookie-parser（MIT）或手写头解析；main.ts 中间件 | 现零依赖零代码（§1.5），从零建；小 |
| S2 | AuthGuard 双读：cookie 会话 + Bearer 并存（A 终态移除 Bearer，B 长期双读） | auth.guard.ts `resolveUser` 增分支；小 |
| S3 | /auth/* 四端点：login/refresh Set-Cookie（HttpOnly+SameSite=Lax+Path=/+**不设 Domain**+Secure 按形态）、logout Clear-Cookie、refresh/me 改读 cookie；响应体 token 字段处置（全迁=移除） | auth.controller.ts L57-87 整段；中 |
| S4 | **CSRF 防御新建**：Origin 校验中间件（同源白名单=自身 host；saas=`*.SMES_DOMAIN`）覆盖全部非 GET | 全新横切模块+全控制器测试；**中大** |
| S5 | SSE：`authorized` 增 cookie 分支；`?token=` 保留（publicStream 形态与非浏览器客户端仍需） | screen-http.module.ts L182-202；小 |
| S6 | 部署面：Secure 与 TLS 终止关系、saas host-only cookie 子域代理验证、compose/nginx 配置 | deploy/ 两形态；小 |

### 3.2 web 与 product-ui（4 文件族，改动最深的一侧）

| # | 改动 | 实态锚点与体量 |
|---|---|---|
| W1 | product-ui `TokenSession` 形状变更：token 字段移除/可空，parse 投影、内存 store、包测试矩阵重排 | token-session.ts L17-97；中（下游三消费方：auth provider、keepalive、apiClient） |
| W2 | apiClient：去 Bearer 注入改 `credentials`（同源缺省即带 cookie）；**401 竞态重试逻辑重构**——token 不可见后"比对存储已换新"失效，须改单飞 refresh + 排队重试 | apiClient.ts L21、L57-60、L74-81；**中大（最敏感点，见 §3.8）** |
| W3 | session-keepalive：refresh 不再需要 JS 持旧 token；换新覆写改由 cookie+响应 expiresAt 驱动；三规则实现重写 | session-keepalive.ts L99-119；中 |
| W4 | login bundle 与主壳：共享语义从 localStorage 键变 cookie 域共享——ADR-0009 隔离前提不破（仍不共享运行时），但交接测试重排 | apps/web/src/auth.ts、login 入口；小 |
| W5 | 移动/PWA：无独立改动面（apiClient 单点吸收，§2.5） | —；零 |

### 3.3 测试与脚本

- e2e：auth-setup.spec.ts storageState 从 localStorage 键改 cookie state（Playwright storageState 原生含 cookie，改造可控）；desktop-real-chain.spec.ts 两处手工 Bearer 移除（L142、L205）；screen 流新增 cookie 用例、`?token=` 用例保留。
- 性能脚本：perf-baseline.mjs 登录后持 cookie jar（Node fetch 需手动处理 set-cookie）；harness/seed 不涉（DB 层无会话语义）。
- testkit `SMES_DEV_AUTH` 回落路径不受影响。

### 3.4 双轨（选项 B）的固有代价

双凭证并存期 = **攻击面并集**（XSS 偷 token 仍可行 + CSRF 面已新增）；双读逻辑全端点长期维护；"灰度安全性"收益仅在过渡期成立。**双轨只宜作限时迁移阶梯（≤2 个发布），不宜作终态。**

### 3.5 成本汇总

服务端 6 点位（含 1 个新建横切面）｜web/product-ui 4 文件族｜e2e 3 文件｜脚本 1。主要风险集中在两处，且**恰是现状最强的两块资产**：

### 3.6 风险集中点 1——CSRF 面从零新建（S4）

现状 CSRF 零暴露是结构性的（§2.2）；迁移后 CSRF 防御成为"必须持续维护正确的配置承诺"（Origin 白名单、SameSite 矩阵、saas 子域 Domain 不变量）。净效果：用一个"待验证的防御承诺"换掉一个"结构性免疫"。

### 3.7 风险集中点 2——SaaS 子域 Domain 不变量（S6/2.3-2）

`Domain=.SMES_DOMAIN` 一处误配即击穿租户隔离（ADR-0005 红线）。该不变量须进测试（A 租户登录 cookie 在 B 子域请求不携带）+ 部署手册双保险。

### 3.8 风险集中点 3——会话竞态逻辑盲化重写（W2/W3）

三规则中规则 1/2 的现有实现靠 token 可见性做"轮换检测"（§1.4）。token 入 cookie 后客户端对轮换**不可观测**，401-重试语义只能重造（单飞 refresh + 请求排队），回归面覆盖登录态下并发放行、保活换新中 401、网络抖动不清会话等场景——这是全案最容易引入"偶发登出"类回归的部位。

---

## 4. 结论三选一与建议

### 4.1 三选项对照

| 选项 | 净安全效果 | 成本 | 判定 |
|---|---|---|---|
| A 全迁 httpOnly cookie | 消除 XSS 离线持久窃取；引入整条 CSRF 防御面 + 子域 Domain 红线不变量；SSE URL 泄漏向量自然消失 | §3 全量（约 14 点位，3 个风险集中点） | 净收益不确定：用结构性免疫换配置性防御 |
| B 双轨 | 过渡期攻击面并集；终态须收敛到 A 或 C | A 全量 + 双读长期维护税 | 仅可作限时阶梯，不可作决策 |
| **C 维持 Bearer+补偿措施（建议）** | 保留 CSRF 结构性零暴露；XSS 面靠补偿措施收窄（现状面已较窄：React+0 innerHTML）；已落地 8h/7d/轮换/全端撤缓解链 | 补偿措施 2 项（下），远小于迁移 | **建议** |

### 4.2 建议：选项 C，附条件触发与补偿措施

**判定理由**（与 §2 威胁面对齐）：

1. **换出的风险是低概率、换入的风险是高维护**：现状 XSS 面较窄（§2.1）且已有完整 TTL/轮换/撤销缓解链；迁移引入的 CSRF 横切面、SameSite/Domain/Secure 三维配置矩阵、saas 子域隔离不变量是长期高维护承诺——对离散制造 SME 内部系统（同源单拓扑、内部用户量级），交换比不成立。
2. **成本击中最脆弱资产**（§3.6-3.8）：会话三规则竞态逻辑盲化重写是"偶发登出"类回归的温床；CSRF 从结构性免疫降为配置性防御。
3. **httpOnly 的两个具体增量收益可独立获取**：SSE `?token=` URL 泄漏向量可独立收敛（流票）；XSS 纵深可直接补 CSP——都不需要整体迁移。
4. **现状缓解链已达标且本批继续加强**：8h/7d 双上限、refresh 轮换、写时撤销、改密/停用全端撤（D-2）、+SP-1 登录限速、+SP-2 scrypt 2^16、+SP-4 口令强度（波 a 线 A）。

**补偿措施（建议随 M2 后续批登记执行，不在本评估包写入面内）**：

- **CM-1 安全响应头**：CSP（`default-src 'self'` 级起步，按 Vite 资产形态细化）+ X-Content-Type-Options: nosniff + Referrer-Policy: strict-origin-when-cross-origin + X-Frame-Options: DENY——server main.ts 或 nginx 层一处落地。直接收窄 XSS 执行面 + 顺带压低 `?token=`/开门面 URL 的 Referrer 外泄。现状全仓零安全头（§1.5），这是当前性价比最高的一项。
- **CM-2 SSE 流票（可选，视 CM-1 后残余风险再决）**：`POST /screen/stream-ticket`（登录态换 60s 级一次性流票）替代长时会话 token 直连——`?token=` 里只出现短命票据而非 8h 会话 token。独立小包，不动会话模型。

**条件触发（满足任一即重启迁移评估，届时优先按 §4.3 路线走）**：

- T1：SP-5 Owner 裁定"图纸兑现加登录门"**且**浏览器直开兑现成为主用路径（cookie 成使能技术，§2.6）；
- T2：XSS 面实质扩大（富文本编辑/附件在线预览直渲染/引入第三方运行时脚本）且 CSP 不足以覆盖；
- T3：出现跨源 API 直连消费方（独立大屏盒/集成方）——届时按 Bearer+PKCE 类方案评估，而非 cookie（§2.3-3）。

### 4.3 若迁：分步路线预案（本批不执行，供条件触发时启用）

1. **服务端双读 + Set-Cookie**：S1-S3、S5 落地，Bearer 响应体保留（全端点兼容旧客户端）；
2. **web 双凭证灰度**：apiClient 附 cookie 优先、localStorage token 兜底（B 双轨起点，限时窗内）；
3. **竞态重构 + e2e 切 cookie state**：W2/W3 重写、e2e 三文件改造（§3.3）；
4. **收敛 A 终态**：移除 token 响应体字段与 localStorage 写入、AuthGuard 移除 Bearer 分支；
5. **清理**：双读移除、`?token=` SSE 分支按 publicStream 需求保留或移除。

每步独立可回滚；过渡窗 ≤2 个发布（§3.4）。

**回归面清单**（若迁，验收必覆盖）：登录/续期/登出全链｜保活换新中 401 竞态重试｜网络失败不清会话｜改密/停用全端撤联动｜SSE cookie 与 `?token=` 双形态｜e2e storageState 切换｜perf 脚本 cookie jar｜**saas 形态 A 租户 cookie 在 B 子域不携带（Domain 不变量）**｜开门面（drawing/attachment）直开零影响复证｜PWA /m 安装态登录保持｜login bundle→主壳 cookie 交接。

---

## 5. ADR 互证

- **ADR-0005（租户从上下文进）**：一致且互锁。租户判定始终以 TenantContext/主机名为准，token（无论在头、URL 还是 cookie）不携带租户自报；AuthGuard 的"会话租户 = 请求租户"一致性校验（auth.guard.ts L120-121）在两种方案下都不动。若迁：cookie 必须 host-only（§3.7）——Domain 属性是 ADR-0005 在 cookie 方案下的新增不变量。
- **ADR-0009（bundle 隔离与会话规则）**：隔离前提两种方案下均成立——cookie 域共享与 localStorage 同键共享等价，登录 bundle 与主壳仍不共享运行时。会话行为三规则的**语义**（主动续期/失败不清会话/空闲可见性计时）在两种方案下都保留；差异仅在实现细节——现行实现依赖 token 可见性（§1.4），cookie 方案需按 §3.8 重写实现并复证语义不变。
