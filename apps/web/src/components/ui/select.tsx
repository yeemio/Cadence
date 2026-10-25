/**
 * shadcn/ui Select（原生 select 最小实现，S2 批次）：九循环模块页的状态/kind
 * 过滤与枚举输入。不引入 radix Select 依赖——过滤下拉用原生语义（键盘可达、
 * 移动端原生面板），视觉对齐 Input 令牌。
 */
import * as React from 'react';
import { cn } from 'cn';

function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
