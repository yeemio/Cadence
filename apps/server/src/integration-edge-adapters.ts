/**
 * integration-print / integration-im 边缘适配（M2 后第一增量，接线清单 #10/#18
 * ——cross-module-wiring 预留 sink 接口的真适配实现，main.ts 构造后注入）。
 *
 *  - print sink：wiring 的打印任务形状 → integration-print PrintJob（pdf 文档族）
 *    → createInMemoryPrintPort('pdf') 受理记账。**受理面语义**：printed=true =
 *    PrintPort 受理发回执（任务已记录、有 jobId/submittedAt）；真实设备传输
 *    （USB/TCP/串口）属后续接线增量（integration-print 模块头既定分工）——
 *    到位后替换此端口即可，sink 形状不变。
 *  - IM sink：wiring 的卡片消息形状 → integration-im imCardMessage →
 *    IMessageChannel.send。渠道按环境变量装配（见 createImChannelFromEnv）；
 *    **无外部配置时返回 undefined**——wiring 回落结构化 console 日志降级
 *    （通知式语义不阻塞业务，不因缺企微/飞书配置炸 boot）。
 *
 * IM 环境变量契约（宿主约定；凭据纪律沿用 integration-im：配置只携带
 * ImSecretRef 占位引用，本适配器用 env:VAR_NAME 约定把环境变量当最小凭据仓，
 * 运行时按引用解析值）：
 *   SMES_IM_PLATFORM = wecom | feishu         （缺失/未识别 → console 降级）
 *   wecom:  SMES_IM_WECOM_CORP_ID、SMES_IM_WECOM_AGENT_ID（正整数）、
 *           SMES_IM_WECOM_CORP_SECRET、SMES_IM_WECOM_CALLBACK_TOKEN 必填；
 *           SMES_IM_WECOM_CALLBACK_AES_KEY、SMES_IM_WECOM_API_BASE_URL 可选
 *   feishu: SMES_IM_FEISHU_APP_ID、SMES_IM_FEISHU_APP_SECRET、
 *           SMES_IM_FEISHU_VERIFICATION_TOKEN 必填；
 *           SMES_IM_FEISHU_ENCRYPT_KEY、SMES_IM_FEISHU_API_BASE_URL 可选
 */
import {
  createInMemoryPrintPort,
  createPrintJobId,
  makePrintJob,
  type PrintPayload,
} from '@smes/integration-print';
import {
  FeishuImChannel,
  WecomImChannel,
  feishuImConfig,
  imCardMessage,
  imSecretRef,
  wecomImConfig,
  type IMessageChannel,
  type ImSecretRef,
  type ImTransport,
} from '@smes/integration-im';
import type { ImNotifySink, PrintSubmitSink } from './cross-module-wiring.js';

// ---- print sink（#10） ----

/**
 * integration-print 受理 sink：wiring 打印任务（pdf 文档族载荷）→ makePrintJob
 * （构造期校验：族匹配 + isPdfDefinition）→ in-memory pdf 端口受理发回执。
 * 无效载荷在 makePrintJob 抛错 → wiring 捕获 → printed:false + 拒绝原因。
 */
export function createIntegrationPrintSink(): PrintSubmitSink {
  const port = createInMemoryPrintPort('pdf');
  return {
    submit: async (job) => {
      const printJob = makePrintJob({
        jobId: createPrintJobId(job.jobId),
        kind: 'document',
        // 未知载荷直传：makePrintJob 构造期校验兜底（非 pdf 文档族即抛错拒绝）
        payload: job.payload as PrintPayload,
        copies: job.copies,
        createdAt: job.createdAt,
      });
      const submission = await port.submit(printJob);
      return { jobId: submission.jobId, submittedAt: submission.submittedAt };
    },
  };
}

// ---- IM 渠道装配（#18） ----

/** env:VAR_NAME 引用解析（最小凭据仓约定：环境变量按引用名取值）。 */
function envSecretResolver(env: NodeJS.ProcessEnv): (ref: ImSecretRef) => Promise<string> {
  return async (ref) => {
    if (!ref.ref.startsWith('env:')) {
      throw new Error(`IM 凭据引用须为 env:VAR_NAME 形态，得到 '${ref.ref}'`);
    }
    const value = env[ref.ref.slice('env:'.length)];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`IM 凭据环境变量 '${ref.ref}' 未设置或为空`);
    }
    return value;
  };
}

/** 全局 fetch 的 ImTransport 实现（注入式传输——组合根侧唯一 HTTP 客户端面）。 */
const fetchImTransport: ImTransport = {
  send: async (request) => {
    const init: RequestInit = { method: request.method, headers: { ...request.headers } };
    if (request.method === 'POST') {
      init.body = JSON.stringify(request.body);
    }
    const response = await fetch(request.url, init);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null; // 非 JSON 响应体（网关/代理错误页等）
    }
    return { status: response.status, body };
  },
};

/**
 * 按环境变量装配 IM 渠道；**配置缺失/不完整 → undefined（降级不炸 boot）**。
 * platform 配置了但凭据不全时 console.warn 留痕（部署错误可见，不静默降级）。
 */
