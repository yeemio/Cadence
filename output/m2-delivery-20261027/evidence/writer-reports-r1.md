# M2-R1 实施 writer 收口报告（原件存档·逐字）

三份子代理回传报告全文存档（原件=总控会话接收的回传文本）。实施者身份与自检结果据实登记，未删改。

---

## 一、裁-12（writer A）

**身份**：code-writer-pro / GLM-5.3（thoughtLevel max）/ 子代理会话 agent_49383b33-30bc-43e7-8563-dd745fc107f0（子代理无自读会话途径，以派发元数据登记）

### 变更路径清单（7 文件，编辑前工作树 107 个在途脏文件一律未触碰）

| 文件 | 关键 diff |
|---|---|
| `packages/drawing/src/drawing.service.ts` | `notices()` 签名改为 `(tenant, viewer, drawingId, sinceVersion?)`；先 `classificationRank(viewer.clearance)` fail-fast；取修订链建 `version→classification` Map；过滤：`classification !== undefined && classificationAllows(viewer.clearance, classification)`（toVersion 不在链 → 不可见，fail-closed）；游标语义不变（先 store 游标后过滤=交集）。类头 docstring 同步标注 clearance 过滤 |
| `apps/server/src/drawing-http.module.ts` | 仅 notices 路由段：加 `@Req() request` 与 `@Query('clearance') clearance?`，传 `this.viewerOf(request, clearance)`；`drawing:read` 门禁保留；register/options/其他路由未动 |
| `apps/web/src/pages/drawing/drawingApi.ts` | `listDrawingNotices(drawingId, clearance, sinceVersion?)`，clearance 进 query 串（同 listDrawingIndex 模式）；头注释端点行同步 |
| `apps/web/src/pages/drawing/DrawingLibraryPage.tsx` | `<NoticesCard drawingId clearance>`（页面级 clearance 下传）；queryKey 改 `['drawing','notices', drawingId, clearance, sinceVersion]` |
| `packages/drawing/tests/drawing.service.test.ts` | 既有 notices 游标测试传 `techViewer`（原断言语义不变）；Harness 暴露 `noticeStore`；新增 4 个裁-12 测试 |
| `apps/server/tests/cross-module-wiring.e2e.test.ts` | L927 调用补 `&clearance=restricted`（原断言不变）；新增 public 许可读该通知得 `[]` 的服务端过滤断言 |
| `apps/web/tests/drawing-pages.test.ts` | notices 钉形测试适配新签名与 URL |

核心服务层逻辑：

```ts
classificationRank(viewer.clearance); // 未知许可 fail-fast，不默认放行
const chain = await this.stores.revisions.chain(tenant, drawingId);
const classificationByVersion = new Map(chain.map((row) => [row.version, row.classification]));
const rows = await this.stores.notices.readByDrawing(tenant, drawingId, sinceVersion === undefined ? {} : { sinceVersion });
return rows.filter((row) => {
  const classification = classificationByVersion.get(row.toVersion);
  return classification !== undefined && classificationAllows(viewer.clearance, classification);
});
```

### 跑过的检查及结果（均读完整输出）

