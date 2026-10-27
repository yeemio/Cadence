# M2 安全前置批合同（M2-SEC）

冻结：2026-10-27（M1 收版前限额窗口预写；**M1 tag 宣判后零延迟派发**）｜依据：ROADMAP M2 范围第 1 项（安全前置批）+ status.md M1 低危遗留登记（L344）+ 附件签名密钥 P3 登记（L42）+ R6 验收开门面加严 Owner 裁定登记（L8）+ grokbot 终验 D-23 P3（口令无强度要求）｜体例沿 fix-wave-6

## 0. 纪律

同 fix-wave-2 §3（code-writer-pro 实施+code-reviewer 验收+容器实证才合流、局部验证绿即停、不 commit/push、不跑全仓 verify、429/[1308] 退避、PATH export）+ 并发 ≤3 writer。**组合根（apps/server/src/app-registry.ts + main.ts）是共享写入面：涉组合根的包归单线滚动（fix-wave-6 先例——组合根接线归单线），写入面互斥见各包。**

## 批次与依赖总览

| 波 | 线 | 包 | 写入面（互斥基） | 依赖 |
|---|---|---|---|---|
| a（首派） | A 密证策略线（单 writer） | SP-1 登录速率限制 + SP-2 scrypt 升档 + SP-4 口令强度 | application/src/auth/* + application/src/org/* + business-store/src/org/* + prisma migration + seed.mjs + app-registry/main.ts 的 auth/org 接线段 | 无 |
| a | B 文档线 | SP-6 httpOnly cookie 评估 | 仅本目录新文档 | 无 |
| b（a 落地后） | C 密钥固化线 | SP-3 签名密钥 env 固化 | main.ts + app-registry 的 attachment/drawing 段 + business-store/src/attachment + drawing-http.module 注入点 | 与线 A 组合根错峰（无语义依赖） |
| c（滚动） | D 开门面线 | SP-5 图纸开门面加严 | drawing-http.module 开门面路由 + apps/web 兑现入口 | **Owner 裁定**（裁定问题随波 a 派发时一并提交 Owner） |

依赖关系：SP-1/SP-2 同改 auth.service.ts 登录路径 → 强制同线；SP-4 策略注入点在 app-registry OrgModule.register（L429）与线 A 接线段同文件 → 并入线 A；SP-3 与线 A 同碰 main.ts/app-registry → 波 b 错峰；SP-5 独立语义门，仅等裁定。SP-1/2/3/4 相互无行为依赖，任一失败不阻塞其余合流。

## SP-1 登录速率限制（公网硬前置）

**依据**：status.md L344"登录速率限制+改密端点（公网部署硬前置）"。改密端点本体已由 D-2 交付（PUT /org/users/:id/password：权限码门+写时全端撤会话）——登记销项，本包不含。

**范围（冻结）**：
- 模型：窗口失败计数 + 锁定。计数键 = (tenant, username)；缺省 5 次失败 / 15 分钟计数窗 / 锁定 15 分钟（窗口滑动按"最近一次失败时刻起算锁定窗"实现即可，不要求滚动精确滑窗）。成功登录清零计数。锁定期内同键一律拒绝——**正确口令也拒**（否则锁可被探测绕过）。
- 落点：AuthService.login 内部（端口注入，非 HTTP 层）——双形态在同一组合根注入点装配、服务层测试直接覆盖、auth.controller 维持零逻辑。
- 响应：新错误类型 → **429**，message 固定（如"登录尝试过于频繁，请稍后再试"），不含用户存在性信息；凭据错误路径维持四合一同 message 不变（auth.service.ts L81-93 语义不动）。
- 双形态：LoginAttemptStore 端口（application/src/auth/ 新文件，内存实现先行，同 session-stores.ts 模式——轻量运营表，不套证据公共列）+ business-store PG 适配（business-store/src/org/ 新文件 + prisma migration 新表）+ 组合根接线（app-registry shared 构造，同 sharedSessionStore 先例 L1122；main.ts 透传同 sessionStore L196）。**PG 形态计数自增须单语句原子**（防并发爆破漏计）。
- 参数可注入：构造/env 覆写（SMES_LOGIN_MAX_FAILURES / SMES_LOGIN_WINDOW_SECONDS / SMES_LOGIN_LOCK_SECONDS；缺省 5/900/900）——e2e 与演示需要短窗。
- 不做（登记）：IP 维度限流（hostBased 多租户下归部署层反向代理，部署手册补建议条目）；管理员手动解锁/锁定审计视图（窗口自动过期已足 M2，v1.1 议题）；/auth/refresh、/auth/logout 不限（opaque 256bit token 爆破不可行，写明即可）。

**写入面**：application/src/auth/（新 login-attempt 端口+内存实现、auth.service.ts、auth-errors.ts、auth.module.ts 接线）｜business-store/src/org/（PG 适配）+ prisma/migrations（新表）｜apps/server/src/app-registry.ts + main.ts（auth 接线段）｜测试文件同域。

**验证**：双实现单测（计数/窗口过期恢复/锁定期正确口令仍拒/成功清零/跨租户键隔离/PG 原子性）+ e2e 一次（连发失败→429→短窗过期→恢复 201）+ 容器 compose 登录链不回归。

## SP-2 scrypt N 升档 2^16 + 渐进重哈希

**依据**：status.md L344"scrypt N 提至 2^16"；password.ts L6-8 自述格式自证可升级（N/r/p 逐字入串）。

**范围（冻结）**：
- 参数：N 16384→65536（2^16），r=8/p=1/keylen=64/salt 16B 不变。**内存 128×N×r = 64MiB 超 node 缺省 maxmem 32MiB——hashPassword 与 verifyPassword 两路都必须显式传 maxmem（≥64MiB，实现取 128MiB 余量），否则 scryptSync 直接抛错**。
- verify 防御补强：解析串内参数后先按 128×N×r×p 判定内存预算，超上界（冻结 ≤2^20 等价预算）直接 false——保持 fail-closed 且防伪造存储串撑爆内存（现有 try/catch 兜底保留）。签名不变，drop-in。
- 渐进重哈希：login 验证通过且**串内参数 ≠ 当前参数** → hashPassword(明文) 重哈希 + UserStore.updatePassword 落库（端口已有，org-stores.ts L73-78——无需新端口）。静默升级：响应不变、不额外撤会话（登录自然换发）。取舍写明：只在登录时升级；管理员重置/建号天然用新参数；未再登录的存量旧参数哈希保持可用（verify 按串内参数）。
- seed 同步：packages/business-store/prisma/seed.mjs L75 内联实现 N=16384 → 同批升 65536（同格式同源）。
- 既有断言 SCRYPT_N=16384 的测试随批更新。

**写入面**：application/src/auth/password.ts、auth.service.ts（login 重哈希点）｜business-store/prisma/seed.mjs｜测试文件同域。

**验证**：单测（新参数哈希可验/旧参数串仍可验/登录后库内串 N=65536/越界参数串 false/maxmem 显式传参）+ 活库一次（旧参数哈希用户登录成功且升级落库）。

## SP-3 签名密钥 env 固化（多实例生产前置）

**依据**：status.md L42 P3 登记（附件签名密钥内存生成——跨重启 URL 404 设计内，多实例部署需 env 固化）+ 图纸 read-reference 同款（drawing-read-references.ts L21-23 同一取舍注释）。两域统一模式。

**范围（冻结）**：
- env 两键：SMES_ATTACHMENT_REF_SECRET / SMES_DRAWING_REF_SECRET。值 = base64 或 hex 编码、解码后恰 32 字节，直接作 HMAC-SHA256 key（不做 KDF 派生）。**格式非法 fail-fast 拒启动**（沿 SMES_TENANT_MODE=saas 缺 SMES_DOMAIN 拒启动先例，main.ts L373）；**未设 → 实例内随机 + 启动 warn 一行**（单实例 dev/demo 行为不变：重启失效仍设计内；多实例必须设——deploy/.env.example 与部署手册同批登记）。
- 附件接线（三适配器统一）：main.ts 单点读 env → LocalFileSystemObjectStorage({rootDirectory, signingKey})（选项已有，local-file-object-storage.ts L55）+ **connectAttachmentObjectStorage 需扩 AttachmentObjectStorageOptions.signingKey 并透传 PgObjectStorage 构造（现 pg-object-storage.ts L209 未透传——本包补）** + in-memory 兜底构造点同注。
- 图纸接线：main.ts 读 env → new DrawingReadReferenceSigner({signingKey})（构造选项已有，drawing-read-references.ts L128-151）→ app-registry drawing 工厂选项透传（L679 现未传 signer）→ DrawingHttpModule.register({readReferenceSigner})（选项已有，drawing-http.module.ts L274-280）。
- 语义边界写明：env 固化改变的是**跨重启/跨实例可用性**，不改 TTL（附件 60s 级/图纸 ≤600s）与"token 即唯一凭证"语义；真实对象存储接入后由 SDK 预签名取代（INT-007 注释口径不变）。

**写入面**：apps/server/src/main.ts（env 读取+构造）+ app-registry.ts（attachment/drawing 段透传）｜business-store/src/attachment/pg-object-storage.ts（options 透传一行）｜apps/server/src/drawing-http.module.ts（仅确认注入点，如需 options 面扩一行）｜deploy/.env.example｜deploy/scripts 冒烟脚本（既有先例体例）｜测试文件同域。

**验证**：单测（组合根传参到位/key 注入 round-trip）+ 冒烟一次：设 env 起服 → 签发 read-reference → 重启进程 → 同 URL 仍兑现；未设 env → warn 日志可见+重启失效实态不变。**两域各证一次**。

## SP-4 口令强度策略

**依据**：grokbot 终验 D-23 P3（口令无强度要求）+ 实态：org-input.ts L24-31 requirePassword 仅"1~128 非空字符串"，登录解析同宽（auth-input.ts L23 仅非空）。

**范围（冻结）**：
- 策略：最小长度（缺省 8；env SMES_PASSWORD_MIN_LENGTH 覆写；配置越界 fail-fast）+ 字符类要求开关（env SMES_PASSWORD_REQUIRE_CLASSES，缺省关闭——渐进收紧不破既有使用习惯）。上限 128 维持不变。策略校验新文件 **application/src/org/password-policy.ts（放 org 域：消费方全在 org，避免与线 A 的 auth 写入面冲突）**。
- 校验点：**仅设置口**——POST /org/users 初始口令（org.service.ts L85）+ PUT /org/users/:id/password 重置（org.service.ts L148-163）。拒绝 → OrgInputError 400 同族，文案含策略要求。**登录不校验**（存量弱口令仍可登录——出清走管理员重置，登记非目标）。
- 注入：OrgModule.register 增 policy 选项（app-registry.ts L429 注入点，env 读取集中在 main.ts 沿先例）。
- seed 一致性：seed.mjs 演示口令若低于缺省下限 → 同批调整口令值（实施时核对；deploy README 同步）。

**写入面**：application/src/org/password-policy.ts（新）+ org.service.ts + org.module.ts｜apps/server/src/app-registry.ts + main.ts（org 接线段）｜seed.mjs（如需）｜测试文件同域。

**验证**：org 单测（弱口令两端点均 400/合规通过/长度边界/策略关闭时行为不变/文案不含多余信息）+ 容器建号冒烟不回归。

## SP-5 图纸开门面加严（Owner 裁定后启动）

**依据**：status.md L8——R6 验收揪出开门面"登录门"假文案，已如实化（无登录门 token 即唯一凭证，与匿名兑现 200 实态一致）；**加严（@RequireLogin）登记 Owner 裁定**。实态：drawing-http.module.ts L186-199 `@Get('drawing/read-references/:token')` 无权限码无登录门。

**依赖（合同内标死）**：**Owner 裁定"兑现须登录态"后方可实施**——裁定问题随波 a 派发一并提交：图纸只读引用（复制-粘贴转递语义）兑现是否要求登录门。裁定"不加严"则本包销项归档（现状文案已如实，无债）。

**范围（裁定"加严"后冻结）**：
- 服务端：开门面路由加登录门——AuthGuard 有效会话即放行，**不要求权限码**（最小加严，"token 即凭证"语义上仅叠一道登录门）；兑现路径完全不变（仍走 viewRevision 全路径：claims.clearance 门禁 + 每次必落留痕；留痕身份默认仍记 claims.viewerId——若实施中改为记实际兑现人，属等价小裁量，两种均不破坏"引用不匿名"红线，写明即可）。
- web：in-app 兑现入口启用——粘贴引用 URL/token 在登录态内经 Bearer 兑现的页面/路由（apps/web，沿既有页面模式；当前粘贴 URL 直连 API 无 Bearer 头将 401，in-app 入口是加严后的可用性配套）。
- 不做（登记）：附件开门面 storage/:token 同款加严——留 INT-007（真实对象存储 SDK 预签名取代）路径，议题归 M4 对象存储接入批。

**写入面**：apps/server/src/drawing-http.module.ts（开门面路由）｜apps/web 兑现入口页+路由｜测试文件同域。

**验证**：e2e（未登录兑现 401/登录后兑现 200+留痕落账/in-app 入口走通）+ web 复证。

## SP-6 token httpOnly cookie 评估（研究项，不改代码）

**依据**：status.md L344"token localStorage→httpOnly cookie 权衡"。ROADMAP M2 定位为**评估**——产出文档而非迁移。

**范围（冻结）**：产出 `architecture/contracts/m2-security/httpOnly-cookie-evaluation.md`，大纲四节：
1. 现状盘点：Bearer+localStorage（apps/web/src/auth.ts L13 createBrowserTokenSessionStore(window.localStorage)、product-ui 存储抽象、MPA login bundle 与主壳同键共享、opaque token 8h/7d 语义、PWA 形态）；
2. 威胁模型：XSS 窃取 localStorage token vs cookie 引入面（CSRF/SameSite 策略选择、hostBased 多租户子域下 cookie Domain 属性泄漏面、CORS 凭据面、refresh 端点暴露面）；
3. 迁移成本：AuthGuard/controller Bearer 解析、apiClient 与 product-ui 抽象层、e2e 全量 Authorization 头、双形态与 seed/脚本、移动端——逐项列改动面；
4. 结论三选一（维持 Bearer+补偿措施 / 迁 httpOnly cookie / 条件迁移）+ 若迁的分步路线与回归面清单。
文档须与 ADR-0005（租户从上下文进）/ADR-0009（bundle 隔离）口径互证。

**写入面**：仅上述新文档。

**验证**：code-reviewer 文档验收四问（威胁面枚举完整/成本估计有实据/建议可执行可复核/与 ADR 口径一致）。

## 不做（本批登记，防扩盘）

- 改密端点本体（D-2 已交付，M1 登记销项）；IP 维度/代理层限流（部署手册条目）；管理员手动解锁与锁定审计视图（v1.1）；存量弱口令强制出清（管理员重置处置）；附件开门面同款加严（INT-007 取代路径）；审批决策权细化/多审批人终态清扫（M1 低危遗留其余项，归 M2 后续批/会签场景）；签名密钥轮换（env 固化先行，轮换归 M4 运营面）。

## 附录：事实源速查（派发随包附带）

- **scrypt**：password.ts L15 SCRYPT_N=16384/格式自述 L4-8/verify 逐串参数 L43-75；seed.mjs L75 内联 N=16384
- **登录面**：auth.service.ts L81-93 login 四合一同 message；auth.controller.ts L57-64 公开路由；session-stores.ts 端口形状；main.ts L196 PG sessionStore 透传；app-registry L1122 shared 构造先例
- **签名密钥**：read-reference-tokens.ts L28-31 随机 32B；三适配器缺省随机（in-memory L46/local-file L55/pg L105）；main.ts L137-148 附件存储构造；drawing-http.module.ts L274-280 register 选项已有但 app-registry L679 未传；pg-object-storage.ts L189-192 options 仅 datasourceUrl、L209 构造未透传 signingKey
- **口令面**：org-input.ts L24-31（1~128 无强度）/PASSWORD_MAX_LENGTH=128 L22；org.service.ts L85 建号初始口令、L148-163 D-2 重置+全端撤；org-stores.ts L73-78 updatePassword 端口已有；auth-input.ts L23 登录仅非空
- **图纸开门面**：drawing-http.module.ts L186-199 无登录门+Owner 裁定注释；兑现走 viewRevision 全路径留痕
- **web token**：apps/web/src/auth.ts L13 localStorage
- **登记源**：status.md L344（M1 低危遗留）/L42（附件密钥 P3）/L8（开门面 Owner 裁定）；ROADMAP.md L21（M2 安全批定义）；env fail-fast 先例 main.ts L373
