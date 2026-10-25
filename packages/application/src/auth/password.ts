/**
 * 口令哈希（M1 收尾波-③ 真实认证）——node:crypto scrypt，内建零依赖。
 *
 * 存储格式（自述格式，验证端只信格式不信来源）：
 *   scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>
 * 参数固定：N=16384, r=8, p=1, keylen=64, salt=16 字节随机——OWASP 2023
 * 推荐量级的 scrypt 参数（内存 128*N*r = 16MiB < node 默认 maxmem 32MiB）。
 * N/r/p 逐字入串：将来调参时旧哈希仍可按串内参数验证（哈希自描述）。
 *
 * 词汇纪律（ADR-0010）：password/hash/salt 全通用词。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_PREFIX = 'scrypt';
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** 生成口令哈希（每次随机盐——同口令两次哈希不同串）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    SCRYPT_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

/**
 * 校验口令。存量串格式非法/参数越界一律 false（fail-closed，不抛错——
 * 调用方把它与"口令不符"合并为同一拒绝，不泄漏差异）。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [prefix, nRaw, rRaw, pRaw, saltHex, hashHex] = stored.split('$');
  if (
    prefix !== SCRYPT_PREFIX ||
    nRaw === undefined ||
    rRaw === undefined ||
    pRaw === undefined ||
    saltHex === undefined ||
    hashHex === undefined
  ) {
    return false;
  }
  const n = parsePositiveInt(nRaw);
  const r = parsePositiveInt(rRaw);
  const p = parsePositiveInt(pRaw);
  if (n === undefined || r === undefined || p === undefined) {
    return false;
  }
  const salt = parseHex(saltHex);
  const expected = parseHex(hashHex);
  if (salt === undefined || expected === undefined || expected.length !== SCRYPT_KEYLEN) {
    return false;
  }
  // 参数合法但计算量越界（如超 node 默认 maxmem）时 scryptSync 抛错——
  // 与格式非法同收敛为 false（fail-closed），不向调用方泄漏差异
  let actual: Uint8Array;
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function parsePositiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseHex(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) {
    return undefined;
  }
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}