export function createImChannelFromEnv(env: NodeJS.ProcessEnv): IMessageChannel | undefined {
  const platform = env['SMES_IM_PLATFORM'];
  if (platform === undefined || platform === 'console' || platform === '') {
    return undefined; // 未配置外部渠道：wiring 回落结构化 console 日志
  }
  const resolveSecret = envSecretResolver(env);
  if (platform === 'wecom') {
    const corpId = env['SMES_IM_WECOM_CORP_ID'];
    const agentIdRaw = env['SMES_IM_WECOM_AGENT_ID'];
    const corpSecret = env['SMES_IM_WECOM_CORP_SECRET'];
    const callbackToken = env['SMES_IM_WECOM_CALLBACK_TOKEN'];
    const agentId = agentIdRaw === undefined ? Number.NaN : Number(agentIdRaw);
    if (
      corpId === undefined ||
      corpId === '' ||
      !Number.isInteger(agentId) ||
      agentId <= 0 ||
      corpSecret === undefined ||
      corpSecret === '' ||
      callbackToken === undefined ||
      callbackToken === ''
    ) {
      console.warn('[smes] SMES_IM_PLATFORM=wecom 但凭据不全（CORP_ID/AGENT_ID/CORP_SECRET/CALLBACK_TOKEN），IM 降级 console 日志');
      return undefined;
    }
    const aesKey = env['SMES_IM_WECOM_CALLBACK_AES_KEY'];
    return new WecomImChannel({
      transport: fetchImTransport,
      resolveSecret,
      config: wecomImConfig({
        corpId,
        agentId,
        corpSecret: imSecretRef('env:SMES_IM_WECOM_CORP_SECRET'),
        callbackToken: imSecretRef('env:SMES_IM_WECOM_CALLBACK_TOKEN'),
        ...(aesKey === undefined || aesKey === ''
          ? {}
          : { callbackEncodingAesKey: imSecretRef('env:SMES_IM_WECOM_CALLBACK_AES_KEY') }),
        ...(env['SMES_IM_WECOM_API_BASE_URL'] === undefined
          ? {}
          : { apiBaseUrl: env['SMES_IM_WECOM_API_BASE_URL'] as string }),
      }),
    });
  }
  if (platform === 'feishu') {
    const appId = env['SMES_IM_FEISHU_APP_ID'];
    const appSecret = env['SMES_IM_FEISHU_APP_SECRET'];
    const verificationToken = env['SMES_IM_FEISHU_VERIFICATION_TOKEN'];
    if (appId === undefined || appId === '' || appSecret === undefined || appSecret === '' || verificationToken === undefined || verificationToken === '') {
      console.warn('[smes] SMES_IM_PLATFORM=feishu 但凭据不全（APP_ID/APP_SECRET/VERIFICATION_TOKEN），IM 降级 console 日志');
      return undefined;
    }
    const encryptKey = env['SMES_IM_FEISHU_ENCRYPT_KEY'];
    return new FeishuImChannel({
      transport: fetchImTransport,
      resolveSecret,
      config: feishuImConfig({
        appId,
        appSecret: imSecretRef('env:SMES_IM_FEISHU_APP_SECRET'),
        verificationToken: imSecretRef('env:SMES_IM_FEISHU_VERIFICATION_TOKEN'),
        ...(encryptKey === undefined || encryptKey === ''
          ? {}
          : { encryptKey: imSecretRef('env:SMES_IM_FEISHU_ENCRYPT_KEY') }),
        ...(env['SMES_IM_FEISHU_API_BASE_URL'] === undefined
          ? {}
          : { apiBaseUrl: env['SMES_IM_FEISHU_API_BASE_URL'] as string }),
      }),
    });
  }
  console.warn(`[smes] SMES_IM_PLATFORM 未识别（${platform}，须为 wecom/feishu），IM 降级 console 日志`);
  return undefined;
}

/**
 * IMessageChannel → wiring ImNotifySink 适配：卡片消息形状（kind/to/title/fields）
 * → imCardMessage（可逆 codec 约束：字段值换行压成空格）→ channel.send。
 * 投递失败返回 ok:false（wiring 通知式合同吞掉，console.warn 留痕在此）。
 */
export function createIntegrationImSink(channel: IMessageChannel): ImNotifySink {
  return {
    send: async (message) => {
      const outbound = imCardMessage({
        to: message.to,
        title: message.title,
        fields: message.fields.map((field) => ({
          name: field.name,
          value: field.value.replace(/\r?\n/g, ' '),
        })),
      });
      const result = await channel.send(outbound);
      if (!result.ok) {
        console.warn(`[smes] IM 渠道投递失败（${result.code}）：${result.message}`);
      }
      return { ok: result.ok };
    },
  };
}

/** 组合根边缘 sink 集合（main.ts 构造注入 buildAppModule）。 */
export interface IntegrationEdgeSinks {
  /** print 受理 sink（integration-print in-memory pdf 端口——受理记账面）。 */
  readonly printSink: PrintSubmitSink;
  /** IM 发送 sink；undefined = 无外部渠道配置（wiring 回落 console 日志降级）。 */
  readonly imSink: ImNotifySink | undefined;
}

/** 按环境装配边缘 sink 集（print 恒受理面；IM 按配置、缺失降级）。 */
export function createIntegrationEdgeSinks(env: NodeJS.ProcessEnv): IntegrationEdgeSinks {
  const channel = createImChannelFromEnv(env);
  return {
    printSink: createIntegrationPrintSink(),
    imSink: channel === undefined ? undefined : createIntegrationImSink(channel),
  };
}
