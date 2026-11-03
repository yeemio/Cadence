# 图纸访问权限与签名兑现入口

本PR按Owner 2026-11-03明确指令创建：先综合核实普通Chat review，分类PR，再由同一普通Chat修复迭代。初始提交仅登记修复合同，尚无代码修复，不构成修复完成。

- 固定审查基线：`5425feb93856772c728ffb482b18bced5eb88558`
- 来源：普通Chat / Pro最高 https://chatgpt.com/c/6ae9835f-b5e4-83e8-9f6e-4b1139b7b1d0
- findings：F1, F8
- 责任：同一普通Chat为本PR代码作者；现有Codex总控核实与接收、机械发布允许的候选；不成为双主控。
- 状态：9项均有源码/合同依据，尚未运行复现；8 Important、1 Minor，不声称全仓无Critical。

## 允许路径

- `packages/application/src/manufacturing/manufacturing.service.ts`
- `apps/server/src/manufacturing-http.ts`
- `apps/web/nginx.conf`
- `apps/web/src/pages/drawing/**`
- `packages/drawing/**`
- `apps/server/tests/**`
- `packages/application/tests/manufacturing/**`
- `apps/web/tests/**`
- 本合同及同目录交付说明。若确需其它路径，先给精确因果理由，不顺手扩改。

## 完成条件

1. 制造看板、工程记录/版本快照和命令返回的整个响应不得从旁路泄漏fileRef，内部历史快照不改写；有权查看通过原viewRevision路径并留痕。
2. 真实Web origin中有效短签名导航到达兑现入口；过期/跨租户仍正确拒绝；正常SPA深链不回退；不新增登录要求、不将IAB空白归因于本修复。

## 验证与迭代

只使用隔离样本。先以现有失败/源码/受控复现确认具名机制，再最小修复；不启动未经Owner同意的严格TDD。稳定候选执行适用回归与项目要求的检查，报告准确head、命令、退出码及失败原件；未运行就写未运行。已有有效覆盖复用。修复/验证语义或范围有分歧先交总控裁定，同PR同作者一轮窄返工后重新评估，不能无限循环。

## 权限与停点

仅在本PR的head分支内修改和发布允许代码/测试/说明；不写main、不合并、不部署、不触真实/共享数据、不新建Work/Chat或派代理。需GitHub写入能力时直接使用当前允许工具；若工具不支持，返回具体失败与完整可发布补丁，不能声称已提交或要求Owner搬运。总控可在同PR机械发布Chat候选并执行必要验证。候选稳定且本PR证据齐套后报告实际文件/提交链接，由总控接收；未接收不得自行进入下一PR。
