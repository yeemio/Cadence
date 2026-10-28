# architecture/ —— 本仓宪法层

| 目录 | 内容 | 纪律 |
|---|---|---|
| `decisions/` | ADR（架构决策记录） | 编号只增不复用；推翻旧决策写新 ADR 并在旧文头部标注 superseded-by；重大架构改动必须有对应 ADR 先行 |
| `contracts/` | 边界合同（wire 形状、公共列、命令信封） | 文件名 `<name>.v<n>.md`；破坏性变更升版本号并保留旧版 |
| `requirements/` | 产品需求文档体系（PRD v1.0，2026-10-26 冻结） | 总纲+13 分域分册+追溯总表；冻结后正文不动、变更进各册文末增补登记节（append-only）；需求项编号 `RREQ-{域码}-NNN`、新差异号 `D-{域码}-NN`；差异只登记不派发（Owner 扩盘刹车） |
| [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md) | 产品合同与 PM 管理约定 | 产品目标、完成条件、架构约束、责任和事件触发维护 |
| [PRODUCT_LIFECYCLE_MAP.md](PRODUCT_LIFECYCLE_MAP.md) | 全生命周期状态与证据 | 分开工程收版、售卖就绪、真实试点、部署、运营及退役；标候选、遗留和未知 |
| [ROADMAP.md](ROADMAP.md#pm-current-tasks) | 产品里程碑与唯一目标层任务索引 | 复用原任务编号和执行证据，不复制派工表；本聊天维护 PM 投影 |
| [ai-query-dsh-proposal.md](ai-query-dsh-proposal.md) | 内置 AI 问数、DSH 底座及企微／飞书集成架构草案 | 产品方向已明确；拓扑、能力合同与排期仍属方案，不代表 accepted ADR 或已实施 |
| [DECISIONS-QUEUE.md](DECISIONS-QUEUE.md) | Owner 具名决定入口 | 保留原问题、建议与 append-only 销账；建议不等于批准 |
| `status.md` | 当前状态快照 | 每次收口更新；只记事实与证据，不写计划文学的流水账 |

来源链：Owner 定案 → 《技术选型决策簿 V1.0》（2026-10-23）→ 交接文档 V1.0 → 本目录。
冲突时以 Owner 最新指令为准（交接文档尾注）。
