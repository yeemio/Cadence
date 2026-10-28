# M2-R1 安全域验收报告（原件存档）

- 验收者：code-reviewer / GLM-5.3 / 子代理会话 agent_9500bc14-97ba-4a44-8d79-b5dc5d019320（同族记账声明见文内）
- 验收时间：2026-10-27 23:2x Asia/Shanghai
- 方式：只读原始证据（代码/测试/日志原件）＋本人对运行栈（127.0.0.1:8080/3000）独立 curl 复核＋构建产物哈希重算；未改任何文件、未重跑测试套件
- 本文件为子代理回传报告逐字存档（原件=总控会话接收的回传文本），未删改结论

---

# M2-R1 三安全域验收裁决

同族声明：本验收者与实施者同属 GLM 家族，按同族验收记账；三项均为只读验收，未改任何文件。

## 裁-12（图纸通知 clearance 过滤）：ACCEPT

**一句话理由**：过滤在服务层返回前完成，低许可不可见/孤儿 fail-closed/游标交集三态在代码、测试与我本人对运行栈的独立 curl 复核中全部成立。

### 明确检查点逐答

1. **过滤是否在服务端返回前完成**：是。`packages/drawing/src/drawing.service.ts` L448-466 `notices()`：`classificationRank(viewer.clearance)` fail-fast → 建链上 version→classification 映射 → `rows.filter(...classificationAllows(...))` 后才返回；控制器 `apps/server/src/drawing-http.module.ts` L201-216 直接回传过滤后数组，无前端兜底依赖。我本人复核（127.0.0.1:8080，demo-admin 登录）：clearance=public 只见 toVersion=[1]、`受限修订说明-X9` 出现 0 次；clearance=restricted 见 [1,2]；未知词 400；未登录 401。
2. **孤儿通知是否 fail-closed**：是。L462-465 `classification !== undefined && classificationAllows(...)`——toVersion 不在链上即整行不可见；测试 `packages/drawing/tests/drawing.service.test.ts` L379-395 证明孤儿 toVersion=99 对**有权**许可也不可见。
3. **sinceVersion 游标与过滤的交集语义**：游标先在存储层应用（in-memory L142-155 与 PG `packages/business-store/src/drawing/pg-drawing-stores.ts` L401-415 同为 `toVersion > sinceVersion` 升序），服务层过滤后取交集。我本人复核：sinceVersion=1&public → `[]`；sinceVersion=1&restricted → `[2]`。低许可者只见可见通知，游标按可见 toVersion 推进不会漏掉后续可见通知（过滤按行独立判定，与游标无耦合）。
4. **分页**：该端点无数组分页（无 page/pageSize 参数，返回全量数组），不存在分页/计数一致性问题。仓库中带分页的图纸端点是 drawingsIndex，其 total 与 rows 同口径过滤（service L422-438 + store 层 visibleClassifications），一致。

### Done-when 对照（合同 §4.B 裁-12 节）
- 服务端返回前过滤：成立（上述 1）。
- 低许可不可见 + changeNote 不泄露：成立（curl 泄露计数 0；test L357-377 断言两处受限 note 原文不出现）。
- 有权可见：成立（curl 见双通知；test L369-376）。
- 普通通知正常：成立（readback ③ + test L361-364）。
- 租户不退化：成立（test L405-427 双向收口；存储层 where 恒含 tenant）。
- 服务端响应与实际通知入口读回：成立（readback log + web 端 `drawingApi.ts` L206-215 传参、`DrawingLibraryPage.tsx` L509-514 NoticesCard 消费、`apps/web/tests/drawing-pages.test.ts` L150-157 钉 URL 形状）。

## SP-3（两域签名密钥 env 固化）：ACCEPT

**一句话理由**：解析 fail-fast 语义与接线链（env → 三附件适配器 + 图纸签发器 → app-registry → DrawingHttpModule）完整闭合，未设 env 零回归、非法拒启动在真实进程冒烟中均有据且我核对了断言真实性。

