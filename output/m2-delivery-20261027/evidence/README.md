# M2 交付证据目录（PM REWORK 补齐）

- 建立：2026-10-28（PM 产品接收 REWORK 后补档；优先归档已存在原件，未重跑）
- 候选冻结清单：见上级目录 `CANDIDATE-MANIFEST.txt`（161 文件逐文件 SHA256，聚合 `55f02e87…8d7f37`，含未跟踪文件与安装输入绑定说明；2026-10-28 11:0x 冻结）

## 本目录清单

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `pnpm-verify-rework-20261028-105x.log` | **REWORK 差量补齐后最终全仓 verify 原始日志（末行 EXIT=0，候选冻结态）** | /tmp 原件拷贝 |
| `pnpm-verify-final-20261027-2332.log` | R1 收口后全仓 `pnpm verify` 原始日志（**EXIT=0**） | /tmp 原件拷贝，未删改 |
| `pnpm-verify-baseline-20261027-2325.log` | 基线 verify 原始日志（EXIT=1：sp3 一次非确定性失败在档，随后三次全量/单跑均绿未复现——观察项完整保留） | /tmp 原件拷贝 |
| `code-reviewer-security-r1-accept.md` | R1 安全域验收（裁-12/SP-3/CM-1 三项 ACCEPT）reviewer 完整报告逐字存档（agent_9500bc14，含独立 curl 复核、CSP 哈希重算、未验证边界；总控补注含 PM 追加限定） | 子代理回传原文 |
| `writer-reports-r1.md` | R1 三实施 writer（裁-12 agent_49383b33 / 质检撤销 agent_45a6de89 / 计划岗 agent_79930534）收口报告逐字存档 | 子代理回传原文 |
| `cri12-notices-readback.desensitized.log` | 裁-12 三态 API 读回**脱敏副本**（登录令牌已遮蔽） | 原件受控保存于 `noodle-test-output/m2-r1-20261027/` |
| `clean-install-readback.desensitized.log` | 干净安装冒烟读回脱敏副本（token 片段遮蔽） | 同上 |

## 波 2 高频面（REWORK ①）实施与走查原件

`noodle-test-output/m2-r1-20261027/i18n-wave2-rework-evidence.md`——五模块 namespace（164/151+105/51 键）、ApiError code 消费、术语表、共享件接线、en 十页走查（复扫零残留）、en 操作测试、限额中断史与断点续作记录、边界登记（listing 模块不在枚举等）。

## 运行/业务读回原件（受控目录，未脱敏，含测试栈本地凭据片段）

`noodle-test-output/m2-r1-20261027/`：SP-3 两域冒烟、CM-1 头七路探针、裁-12 三态、浏览器岗位读回、干净安装单机+SaaS、撤销 403 对照、i18n 波 2 证据。

## 如实标注的缺失项（PM 允许「缺失就如实标注」）

1. **另一工程会话（W10a/b/c、W-sec、W-docs 批）的 reviewer 验收完整报告原件不在仓内**——该会话的验收以结论摘要登记于本 DELIVERY §3/§4 与 `noodle-test-output/ui-multirole-v1.0.0/results/p1-fix-wave1-delivery.md`（Round-1 八组逐条 changed paths+验收身份在档；W10/W-sec 组的逐条原件随该会话上下文结束未落盘）。本轮无法补造，只能引用摘要；如需逐条原件须该会话恢复后导出。
2. **浏览器读回为总控实录**（DOM 文本回读），非自动化 e2e 录制；Playwright 人工门禁规格沿 W 批移交口径未实跑。
3. 安装镜像与源码字节的绑定：镜像由当前工作区 `docker compose build` 产出（构建上下文=工作区实态），`CANDIDATE-MANIFEST.txt` 的逐文件哈希即该构建输入的字节清单；未做镜像内逐文件反解校验（如实登记边界）。
4. en 译文为文本级审阅+浏览器走查，未做母语审校（骨架定位，ADR 决定 5）。
