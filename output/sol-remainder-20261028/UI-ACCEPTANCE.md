# 最终可见UI接收入口

运行绑定：`evidence/FINAL-UI-RUNTIME-BINDING.json`。Web `http://127.0.0.1:8181`，API `http://127.0.0.1:3101`，隔离PG55435；最终node PID 86656，30模块健康。`pnpm-verify-final.log` build产物；之后只改测试/文档。精确文件指纹见 FINAL-RUNTIME-FILES.json。主控须刷新IAB避免旧bundle；旧8项UI原件 `evidence/parent-ui/RESULT.json` 与旧UI-RUNTIME-BINDING不覆盖。

设备链工作令：`wo-01a181e9-097e-73e8-b058-1c118d9178d8`，设备编码 A（切割设备A）/ B（装配设备B），外购 PURCHASED-P；C在另一独立恢复键夹具工作令，详见key-recovery-live/RESULT.json。不要用旧A的标准件pending失败夹具验正向。

主控补验（可读即可，不必再改库存）：

1. `plan01` 登录，打开 `/workorders?wo=wo-01a181e9-097e-73e8-b058-1c118d9178d8`，详情应出现“工作令设备清单”，持久设备A/B自制、P外购、数量/编码/名称及新增设备表单。既有8项已验证工作令深链，此处只验新增卡。
2. `plan01` 打开 `/listings/sheets?wo=wo-01a181e9-097e-73e8-b058-1c118d9178d8`，选择零件/标准件/电气件清单，在下方新增行区域查看“关联自制设备”选项仅A/B；选择设备采购清单时标签变“关联外购设备（可选）”，仅P可选。无需提交。既有旧行编辑设备关联是明确API更新面，本轮未新增旧行编辑器。
3. `prod01` 打开 `/dispatches`，新建派工类别切装配/电气，工作令输入 `wo-01a181e9-097e-73e8-b058-1c118d9178d8`：应出现A/B真实设备多选；装配另有“生成整线外购设备归拢任务（仅外购设备行）”，电气无此勾选。缺工作令/人员广义读权的说明应可读，设备选项仍来自dispatch:write专用投影。无需新建/指派，已有HTTP任务证据完整。
4. P1移动提交遮挡仍需实际窄屏确认：`prod01` 打开 `/m/report`，滚至提交，按钮应在底栏上方可见可点；本writer子任务IAB工具不可用且平台用户接管后已停止浏览器fallback，所以不宣称此项已视觉通过。可不再报工，已获HTTP业务证据。
5. 质检/入库新增选择器亦未做本writer视觉验收：`qc01 /inspections` 查看放行物料选择（仅待判无物料单可绑定）；`wh01 /inventory/stock-operations` 查看质检放行单/物料/仓库选项。无合适待检单时不必为截图重造业务，按源码/HTTP与已有测试接收边界注明。

设备相关UI是旧8项之后新增面；登录、AI chip/过滤/denied、采购表格/采购仓选项运行源码未再变化，其旧UI PASS继续复用。移动审批反馈改动仅源码检查与既有行为测试，本轮未重做真实L2/L3完整浏览器链，保留此边界。

身份只列用户名，不包含口令/令牌；沿用此前已授权合成环境身份。隔离栈为父级接收保留，不能拿此运行绑定指向共享3000/8080或生产。

## REWORK1仅补受影响清单项

新运行绑定 `evidence/REWORK1-UI-RUNTIME-BINDING.json`，候选 `39fc159969198fc15104bfd224d8b2604d84cbc524e881c1241e2cfe8bc435e8`，PID 89992，Web仍8181。原绑定不覆盖。请在可见IAB刷新，plan01进入 `/listings/sheets?wo=wo-01a181e9-097e-73e8-b058-1c118d9178d8`：设备采购“关联外购设备（可选）”留空应产生null而非空串；可用一条独立合成清单行作真实提交证明（不改库存/采购实收），也可明确仅视觉+载荷单测接收。自制类别选择A后切equipment，旧A选择应清空且仅P可选；选P后切回part，旧P清空，自制设备仍必选。已通过的其它设备/移动UI与parent-ui八项继续复用，不重走业务。