### 明确检查点逐答
1. **未设 env 单实例行为与旧实态一致（随机+重启失效）**：一致。`apps/server/src/main.ts` L211-213 未设/空串 → undefined；三适配器各自 `options.signingKey ?? newReadReferenceSigningKey()` 随机（pg-object-storage.ts L105、local-file L55、in-memory L46）；图纸侧 undefined → `DrawingHttpModule.register` 缺省 `new DrawingReadReferenceSigner()`（随机，drawing-http.module.ts L283）。冒烟 `deploy/scripts/sp3-signing-key-smoke.mjs` L193-208 断言真实：boot-C 无 env 启动 warn 各一行、boot-D 重启后旧引用 404（PG 数据仍在，404 只能归因密钥轮换）——日志 L207-211 全 PASS，我读了脚本断言原文确认非空转。
2. **非法值拒启动而非降级**：是。`parseSigningKeyEnv`（main.ts L211-230）在 NestFactory 之前 throw；hex 须恰 64 字符、base64 严格字符集（`^[A-Za-z0-9+/]+={0,2}$`）且长度 43-44 且解码恰 32 字节，其余一律 fail-fast。hex 先判消除 64-hex-char 按 base64 解 48 字节的歧义。冒烟 L212-213 两键各证 exit=1 且日志含「拒绝启动」（脚本 L213-214 用了两个不同的非法形态：非编码字符与 63 位 hex）。

### 接线与登记证据
- 附件：main.ts L318-338（PG 句柄/LocalFS/InMemory 三分支全透传）；`packages/business-store/src/attachment/pg-object-storage.ts` L207-222 修复点（此前构造未透传，单测 L125-132 钉住该契约）。
- 图纸：main.ts L416-422 → `apps/server/src/app-registry.ts` L707-712、L1382-1385 → DrawingHttpModule providers；单测 L58-84 证明同实例透传与缺省随机两态。
- 登记：`deploy/.env.example` L26-27；`deploy/README.md` L68、L242-251（含生成命令与冒烟脚本指引）。
- 语义边界：TTL（附件 60s 级/图纸 ≤600s）、租户绑定、token 即唯一凭证、留痕路径均未被本增量触碰（read-references 兑现仍走 viewRevision 全路径，drawing-read-references.ts 文件头 + service L373）。

## CM-1（安全响应头）：ACCEPT

**一句话理由**：四头在两种拓扑的浏览器面全覆盖，CSP 两个哈希经我本人对当前构建产物重算完全一致，策略与真实加载方式相符（无放开来源），代理路径同值双头经判断为良性。

### 明确检查点逐答
1. **CSP 哈希与当前构建产物实际内联脚本一致**：一致，本人重算。`apps/web/dist/index.html` 与 `login.html` 的 `vite-plugin-pwa:inline-sw` 内联脚本（两文件同串）sha256 = `l0IHPvf8eV52c9mPJymShDKYQmoP/YyzUHeE31FDYIs=`，`offline.html` 内联 `<style>` sha256 = `YtOWrAqaz/Nyg+osXB9QQeza3DEx372rEodcEB9gJ5o=`，与 main.ts L98-99 / nginx.conf L61 完全一致。dist 三个 HTML 无其他内联 script/style、无 `style=` 属性、无 eval；React 行内样式（4 个页面源文件有 `style={{`）经 CSSOM 写入不被 CSP 拦，客户端 SPA 无 SSR 属性序列化。worker-src blob: 对应 main bundle 实测 `createObjectURL(new Blob(...))`（papaparse worker）；connect-src 'self' 对应 `VITE_API_BASE_URL` 缺省 ''（apiClient.ts L19）。
2. **代理 API 响应重复头判断**：存在，同值双份（我本人复核 /auth/me 401：CSP 与 X-Content-Type-Options 各 2 次，来源 = nginx server 级 add_header 叠加 server 中间件同名头）。判断：**良性**——CSP 多策略按规范取交集，同值策略交集即自身；其余三头浏览器取首个同值，无语义差异。无丢头、无冲突值、不弱化（两处文件均已注明「同值单份口径，改动两处同步」）。
3. **HTML 面覆盖（API-only 不算数）**：成立。我本人复核 :8080 的 `/`、`/login`、`/m`、`/m/`、`/bigscreen/digital-operation`、`/offline.html`、`/sw.js`、`/manifest.webmanifest`、`/assets/main-kXGgLn9u.js` 四头各单份齐全；直连 :3000 /health 四头齐全；nginx 继承断链规避正确（`/assets/`、`= /sw.js`、`= /index.html` 三处带自有 add_header 的 location 重复声明四头，nginx.conf L97-129）；SaaS 代理拓扑经 main.ts 中间件透传（clean-install-saas-readback.log L9-13）。中间件注册在租户解析中间件之前（main.ts L524-530 先于 L633），租户解析失败 404/421 出口也带头。

