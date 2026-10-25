/**
 * append-only 写门（纪律第一层：应用层强制）。
 *
 * 取舍（完整论证见本包 README）：事实表与事件表的 append-only 纪律采用
 * "应用层写门 + DB 触发器"双层组合——
 *   - 写门（本模块）：仓储代码经 asAppendOnly() 拿到的 delegate 类型上不存在
 *     update/upsert/delete，编译期即无法写出更新语句；纯类型零运行时开销。
 *   - 触发器（migrations/ 内 SQL）：防绕过（原生 SQL / 其他客户端直连），
 *     只在活库验证路径生效。
 *
 * 修正语义：不 UPDATE 行——新行 objectVersion+1、supersedes 指向前任
 * （nextObjectVersion + buildEvidenceColumns({ supersedes })）。
 */

/** delegate 必须具备的最小形状（Prisma model delegate 均满足）。 */
interface DelegateShape {
  create: unknown;
  createMany: unknown;
  createManyAndReturn: unknown;
  findUnique: unknown;
  findUniqueOrThrow: unknown;
  findFirst: unknown;
  findFirstOrThrow: unknown;
  findMany: unknown;
  count: unknown;
}

/** 只读 + 追加写；update / upsert / delete / updateMany / deleteMany 不在面上。 */
export type AppendOnlyDelegate<T extends DelegateShape> = Pick<
  T,
  | 'create'
  | 'createMany'
  | 'createManyAndReturn'
  | 'findUnique'
  | 'findUniqueOrThrow'
  | 'findFirst'
  | 'findFirstOrThrow'
  | 'findMany'
  | 'count'
>;

/**
 * 把任意 Prisma model delegate 收窄为 append-only 视图。
 * 运行时同一对象（零开销）——防线是类型层面的；DB 触发器是第二层。
 */
export function asAppendOnly<T extends DelegateShape>(delegate: T): AppendOnlyDelegate<T> {
  return delegate;
}

/** 修正链下一版本号：objectVersion + 1（入参须为 >= 1 的整数）。 */
export function nextObjectVersion(current: number): number {
  if (!Number.isInteger(current) || current < 1) {
    throw new Error(`invalid current objectVersion: expected an integer >= 1, got ${String(current)}`);
  }
  return current + 1;
}
