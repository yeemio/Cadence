# ADR-0008 monorepo 工具链

状态：accepted（2026-10-24，M0 实施定案）
来源：交接文档 §9 M0 立桩范围；决策簿"架构与模块化"页（依赖铁律 lint+CI 强制）

## 背景

M0 需要最小工具面把依赖铁律变成机器强制。包规模 ~12 个，AI 代理施工为主——
工具越少，代理上下文越省、出错面越小。

## 决定

- **pnpm workspace**（不引入 turborepo / nx：当前规模不需要任务编排器，需要时再评估）
- **TypeScript 逐包构建**（tsc + NodeNext ESM，business-core 暴露 dist；消费方走包名导入）
- **dependency-cruiser** 执行依赖铁律（.dep-cruiser.cjs），含反例自检（boundary:selftest）
- **GitHub Actions** 单 job：`pnpm install --frozen-lockfile && pnpm verify`
- 统一入口 `pnpm verify` = typecheck → boundary → boundary:selftest → build → test

## 后果

- 新包接入 = 建 package.json + tsconfig + 在铁律规则里确认层级，零额外配置
- M1 起 NestJS（apps/server）与 Vite（apps/web）进入 workspace 时，构建仍逐包自治