## 发现的问题（按严重度）

无阻塞发现。三项均 ACCEPT。

## 非阻塞观察（不改变裁决）

1. **裁-12 readback 日志 qc01 对照项失真**（`noodle-test-output/m2-r1-20261027/cri12-notices-readback.log` L20）：标「预期 403」实得 401——qc01 登录本身口令失配（我复核：`auth.invalid_credentials`），该对照实际没跑成「有身份无 drawing:read」路径。门禁代码在（drawing-http.module.ts L203），通用 401/403 分离在 boot.e2e.test.ts L157-194 有覆盖，但 notices 路由专属 403 无同候选证据。建议下轮读回换正确口令的岗位账号补一行。
2. **SP-3 解析边界**：43/44 位纯 hex 字符的值会走 hex 分支因长度非 64 拒启动——fail-fast 方向，无安全问题，仅对刻意构造该形态的使用者报错文案略有误导（提示的是 32 字节密钥要求，可接受）。
3. **CM-1 双层同值维护面**：main.ts 与 nginx.conf 两份 CSP 靠注释约定同步，vite-plugin-pwa 升级会换内联串导致哈希失配（症状限于 SW 注册被拦）。文件头已自 declared，属已知维护契约。

## 未验证边界

- 未跑真实浏览器控制台扫 CSP 违规：我以 dist 静态分析（哈希重算、无 eval、无内联属性、blob worker/同源 connect 实证）替代；若后续引入 SSR 或 HTML 内直写 `style=` 属性，现 CSP 会拦。
- 未亲自重启运行栈验证 SP-3 两态（冒烟脚本在一次性 PG 容器上已证且我核了断言原文；运行中的 compose 栈不动，符合只读约束）。
- 未做双实例并发同 env 的活体运行（单测以同 key 双实例 round-trip 等价模拟）。
- notices 端点的「有效身份但无 drawing:read → 403」未见同候选专属证据（见观察 1）。

**关键文件**：`packages/drawing/src/drawing.service.ts`、`apps/server/src/drawing-http.module.ts`、`apps/server/src/main.ts`、`apps/web/nginx.conf`、`packages/business-store/src/attachment/pg-object-storage.ts`、`deploy/scripts/sp3-signing-key-smoke.mjs`。

---

*总控补注（2026-10-27 23:16）：观察 1 已在同晚闭合——工厂种子后 qc01 有效凭据直连 notices 路由得 403（`cri12-notices-readback.log` 补记行；脱敏副本见同目录 evidence/）。PM REWORK 追加限定（2026-10-28）：clearance 由请求自声明（原图纸模型 v1 无租户许可配置面），403 证明权限门不证明防自行越级——真实身份↔保密等级绑定归 P2-3/O5 待决，已写入 DELIVERY §9.1 限定语与 KNOWN-BEHAVIORS。*
