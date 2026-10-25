/**
 * MigrationTarget 端口——数据迁移的目标写入合同。
 *
 * 端口形状（JSDoc 鸭子合同）：
 *
 *   interface MigrationTarget {
 *     readonly name: string;
 *     upsert(dataset: string, key: Record<string,CellValue>,
 *            row: Record<string, unknown>): Promise<{ action: 'inserted'|'updated' }>;
 *     snapshot?(dataset: string, filter?: { tenant?: unknown }):
 *            Promise<ReadonlyArray<Record<string, unknown>>>;   // 对账导出面
 *   }
 *
 * 语义合同：
 *   - upsert 按业务键判重：键已存在 = 更新（期望态覆盖），不存在 = 插入；
 *     返回 action 供报告统计 inserted/updated
 *   - 实现抛错（连接/冲突/约束）由 pipeline 按行捕获进报告（report 模式）
 *     或 strict 模式中止——目标错误与映射错误同一双模式语义
 *   - snapshot 可选：供迁移后对账导出（fixture-export 用）；dry-run 目标
 *     无快照（未持久化）
 *
 * 零依赖取舍：本目录不是 workspace 包（无 package.json），不能引
 * @smes/business-store / @smes/application——目标端口保持零依赖形状，
 * 主数据适配器用**鸭子类型**对齐 business-store 的 masterdata 端口
 * （见 masterdata-target.mjs），真实连接由接入期组合（README 接入期步骤）。
 */

/** 目标写入结果。 */
// typedef UpsertResult = { action: 'inserted' | 'updated' }
