/**
 * 打印端口：submit / 预览 dry-run + PDF 与标签两族实现口（M1 墑 4-K，Done-when 2）
 *
 * 契约约定（照 integration-scan 端口风格）：
 * - preview 为 dry-run：纯校验 + 载荷回显摘要，**不触达任何设备**、不产生副作用；
 * - submit 触达设备/驱动（真实适配器为异步 I/O），产出发票（PrintSubmission，
 *   冻结快照）；无效任务与族不匹配在两个入口都以抛错表达（fail-fast，
 *   调用方提交前可先 preview 自检）；
 * - 两族实现口：PdfPrintPort（family 'pdf'，单据）与 TsplPrintPort
 *   （family 'tspl'，标签）；真实设备适配器在接线增量装到这两个口之后
 *   （USB / TCP / 串口传输属接线层）。
 * - 份数语义（两层次，二选一，接线层约定）：多份既可编进 TSPL 程序
 *   （PRINT 1 + COPY n-1，见 tspl.ts），也可用 job.copies 驱动适配器整份
 *   重复。程序串对端口不透明，本包不做交叉校验——同一任务两处同时用会
 *   相乘（m × n 张），组合根接线时必须选定其一。
 * - createInMemoryPrintPort 为两族共用的纯内存实现（记录已提交任务），
 *   供测试与组合根占位接线。
 */
import {
  isPrintJob,
  type PrintJob,
  type PrintJobId,
  type PrinterId,
} from './print-job.js';

/** 载荷族：pdf（文档）/ tspl（标签命令） */
export type PrintFamily = 'pdf' | 'tspl';

export interface PrintPreview {
  readonly jobId: PrintJobId;
  readonly family: PrintFamily;
  readonly copies: number;
  /** tspl = 命令行数；pdf = 内容块数（dry-run 不渲染字节） */
  readonly payloadSize: number;
}

export interface PrintSubmission {
  readonly jobId: PrintJobId;
  readonly family: PrintFamily;
  /** ISO 8601，受理时刻 */
  readonly submittedAt: string;
  readonly targetPrinterId?: PrinterId;
}

export class PrintJobInvalidError extends Error {
  constructor(message = 'invalid print job') {
    super(message);
    this.name = 'PrintJobInvalidError';
  }
}

export class PrintPortMismatchError extends Error {
  constructor(family: PrintFamily, jobFamily: string) {
    super(`print port family '${family}' cannot accept a job of family '${jobFamily}'`);
    this.name = 'PrintPortMismatchError';
  }
}

/** 打印端口统一形状 */
export interface PrintPort {
  readonly family: PrintFamily;
  /** 预览 dry-run：校验 + 摘要，不触达设备 */
  preview(job: PrintJob): PrintPreview;
  /** 提交打印：触达设备/驱动，产出发票 */
  submit(job: PrintJob): Promise<PrintSubmission>;
}

/** 文档族实现口（pdfmake 渲染 + PDF 打印适配器装在此口） */
export interface PdfPrintPort extends PrintPort {
  readonly family: 'pdf';
}

/** 标签族实现口（TSPL 命令串 → 标签打印机适配器装在此口） */
export interface TsplPrintPort extends PrintPort {
  readonly family: 'tspl';
}

export interface InMemoryPrintPort extends PrintPort {
  /** 已提交任务（测试/接线占位读回） */
  submittedJobs(): readonly PrintJob[];
}

export interface InMemoryPrintPortOptions {
  /** 时钟注入（毫秒），默认 Date.now；测试可替换 */
  readonly now?: () => number;
}

/** 纯内存打印端口实现：preview 零副作用，submit 记录任务并发票 */
export function createInMemoryPrintPort(
  family: 'pdf',
  options?: InMemoryPrintPortOptions,
): InMemoryPrintPort & { readonly family: 'pdf' };
export function createInMemoryPrintPort(
  family: 'tspl',
  options?: InMemoryPrintPortOptions,
): InMemoryPrintPort & { readonly family: 'tspl' };
export function createInMemoryPrintPort(
  family: PrintFamily,
  options: InMemoryPrintPortOptions = {},
): InMemoryPrintPort {
  const now = options.now ?? Date.now;
  const submitted: PrintJob[] = [];

  function check(job: PrintJob): PrintPreview {
    if (!isPrintJob(job)) {
      throw new PrintJobInvalidError('invalid print job: use makePrintJob to construct it');
    }
    if (job.payload.family !== family) {
      throw new PrintPortMismatchError(family, job.payload.family);
    }
    return {
      jobId: job.jobId,
      family,
      copies: job.copies,
      payloadSize:
        job.payload.family === 'tspl'
          ? job.payload.program.split('\r\n').length
          : job.payload.definition.content.length,
    };
  }

  return {
    family,
    preview(job: PrintJob): PrintPreview {
      return check(job);
    },
    async submit(job: PrintJob): Promise<PrintSubmission> {
      check(job);
      submitted.push(job);
      return Object.freeze<PrintSubmission>({
        jobId: job.jobId,
        family,
        submittedAt: new Date(now()).toISOString(),
        ...(job.targetPrinterId === undefined ? {} : { targetPrinterId: job.targetPrinterId }),
      });
    },
    submittedJobs(): readonly PrintJob[] {
      return submitted;
    },
  };
}
