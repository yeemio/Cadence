/**
 * RLS 策略生成出口（ADR-0005 M4 预研）。
 *
 * 包出口取舍：未在 package.json exports 挂 "./rls" 子路径——本预研不改既有
 * 文件；消费方是包内测试与迁移快照。M4 正式线接线（server session 变量 /
 * Prisma 连接钩子）时再挂出口，届时一行 exports 条目即可。
 */
export { generateRlsSql } from './generate-rls-sql.js';
export type { RlsTableSpec, GenerateRlsSqlOptions } from './generate-rls-sql.js';
export { RLS_TABLES } from './tables.js';
