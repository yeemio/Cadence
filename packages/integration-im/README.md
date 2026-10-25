# @smes/integration-im

企微/飞书 IM 双生态适配层（`IMessageChannel`，M1；ADR-0003 #6 边缘包独占外部 SDK、ADR-0006 企微/飞书容器）。
**零厂商 SDK、零新增运行时依赖**：纯端口 + 可逆映射 + 注入式传输，纯域可测。

## 分层

```
统一端口层（厂商中立，Im* 词汇）
  config.ts          ImSecretRef 凭据占位 + ImSecretResolver 解析端口 + 企微/飞书配置形状
  transport.ts       ImTransport 注入式 HTTP 客户端端口（适配器不依赖具体 fetch 实现）
  message.ts         ImOutboundMessage（文本/卡片）+ 卡片字段行可逆 codec
  inbound.ts         ImInbound（命令/事件）+ 共享文本命令口径（'/' 前缀）
  channel.ts         IMessageChannel 端口（send / receive / 身份绑定）+ ImSendResult
  identity.ts        ImIdentityBinding（IM 用户 ↔ UserId/TenantId，品牌化 ID 复用 business-core）+ 目录端口
  access-token.ts    TransportTokenProvider（两适配器共享）：凭据→令牌交换 + 过期缓存
  jsdk.ts            JsSdkSignatureService 端口 + 默认实现形状（算法 TODO 钩子）
  callback-verify.ts 回调验签纯函数（时间窗 + 字典序规范化 + 注入式哈希）
adapters/（厂商词汇只出现在这里）
  wecom.ts           可逆映射（text/textcard ↔ 统一消息）+ 渠道编排 + gettoken 交换
  feishu.ts          可逆映射（text/interactive 双层 JSON ↔ 统一消息）+ 渠道编排 + tenant_access_token 交换
```

## 装配形状（组合根注入传输/凭据/时钟）

```ts
const channel = new WecomImChannel({
  transport: hostTransport,            // ImTransport 实现（fetch/undici/网关代理均可）
  config: wecomImConfig({
    corpId: 'ww-***',
    agentId: 1000002,
    corpSecret: imSecretRef('secret://wecom/corp-secret'),   // 占位引用，禁硬编码密钥
    callbackToken: imSecretRef('secret://wecom/callback-token'),
  }),
  resolveSecret: hostSecretResolver,   // ImSecretResolver：占位引用 → 运行时凭据值
});
const result = await channel.send(imCardMessage({ to: 'wu-001', title: '工单待报工', fields: [{ name: '工单', value: 'WO-1' }] }));
```

## 刻意留白（TODO 钩子，均有代码内注释）

| 留白 | 理由 |
| --- | --- |
| JS-SDK 签名算法常量（jsdk.ts） | 无真实 corp/app 凭据与 jsapi_ticket，实现即不可对厂商端验证；落常量制造"已验证"假象 |
| 回调验签哈希原语默认实现（callback-verify.ts） | 同上；决策逻辑已实现并测试，哈希经 deps.hash 注入 |
| 企微回调 XML 解析 + AES 解密 | 原生回调是加密 XML；无真实 EncodingAESKey 不可验证，M1 只定 JSON 投影形状 |
| jsapi_ticket 获取端点 | 签名端口输入即含 ticket 凭据形状，获取属真凭据接入阶段 |

## 词汇纪律（ADR-0010）

统一层词汇厂商中立（ImMessage/ImChannel/ImRecipient…）；厂商词汇（corpId/agentId/open_id/
textcard/lark_md…）只出现在 `adapters/` 与配置字段名。入站事件名：通用事件 `im.message.text`、
握手 `*.callback.verification`，厂商透传事件 `wecom.event.*` / `feishu.event.*`。

## 验证

```
pnpm --filter @smes/integration-im typecheck && pnpm --filter @smes/integration-im test && pnpm --filter @smes/integration-im build
npx depcruise packages/integration-im --config .dep-cruiser.cjs
```
