/**
 * 类名合成出口（shadcn copy-in 模式的本地稳定入口）。
 * 实现取官方 `cn` 包（shadcn-ui org 出品，clsx 语法 + tailwind-merge 语义的编译实现，
 * 官方 registry 组件的钦定依赖），组件内直接 `import { cn } from "cn"` 与未来
 * `shadcn add` 产出的源码保持一致；应用代码统一从本文件引入。
 */
export { cn } from "cn";
