# 总控收口 RUNBOOK（Owner /goal 2026-10-26 00:20）

Owner 总目标：监控 M1/M2 两线收尾 → 总控统筹合并 → 提交 GitHub 主线（origin=git@github.com:yeemio/Cadence.git，**push 已获 Owner 本目标显式授权**）→ 自己跑完整测试 → 发现问题多线程修复 → 不断迭代。限额 → 每 30 分钟重试。

本文件是定时触发上下文的执行手册。背景记忆：`~/.zcode/cli/memories/projects/cadence-733ba79f874d6830/memory/cadence-project-identity.md`。账本：dual-lane=`/Users/yeemio/AI/gitrep/cadence-runkit`、S3/T 线=`/Users/yeemio/AI/gitrep/cadence-runkit-s3`（命令前 export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"，cd 到账本目录 `npx --no-install owlrunkit project status --workspace .`）。

## 一、静止判据（每次触发先判，未静止即收工等下轮）

满足任一即视为两线收尾：
1. dual-lane 账本出现晚于 `checkpoint-ckpt-merge-pending-handoff.json`（2026-10-25T15:41:55Z）的新收口 checkpoint；或
2. 仓内 `apps/web/src`、`packages`（除 dist/node_modules）连续 ≥45 分钟无新写入（`find ... -mmin -45` 为空）且 dual-lane 无新的 active 写入信号。

命中限额（429/1302）：本轮直接结束并留言"限额，等下轮"；连续两轮命中则改为每 30 分钟才动手（隔轮执行）。

## 二、接管序列（静止判定通过后按序执行，一步失败停下修复再续）

1. **T2 两行入口**（若尚未被他线代做）：`apps/web/src/menu.ts` 加 overview manifest 项（desktop 菜单，权限码用 `OVERVIEW_REQUIRED_PERMISSIONS` 的语义——挂 admin 或四码；与既有项同体例）；`apps/web/src/pages/assembly.ts` PAGE_BY_CODE 加 `'overview': OverviewIndexPage`（from './overview/IndexPage'）；`apps/web/tests/module-pages.test.ts` 若有清单断言则同步。跑 web 相关测试单绿。
2. **账本收口**：cadence-runkit-s3 `project checkpoint --state completed --completed-units 1 --evidence <S3/T 全量证据文件>`。
3. **WIP 提交 main**：`git status` 全量清点 → 确认无他线新写入（再查一次 mtime）→ `git add -A && git commit`（消息：S/T 波全量：S1 后端补齐+S2/S3-a 桌面与管理页 68+S3 移动 19+1+能力子集五项（T1/T2）+文档解禁差异清点）。.DS_Store 等杂物先清。
4. **并入 lane/m4-final（3782c1d）**：`git merge lane/m4-final --no-ff`。**M2 线已留合并预检（status.md 未提交段，重叠仅 3 文件，解法如下）**：①`apps/server/src/main.ts`：以 S 波版为底，合入分支的 tenantResolutionErrorHandler import + app.use 注册 + healthcheck-probe 的 parseKnownTenants 复用（租户错误=分支 421 机制，活体实证过）；②`packages/business-store/src/baseline/pg-baseline-stores.ts`：**必须取分支的 orderBy 数组形态**（多键对象是 Prisma 必拒的潜伏缺陷，容器路径实证）；③`deploy/scripts/rls-proof.mjs`：取分支版（改引 harness.mjs 共享脚手架）；若本仓版本也动过则以 harness 引用方式手工合成。其余冲突逐个亲读双方语义做并集；拿不准开 code-writer-pro。**禁止 --strategy 无脑取一方**。合并后跑 verify 全绿再删 lane/m4-final 与 lane/m5-final 两分支。注意：origin/main 已在 127e353（M2 线已推送），本仓 push 是增量。
5. **全量验证**：`pnpm verify`（根目录）。红 → 记录失败面 → 按"每缺口一个 code-writer-pro、写入面互斥"派多线程修复 → 修复后重跑 verify。迭代到 exit 0。
6. **推送**：`git push origin main`。若远端有新提交先 fetch 再 rebase/merge 处理。
7. **收口登记**：status.md 追加总控收口段（合并+verify 数字+push 哈希）、账本 checkpoint、记忆更新。
8. **向 Owner 报**：终版覆盖数字（可顺带刷 architecture/coverage/coverage-matrix.md 的呈现列）、验证证据、遗留清单。

## 三、红线不变

不 force push；不跳过或粉饰 verify 失败（红就是红，修到绿再推）；限额不当作失败；两线若"复活"写入（静止判定后又见新写入）→ 暂停接管、重新监控、账本留言询问其是否还有未收口项。
