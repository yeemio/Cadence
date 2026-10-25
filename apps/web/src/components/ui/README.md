# src/components/ui —— shadcn/ui 组件落位

## 当前状态：已落地（copy-in 手工路线）

CLI 第三次尝试（2026-10-24，`init -t vite -b radix -p nova -y --no-monorepo
--css-variables`）仍在安装依赖后退出（exit 1，与 M1 增量 2-C 两轮同一现象），
但本轮依赖已实际装入。按合同降级条款走手工 copy-in：

- **组件源码**：官方 registry JSON 直接拉取
  `ui.shadcn.com/r/styles/radix-nova/{button,card,input,label}.json` 原样拷贝
  （button / card / input 原样；card 唯一适配 `cn-font-heading` → `font-heading`，
  因 nova 预设该类绑定 Geist webfont，中文界面改系统字体栈）。
- **cn()**：官方 `cn` npm 包（shadcn-ui org 出品，registry 组件钦定依赖，
  clsx 语法 + tailwind-merge 语义的编译实现）；`src/lib/utils.ts` 提供本地稳定出口。
- **设计令牌**：`src/index.css` —— radix-nova 风格 neutral 基色全量 CSS 变量
  （含 sidebar / chart / radius），取值原样来自 `r/colors/neutral.json`；
  浅色默认、`.dark` 变量保留未接线。
- **components.json**：CLI 写入的这份可用（style radix-nova，别名 @/*），
  未来 `shadcn add` 可直接续。

## 已装依赖（runtime）

`cn` · `class-variance-authority` · `radix-ui`（Slot / Label）· `lucide-react`

未采用（有意裁剪）：`shadcn`（CLI 本体，非运行时依赖）、`@fontsource-variable/geist`
（Latin-only webfont，中文界面用系统字体栈）、`tw-animate-css`
（当前四组件无 animate 工具类，dialog/accordion 落地时再引）、
`shadcn/tailwind.css` nova 基础层 637 行（四组件只用 Tailwind v4 核心语法）。

## 历史记录

M1 增量 2-C：shadcn CLI v4.22.1 非交互 init 两轮失败后降级为手写占位样式，
本目录留位（原记录见 git 历史或交付记录）。重试命令：

```bash
pnpm dlx shadcn@latest init -t vite -b radix -p nova -y --no-monorepo --css-variables
pnpm dlx shadcn@latest add button card input label
```
