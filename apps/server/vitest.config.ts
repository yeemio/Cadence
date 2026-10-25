/**
 * apps/server vitest 配置（M1 增量 3-H，boot smoke 进 CI 的前置条件）。
 *
 * 为什么需要自定义转译：vite/vitest 默认用 esbuild 处理 TS，而 esbuild 不支持
 * emitDecoratorMetadata——design:paramtypes 被丢弃后 NestJS 构造注入拿到
 * undefined（AuthGuard.this.reflector 为 undefined → 全端点 500）。既有单测只
 * 校验注册表数据结构、从未真正起过 Nest 容器，故此前未暴露。
 *
 * 修法：用本包既有的 typescript devDep 内联转译本包 TS（保留装饰器元数据），
 * 零新增依赖。@smes/application 经 node 解析走其 dist（tsc 产物，本就带元数据），
 * 不经本插件。不设 test.include——沿用 vitest 默认 glob（任意路径 *.test.ts），
 * tests/boot.e2e.test.ts 与 tests/app-registry.test.ts 均被默认收录。
 */
import ts from 'typescript';
import { defineConfig, type Plugin } from 'vitest/config';

/** tsc 转译插件：对非 node_modules 的 .ts 用 tsc（而非 esbuild）产物。 */
const tscWithDecoratorMetadata = (): Plugin => ({
  name: 'tsc-with-decorator-metadata',
  // 必须 enforce: 'pre'：vite 插件序里 vite:esbuild（core）先于普通用户插件，
  // 若不抢先，esbuild 已把装饰器降级，tsc 事后无从补 design:paramtypes。
  enforce: 'pre',
  transform(code: string, id: string) {
    if (!id.endsWith('.ts') || id.includes('/node_modules/')) {
      return undefined;
    }
    const { outputText, sourceMapText } = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        sourceMap: true,
      },
    });
    return { code: outputText, map: sourceMapText };
  },
});

export default defineConfig({
  plugins: [tscWithDecoratorMetadata()],
});
