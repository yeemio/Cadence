/**
 * ColumnVisibilityMenu —— 列显隐勾选控件（fix-wave-6 6b-3，A14）。
 *
 * 零依赖折叠面板（details/summary——原生可访问性，不引 popover 库）：勾选 =
 * 显示、取消 = 隐藏；变更经 useColumnVisibility 的 toggleColumn 本地即时生效 +
 * 300ms 防抖提交。label 取列 label（key 兜底）。
 */
import type { TableColumn } from './ModuleTable';

export function ColumnVisibilityMenu({
  columns,
  isColumnHidden,
  toggleColumn,
}: {
  readonly columns: readonly TableColumn[];
  readonly isColumnHidden: (key: string) => boolean;
  readonly toggleColumn: (key: string) => void;
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        列显隐
      </summary>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-md border bg-muted/30 p-3">
        {columns.map((column) => (
          <label key={column.key} className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
            <input
              type="checkbox"
              checked={!isColumnHidden(column.key)}
              onChange={() => toggleColumn(column.key)}
            />
            {column.label}
          </label>
        ))}
      </div>
    </details>
  );
}
