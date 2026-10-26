/**
 * 图纸只读引用令牌与签发器（P1-e / O5 裁定=复用 attachment HMAC 基座的**模式**）。
 *
 * 裁量写明（任务合同允许"在 drawing 域实现或经端口复用"，此处选域内实现）：
 *  - @smes/application 的 read-reference-tokens 是本仓已实现的 HMAC+TTL 短时
 *    引用基座（INT-005），但其令牌 claims 形状绑定附件对象存储三字段
 *    （target/objectKey/downloadName），drawing 需要的是
 *    (tenant, drawingId, version, viewer, clearance)——结构上无法直接复用；
 *  - pro-pack-tier-edges 禁止 @smes/drawing import @smes/application（专业包
 *    仅依赖 business-core），无法引其 codec；
 *  - 故按同一模式在本包实现同构 codec：令牌形状 `v1.<b64url(claims JSON)>.
 *    <b64url(HMAC-SHA256)>`、HMAC 防篡改、常数时间比较、过期即失效、租户
 *    标识随 claims 签名（跨租户兑现由开门面比对拒绝）。与附件基座的行为
 *    等价性由测试锚定（round-trip/篡改/过期/跨租户）。
 *
 * 两不变量约束（合同 §0 红线，本文件不新增 fileRef 外泄路径）：
 *  - 令牌 claims **不含 fileRef**——只承载"谁能再看哪版"，内容指针仍只在
 *    viewRevision 回执出现；
 *  - 兑现（开门面）仍走 viewRevision 全路径：门禁 + 每次必落查看留痕。
 *
 * 密钥取舍（同附件基座）：签发器实例自持（构造注入或随机生成）——重启后
 * 旧引用失效，与短时效语义一致；部署期接真实对象存储后由其 SDK 预签名取代
 * （INT-007）。
 */
import { createHmac, getRandomValues, timingSafeEqual } from 'node:crypto';

/** 令牌载荷（只读面：不含 fileRef 与任何可写字段）。 */
export interface DrawingReadReferenceClaims {
  /** 签发租户（兑现面与当前租户比对一致才放行）。 */
  readonly tenantId: string;
  readonly drawingId: string;
  readonly version: number;
  /** 原查看者（兑现时以该身份落留痕——引用不匿名）。 */
  readonly viewerId: string;
  /** 原查看者保密许可（兑现时门禁沿用——等级 append-only 不变，恒通过）。 */
  readonly clearance: string;
  /** 过期时刻（epoch 毫秒）。 */
  readonly expiresAtMs: number;
}

/** 查看回执携带的只读引用（形状对齐附件基座 ObjectReadReference）。 */
export interface DrawingReadReference {
  /** 短时只读引用 URL（GET，开门面路径 + token）。 */
  readonly url: string;
  /** 能力凭证本体（URL 尾段）。 */
  readonly token: string;
  /** 过期时间点（ISO-8601）。 */
  readonly expiresAt: string;
  /** 本次有效秒数。 */
  readonly expiresInSeconds: number;
}

/** 只读引用 TTL 缺省（秒）：复制-粘贴转递的可用窗口与短时效的平衡。 */
export const DEFAULT_DRAWING_READ_REFERENCE_TTL_SECONDS = 300;

/** 只读引用 TTL 上限（秒）：承载保密图纸内容指针，取比附件下载更窄的窗口。 */
export const MAX_DRAWING_READ_REFERENCE_TTL_SECONDS = 600;

/** 新签发密钥（32 字节随机）。 */
export function newDrawingReadReferenceSigningKey(): Uint8Array {
  return getRandomValues(new Uint8Array(32));
}

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function signature(key: Uint8Array, payloadEncoded: string): Uint8Array {
  const mac = createHmac('sha256', key);
  mac.update(payloadEncoded, 'utf8');
  return new Uint8Array(mac.digest());
}

