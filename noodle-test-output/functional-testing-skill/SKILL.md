---
name: functional-testing
description: 给定一个代码仓库及其测试指南（如 TESTING-GUIDE.md），在本机部署、跑自动化测试套件，再用 Playwright（headless+截图）对每个模块做系统的功能/探索式 UI 测试，最后输出结构化缺陷报告。用户说"部署并测试""做完整功能测试""跑一遍回归"时使用。
---

# 完整功能测试（部署 → 自动化 → 探索式 UI → 缺陷报告）

借鉴：anthropics/skills `webapp-testing`（服务生命周期托管、先侦察后操作、networkidle、headless 截图）、Playwright Test Agents（planner/generator/healer 三段式：先出测试计划再执行，失败先自愈选择器再判缺陷）、Playwright MCP（用可访问性快照/role 定位而非脆弱 CSS）。

## 0. 纪律红线
- 只读仓库：不 push、不 force push、不改业务代码；测试脚本放 `qa/` 或仓库外的工作目录。
- 每条结论必须有证据：命令原文 + exit code + commit hash（`git rev-parse --short HEAD`）+ 日志/截图路径。
- 指南里的"已知设计内行为/勿报缺陷清单"先抄进 `known-behaviors.md`，命中即不报（可在报告"已核对的设计内行为"中列出）。
- 测试账号、口令只从指南读取，报告里不写口令，不外传。
- 环境问题 ≠ 产品缺陷：安装/资源/网络失败单列为"环境阻塞"。

## 1. 侦察
1. `git clone` 后记录 commit hash、分支。
2. 通读测试指南、README、`package.json`/Makefile/compose 文件，产出 `qa/plan.md`：前置依赖、安装命令、验证链、e2e 套件列表、部署命令、健康检查、入口 URL、账号/角色、模块清单、已知行为。
3. 检查并安装前置（运行时版本、包管理器、Docker），版本写入报告。

## 2. 自动化套件
按指南顺序逐条执行，每条：
```bash
( set -o pipefail; <命令> 2>&1 | tee qa/logs/<序号>-<名称>.log ); echo "exit=$?" >> qa/logs/<序号>-<名称>.log
```
- 记录耗时、通过/失败数；失败时摘录首个错误栈 + 复现命令。
- 与指南给出的基线数字对比，偏差即报告项。
- 偶发失败重跑 1 次，区分"稳定失败"与"flaky"。

## 3. 部署与健康检查
- 执行一键部署；轮询健康检查端点直到就绪（超时上限写明）。
- 记录各服务/容器状态（`docker compose ps`、关键日志尾部）。
- 未就绪 → 环境阻塞，附日志，停止 UI 阶段并上报。

## 4. 探索式功能 UI 测试（Playwright, headless）
**计划（planner）**：按"角色 × 模块"建矩阵，每个模块列：入口导航、列表/查询/分页、新建、编辑、删除、详情、导入导出、权限边界（低权限账号访问）、表单校验（空值/超长/非法格式/重复）、刷新与返回、错误提示。桌面与移动视口各至少覆盖主流程。

**执行（generator）** —— 先侦察后操作：
```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width":1440,"height":900}, record_video_dir="qa/video")
    page = ctx.new_page()
    errors=[]
    page.on("console", lambda m: m.type=="error" and errors.append(m.text))
    page.on("response", lambda r: r.status>=400 and errors.append(f"{r.status} {r.url}"))
    page.goto(URL); page.wait_for_load_state("networkidle")
    page.screenshot(path="qa/shots/<模块>-<步骤>.png", full_page=True)
    # 用 get_by_role / get_by_label / get_by_text 定位
```
- 每步：截图、收集 console error 与 ≥400 的网络响应（对照已知行为过滤）。
- 登录态用 `storage_state` 按角色保存复用。
- 数据用唯一前缀（如 `qa-<时间戳>`），便于清理与追踪。

**自愈（healer）**：定位失败先重新快照、换语义定位器重试；仍失败再判断是 UI 变化、缺陷还是脚本问题。

## 5. 缺陷报告 `qa/report.md`
开头：commit hash、环境（OS/运行时/Docker 版本）、执行时间（含时区）、总览表（套件/模块 × 通过/失败/阻塞）。
每个缺陷：
| 字段 | 内容 |
|---|---|
| ID / 标题 | BUG-001 一句话 |
| 严重度 | P0 阻塞 / P1 主流程错误 / P2 次要功能 / P3 体验文案 |
| 模块 / 角色 / 视口 | |
| 命令或入口 | 命令原文 或 URL |
| 复现步骤 | 编号步骤，含测试数据 |
| 期望 / 实际 | |
| 证据 | 截图、日志行、网络响应、console 错误 |
| commit | 短 hash |
| 稳定性 | 必现 / 偶现(n/m) |
另附：环境阻塞清单、已核对的设计内行为、未覆盖范围及原因。

## 6. 收尾
停止服务（如指南要求保留则保留），汇报：结论摘要、P0/P1 列表、报告路径。
