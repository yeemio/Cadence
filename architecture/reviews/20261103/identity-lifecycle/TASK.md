# 会话撤销与升级权限保全

本PR按Owner 2026-11-03明确指令创建：先综合核实普通Chat review，分类PR，再由同一普通Chat修复迭代。初始提交仅登记修复合同，尚无代码修复，不构成修复完成。

- 固定审查基线：`5425feb93856772c728ffb482b18bced5eb88558`
- 来源：普通Chat / Pro最高 https://chatgpt.com/c/6ae9835f-b5e4-83e8-9f6e-4b1139b7b1d0
- findings：F2, F3
- 责任：同一普通Chat为本PR代码作者；现有Codex总控核实与接收、机械发布允许的候选；不成为双主控。
- 初始登记时状态：9项均有源码/合同依据，尚未运行复现；8 Important、1 Minor，不声称全仓无Critical。

## 允许路径

- `packages/application/src/auth/**`
- `packages/application/src/org/**`
- `packages/business-store/src/org/**`
- `packages/business-store/prisma/seed.mjs`
- `packages/business-store/prisma/schema.prisma`
- `packages/business-store/prisma/migrations/**`
- `packages/application/tests/auth*`
- `packages/application/tests/org/**`
- `packages/business-store/tests/**`
- `deploy/compose.yaml`
- `deploy/README.md`
- 本合同及同目录交付说明。Owner后续批次授权：为本组问题必需的同模块、调用者及既有测试路径可据因果补齐，并在交付中说明；新功能、业务模型或真实数据权限变化另行报告，不顺手扩改。

## 完成条件

1. 受控交错中，密码重置完成后释放旧refresh不得得到可用新会话；同token并发refresh最多一次成功；保持访问和续期窗口。
2. 角色撤销后按标准升级重跑，撤销仍有效；不恢复客户撤权、不重置口令或重新启用账号；保留首次安装引导能力。任何schema变动须在PR明确、增量兼容并提供隔离迁移读回，不碰真实数据。

## 验证与迭代

只使用隔离样本。先以现有失败/源码/受控复现确认具名机制，再最小修复；不启动未经Owner同意的严格TDD。稳定候选执行适用回归与项目要求的检查，报告准确head、命令、退出码及失败原件；未运行就写未运行。已有有效覆盖复用。修复/验证语义或范围有分歧先交总控裁定，同PR同作者一轮窄返工后重新评估，不能无限循环。

## 权限与停点

仅在本PR的head分支内修改和发布允许代码/测试/说明；不写main、不合并、不部署、不触真实/共享数据、不新建Work/Chat或派代理。需GitHub写入能力时直接使用当前允许工具；若工具不支持，返回具体失败与完整可发布补丁，不能声称已提交或要求Owner搬运。总控可在同PR机械发布Chat候选并执行必要验证。Owner后续明确授权（2026-11-03）：同一普通Chat自主安排全部六个既有PR的顺序、修复、验证和同PR迭代，不再逐PR等待总控ACK。各分支保持单writer，稳定候选分别报告实际文件/提交链接，由总控核实和最终接收；本段覆盖先前的逐PR等待限制，其余权限边界保持。
