/**
 * 列显隐输入错误（fix-wave-6 6b-3，A14 / RREQ-INT-032）。
 * 400 语义：page/table 键形状非法、hiddenProps 非字符串数组。映射在组合根
 * DomainErrorFilter 同族（ColumnPreferenceInputError extends Error，HTTP 映射
 * 复用通用域错误过滤器——400 状态足够，不设独立 filter）。
 */
export class ColumnPreferenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColumnPreferenceInputError';
  }
}
