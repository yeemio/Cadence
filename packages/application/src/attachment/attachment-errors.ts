/**
 * 附件域错误（U3 A13）。与 notifications/issue 同一纪律：application 零框架
 * 业务类，域错误用普通 Error 子类表达，HTTP 状态映射由组合根异常过滤器完成
 * （接线归合流，本组类名即映射登记面）：
 *   AttachmentInputError    -> 400（请求形状/取值非法）
 *   AttachmentNotFoundError -> 404（租户内附件不存在 / 引用已失效）
 *   AttachmentConflictError -> 409（bizId 与记录不一致——防误用他业务附件 id）
 *   AttachmentStorageError  -> 502 语义（对象存储端口失败：对象缺失/IO 失败；
 *                              消息不带任何凭据，文档「勿泄露密钥」）
 */

/** 输入形状/取值非法（HTTP 400）。 */
export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInputError';
  }
}

/** 附件不存在 / 只读引用已失效（HTTP 404；租户内收口不泄漏存在性）。 */
export class AttachmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentNotFoundError';
  }
}

/** 引用归属冲突（HTTP 409）：下载引用的 bizId 与记录不一致。 */
export class AttachmentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentConflictError';
  }
}

/** 对象存储端口失败（网关错误语义）：对象缺失 / 端口读写失败；不含凭据。 */
export class AttachmentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentStorageError';
  }
}