/** 编码只读引用令牌（v1.<claims>.<HMAC>）。 */
export function encodeDrawingReadReferenceToken(
  key: Uint8Array,
  claims: DrawingReadReferenceClaims,
): string {
  const payload = toBase64Url(JSON.stringify(claims));
  const sigEncoded = Buffer.from(signature(key, payload)).toString('base64url');
  return `v1.${payload}.${sigEncoded}`;
}

/**
 * 验证令牌：签名不符 / 结构非法 / 已过期 → null（不区分原因，不泄漏存在性）。
 * 时间判断用传入 now（可注入时钟，测试确定性）。
 */
export function verifyDrawingReadReferenceToken(
  key: Uint8Array,
  token: string,
  now: Date,
): DrawingReadReferenceClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let claims: DrawingReadReferenceClaims;
  try {
    claims = JSON.parse(fromBase64Url(parts[1]!)) as DrawingReadReferenceClaims;
  } catch {
    return null;
  }
  if (
    typeof claims?.tenantId !== 'string' ||
    typeof claims?.drawingId !== 'string' ||
    typeof claims?.version !== 'number' ||
    typeof claims?.viewerId !== 'string' ||
    typeof claims?.clearance !== 'string' ||
    typeof claims?.expiresAtMs !== 'number'
  ) {
    return null;
  }
  let expected: Uint8Array;
  try {
    expected = new Uint8Array(Buffer.from(parts[2]!, 'base64url'));
  } catch {
    return null;
  }
  const actual = signature(key, parts[1]!);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (!(now.getTime() < claims.expiresAtMs)) return null; // 过期即失效
  return claims;
}

export interface DrawingReadReferenceSignerOptions {
  /** 签发密钥（默认随机 32 字节——重启后旧引用失效，同附件基座取舍）。 */
  readonly signingKey?: Uint8Array | undefined;
  /** 引用 URL 基址（默认 '/drawing/read-references'，即本域开门面路由）。 */
  readonly baseUrl?: string | undefined;
  /** 时钟（epoch 毫秒；测试注入确定性）。 */
  readonly nowMs?: (() => number) | undefined;
}

/**
 * 只读引用签发器：issue 在查看留痕落账后签发（回执携带）；verify 校验
 * HMAC+TTL（租户比对归开门面——本层不知当前租户）。零框架，组合根构造
 * 注入 DrawingService / 开门面共用同一实例。
 */
export class DrawingReadReferenceSigner {
  private readonly signingKey: Uint8Array;
  private readonly baseUrl: string;
  private readonly nowMs: () => number;

  constructor(options: DrawingReadReferenceSignerOptions = {}) {
    this.signingKey = options.signingKey ?? newDrawingReadReferenceSigningKey();
    this.baseUrl = (options.baseUrl ?? '/drawing/read-references').replace(/\/+$/, '');
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /** 签发（TTL 秒；越界抛错——调用方即服务层/HTTP 解析层，防静默钳制）。 */
  issue(
    tenant: string,
    viewer: { readonly userId: string; readonly clearance: string },
    drawingId: string,
    version: number,
    ttlSeconds: number,
  ): DrawingReadReference {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_DRAWING_READ_REFERENCE_TTL_SECONDS) {
      throw new RangeError(
        `只读引用 TTL 须为 1~${String(MAX_DRAWING_READ_REFERENCE_TTL_SECONDS)} 的整数，得到 ${JSON.stringify(ttlSeconds)}`,
      );
    }
    const expiresAtMs = this.nowMs() + ttlSeconds * 1000;
    const token = encodeDrawingReadReferenceToken(this.signingKey, {
      tenantId: tenant,
      drawingId,
      version,
      viewerId: viewer.userId,
      clearance: viewer.clearance,
      expiresAtMs,
    });
    return {
      url: `${this.baseUrl}/${token}`,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresInSeconds: ttlSeconds,
    };
  }

  /** 验证（HMAC+TTL；无效/过期一律 null，不区分原因）。 */
  verify(token: string): DrawingReadReferenceClaims | null {
    return verifyDrawingReadReferenceToken(this.signingKey, token, new Date(this.nowMs()));
  }
}