| 命令 | 结果 |
|---|---|
| `pnpm --filter @smes/drawing test` | 38/38 passed，exit 0 |
| `pnpm --filter @smes/drawing typecheck` + `build` | 均 exit 0（build 必要：server 经 dist 消费本包） |
| `cd apps/server && npx vitest run tests/sp3-signing-key-wiring.test.ts tests/cross-module-wiring.e2e.test.ts` | 17/17 passed，exit 0 |
| `cd apps/server && npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `cd apps/server && npx vitest run tests/boot.e2e.test.ts` | 5/5 passed，exit 0（未授权 401 断言不受影响） |
| `cd apps/web && npx tsc -p . --noEmit` | exit 0 |
| `cd apps/web && npx vitest run tests/drawing-pages.test.ts` | 26/26 passed，exit 0 |

### 未解风险与未验证边界
- `apps/web/tests/drawing-pages.test.ts` 不在任务枚举允许清单内，但它是 `listDrawingNotices` 唯一直接调用方测试（签名变更即编译错），按「受影响断言同步适配」精神做了最小改动——总控已追认。
- 通知可见性只由 toVersion 对应修订判定；fromVersion 修订不可见不额外屏蔽——如需更严口径属新裁定。
- e2e 未新增 notices 未知 clearance 400 断言（既有 400 断言钉在 revisions 路由，共用同一 viewerOf/parseClearance 路径，单元层已覆盖）；浏览器层实操未做（props 传递为纯对齐）。
- 未 commit/push；未动 in-memory store、PG adapter、register/options 段、main.ts、app-registry.ts。

---

## 二、质检判定撤销入口（writer B）

**身份**：code-writer / GLM-5.3-Flash（thoughtLevel max）/ 子代理会话 agent_45a6de89-7577-40a9-bb37-8573166f964c

### 变更路径清单（3 文件）
1. `apps/web/src/data/inspectionApi.ts` — 新增 `revokeInspection(id, row, { remark })`，照 confirmConcession 先例：postCommand('/inspection/orders/'+id+'/revocation', 'inspection.revoke.v1', { remark }, revisionOf(row, '质检单行'))
2. `apps/web/src/pages/inspection/InspectionOrdersPage.tsx` — 详情卡新增「判定撤销」区；imports 补 usePermissions 等；独立 revokeMutation；扩 UX-QC-R2-02 切行清除 effect；结果读回区按来源追加失败提示
3. `apps/web/tests/module-pages.test.ts` — inspection describe 补 2 条撤销 API 断言（信封形状 + remark=null 口径）

### 检查
| 检查 | 结果 |
|---|---|
| typecheck（tsc -p tsconfig.json） | exit 0 |
| vitest 全量 | exit 0；23 passed/2 skipped 文件、231 passed/14 skipped 用例（含新增 2 条；i18n stderr 为既有测试预期日志） |

### 入口各状态呈现逻辑摘要
- passed/failed+有权：原因输入（maxLength 2000，trim 空→null 走服务端默认留痕）；说明讲后果；两步确认（确认撤销 destructive/取消）
- 成功读回：失效全部 inspection 查询→状态读回待检，流转记录出 REVOKE「撤销质检」；清原因输入；横幅「操作已生效」
- pending：禁用+「该质检单尚未质检，没有可撤销的判定。」（同服务端拒文口径）
- closed：禁用+「该质检单已闭环（终态），判定不可撤销。」
- 无权（inspection:judge）：禁用+照派工页 W10b 口径说明；data-permission-code="inspection:judge"
- 失败：横幅呈现服务端 reason（英文类别词映射中文），撤销来源失败时追加「请刷新列表核对该单当前状态与版本后再试；请勿盲目重复提交。」，不显示成功
- 切行：清 outcome/来源标记/确认步/原因输入

### 未验证边界
- 权限投影与撤销全流程未在真实浏览器跑通（总控已于同晚浏览器读回闭合）；usePermissions 未就绪禁用兜底为静态核验
- 撤销读回复用既有 invalidateQueries(['inspection'])，未新增失效逻辑

---

## 三、计划岗工作令选择与跳转（writer C）

**身份**：code-writer / GLM-5.3-Flash（thoughtLevel max）/ 子代理会话 agent_79930534-514f-49f5-9dd2-b0c88371b289

### 变更路径清单（3 文件）
- `apps/web/src/pages/listing/ListingSheetsPage.tsx`
- `apps/web/src/pages/listing/GapChecksPage.tsx`
- `apps/web/src/pages/workorder/WorkOrdersPage.tsx`

未触碰：menu.ts、locales、inspection、drawing、dispatch 页面、workorderApi.ts（只读复用 listWorkOrders）。在途未提交修改全部以 M2-R1 标注叠加。

### 检查
| 检查 | 结果 |
|---|---|
| typecheck | exit 0 |
| vitest | exit 0；23 passed/2 skipped 文件、231 passed/14 skipped 用例 |
| build（vite） | exit 0，✓ built in 2.11s |

测试钉点核查：apps/web/tests 只钉 API 层与装配注册表，不渲染页面内部；testkit e2e 只钉 `#sheets-wo`/`#gap-wo` 输入框 id（原样保留）；「粘贴工作令 id」文案无测试断言。

### 行为摘要
- 两页工作令输入接 datalist 候选池（照 DispatchOrdersPage UX-PRD-09 先例——`listWorkOrders().catch(() => [])` 静默回退手填；两页共用查询键共享缓存）；option value=稳定 id，label=项目名；已选对象下方确认行「当前工作令：项目名 · 短码」（shortId 复用 lib/format）
- URL 直达 `?wo=<id>` 初始化（react-router useSearchParams，沿 DrawingLibraryPage 先例）；换单后回写 URL（replace）；缺口核查页 URL 直达只读加载最新快照不自动执行核查
- 换单清态：清单页沿键控隔离；缺口核查页 handleWorkOrderChange 换单即清 loadedId 与上次核查提示
- 工作令页行操作区「清单」「缺口核查」按钮，权限闸 usePermissions+sessionHasPermission（码=菜单同码 listing:read/gap:read；未就绪按无权兜底不渲染入口）

### 未验证边界
- 未跑浏览器级 e2e（总控已于同晚浏览器读回闭合）；同路由浏览器后退不重初始化（与图纸库先例一致，主路径重挂载不受影响）；datalist 浏览器原生控件展示细节差异（与派工页同口径）；缺口核查 URL 直达多一次只读快照请求（无副作用）；无 workorder:read 账号候选池静默降级手填（既有先例口径）
