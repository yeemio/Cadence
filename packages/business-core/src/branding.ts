/**
 * 品牌化 ID（ADR-0003 #2）
 *
 * 类型级身份：不同名称的 ID 即使底层都是 string 也不能互相赋值，
 * 编译后零开销。运行时只校验"非空字符串（1~128 字符）"，
 * 具体格式约束（前缀、uuidv7 等）由各领域规格在 create 之前自行叠加。
 */
declare const brandMarker: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [brandMarker]: Name;
};

export interface IdBrand<Name extends string> {
  readonly name: Name;
  create(value: string): Brand<string, Name>;
  is(value: unknown): value is Brand<string, Name>;
}

export function defineId<Name extends string>(name: Name): IdBrand<Name> {
  return {
    name,
    create(value: string): Brand<string, Name> {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
        throw new Error(`invalid ${name}: expected a non-empty string of 1~128 chars`);
      }
      return value as Brand<string, Name>;
    },
    is(value: unknown): value is Brand<string, Name> {
      return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
    },
  };
}
