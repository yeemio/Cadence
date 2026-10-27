/**
 * 口令哈希（M1 收尾波-③ 真实认证；M2 安全前置批 SP-2 升档）——node:crypto
 * scrypt，内建零依赖。
 *
 * 存储格式（自述格式，验证端只信格式不信来源）：
 *   scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>
 * 参数：N=65536(2^16), r=8, p=1, keylen=64, salt=16 字节随机（SP-2：N 16384→
 * 65536）。N/r/p 逐字入串：调参时旧哈希仍可按串内参数验证（哈希自描述），
 * 渐进重哈希按"串内参数 ≠ 当前参数"判定（见 auth.service.ts login）。
 *
 * maxmem（SP-2，冻结）：内存 128×N×r = 64MiB **超 node 缺省 maxmem 32MiB**
 * ——hashPassword 与 verifyPassword 两路都必须显式传 maxmem，否则 scryptSync
 * 直接抛错；实现取 128MiB 余量（SCRYPT_MAXMEM）。
 *
 * 词汇纪律（ADR-0010）：password/hash/salt 全通用词。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_PREFIX = 'scrypt';
export const SCRYPT_N = 65536;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
/** scryptSync 显式内存上限（128MiB ≥ 64MiB 需求，余量取整档）。 */
export const SCRYPT_MAXMEM = 128 * 1024 * 1024;
/**
 * verify 侧内存预算上界（SP-2 冻结：N=2^20 等价预算）。128×N×r×p 超过
 * 2^30 字节（= N 2^20 @ r=8/p=1 的等价内存）直接 false——防伪造存储串撑爆
 * 内存（fail-closed：显式上界先行拒绝，连 scryptSync 都不进；maxmem 只是
 * node 侧资源护栏，不是语义边界）。
 */
const SCRYPT_VERIFY_MAX_BYTES = 128 * (2 ** 20) * 8;
const SALT_BYTES = 16;

/** 生成口令哈希（每次随机盐——同口令两次哈希不同串）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
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
  // SP-2 防御补强：先按 128×N×r×p 判定内存预算，超上界直接 false（不进
  // scryptSync——防伪造存储串撑爆内存）；try/catch 兜底保留（其余异常收敛同 false）
  if (128 * n * r * p > SCRYPT_VERIFY_MAX_BYTES) {
    return false;
  }
  const salt = parseHex(saltHex);
  const expected = parseHex(hashHex);
  if (salt === undefined || expected === undefined || expected.length !== SCRYPT_KEYLEN) {
    return false;
  }
  // 参数合法但计算出错（防御分支，正常不可达：上界已拦越界参数）时与格式
  // 非法同收敛为 false（fail-closed），不向调用方泄漏差异
  let actual: Uint8Array;
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * 串内参数是否等于当前哈希参数（SP-2 渐进重哈希判定：login 验证通过且本值
 * false → hashPassword(明文) 重哈希落库）。只解析参数段，不触哈希计算。
 */
export function passwordHashMatchesCurrentParams(stored: string): boolean {
  const [prefix, nRaw, rRaw, pRaw] = stored.split('$');
  if (prefix !== SCRYPT_PREFIX || nRaw === undefined || rRaw === undefined || pRaw === undefined) {
    return false;
  }
  const n = parsePositiveInt(nRaw);
  const r = parsePositiveInt(rRaw);
  const p = parsePositiveInt(pRaw);
  return n === SCRYPT_N && r === SCRYPT_R && p === SCRYPT_P;
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
