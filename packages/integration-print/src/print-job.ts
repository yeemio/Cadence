/**
 * 打印任务统一形状（M1 增量 4-K，Done-when 2）
 *
 * PrintJob = { 类型（document/label）、载荷、份数、目标打印机（可空）、
 * 任务号、创建时间 }，构造即冻结（ADR-0003 #4）。
 * kind ↔ payload.family 一一对应：document ↔ pdf，label ↔ tspl。
 *
 * 词汇（ADR-0010 三问）：print / job / document / label / printer 均为
 * 跨行业通用词；品牌化 ID 复用 business-core Brand 机制（ADR-0003 #2）。
 */
import type { Brand } from '@smes/business-core';
import { isPdfDefinition, type PdfDefinition } from './pdf-document.js';

/** 打印任务号（品牌化）：非空、≤128 字符 */
export type PrintJobId = Brand<string, 'PrintJobId'>;

/** 打印机标识（品牌化）：非空、≤128 字符 */
export type PrinterId = Brand<string, 'PrinterId'>;

/** 打印任务类型：单据（PDF 文档族）或标签（TSPL 命令族） */
export type PrintJobKind = 'document' | 'label';

/** 载荷族：pdf = 渲染前的 doc-definition；tspl = 已拼好的命令串 */
export type PrintPayload =
  | { readonly family: 'pdf'; readonly definition: PdfDefinition }
  | { readonly family: 'tspl'; readonly program: string };

export const MAX_PRINT_COPIES = 1000;

const KIND_TO_FAMILY: Record<PrintJobKind, 'pdf' | 'tspl'> = {
  document: 'pdf',
  label: 'tspl',
};

export function createPrintJobId(value: string): PrintJobId {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new Error('invalid print job id: expected a non-empty string of 1~128 chars');
  }
  return value as PrintJobId;
}

export function isPrintJobId(value: unknown): value is PrintJobId {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

export function createPrinterId(value: string): PrinterId {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new Error('invalid printer id: expected a non-empty string of 1~128 chars');
  }
  return value as PrinterId;
}

export function isPrinterId(value: unknown): value is PrinterId {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

export interface PrintJob {
  readonly jobId: PrintJobId;
  readonly kind: PrintJobKind;
  readonly payload: PrintPayload;
  /** 份数：1 ~ MAX_PRINT_COPIES */
  readonly copies: number;
  /** 目标打印机：可空（由端口/队列侧默认路由） */
  readonly targetPrinterId?: PrinterId;
  /** ISO 8601，任务创建时刻 */
  readonly createdAt: string;
}

export interface PrintJobInput {
  readonly jobId: PrintJobId;
  readonly kind: PrintJobKind;
  readonly payload: PrintPayload;
  readonly copies?: number;
  readonly targetPrinterId?: PrinterId;
  readonly createdAt: string;
}

function assertPayload(kind: PrintJobKind, payload: PrintPayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('invalid print job: payload must be an object');
  }
  if (kind !== 'document' && kind !== 'label') {
    throw new Error(`invalid print job: kind must be 'document' or 'label', got ${String(kind)}`);
  }
  const expectedFamily = KIND_TO_FAMILY[kind];
  if (payload.family !== expectedFamily) {
    throw new Error(
      `invalid print job: kind '${kind}' requires payload family '${expectedFamily}', got '${String(payload.family)}'`,
    );
  }
  if (expectedFamily === 'pdf' && !isPdfDefinition((payload as { definition?: unknown }).definition)) {
    throw new Error("invalid print job: payload.definition must be a valid pdf definition (family 'pdf')");
  }
  const program = (payload as { program?: unknown }).program;
  if (expectedFamily === 'tspl' && (typeof program !== 'string' || program.length === 0)) {
    throw new Error("invalid print job: payload.program must be a non-empty tspl command string (family 'tspl')");
  }
}

/** 构造即冻结的打印任务；份数缺省 1 */
export function makePrintJob(input: PrintJobInput): PrintJob {
  const { jobId, kind, payload, targetPrinterId, createdAt } = input;
  const copies = input.copies ?? 1;
  if (!isPrintJobId(jobId)) {
    throw new Error('invalid print job: jobId must be a valid PrintJobId');
  }
  assertPayload(kind, payload);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_PRINT_COPIES) {
    throw new Error(`invalid print job: copies must be an integer within 1~${MAX_PRINT_COPIES}`);
  }
  if (targetPrinterId !== undefined && !isPrinterId(targetPrinterId)) {
    throw new Error('invalid print job: targetPrinterId must be a valid PrinterId when present');
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new Error('invalid print job: createdAt must be an ISO 8601 date-time string');
  }
  return Object.freeze<PrintJob>({
    jobId,
    kind,
    payload,
    copies,
    ...(targetPrinterId === undefined ? {} : { targetPrinterId }),
    createdAt,
  });
}

/** 结构守卫（轻量同款校验，bool 版） */
export function isPrintJob(value: unknown): value is PrintJob {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isPrintJobId(candidate['jobId'])) return false;
  if (candidate['kind'] !== 'document' && candidate['kind'] !== 'label') return false;
  const payload = candidate['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  const payloadRecord = payload as Record<string, unknown>;
  const family = KIND_TO_FAMILY[candidate['kind'] as PrintJobKind];
  if (payloadRecord['family'] !== family) return false;
  if (family === 'pdf' && !isPdfDefinition(payloadRecord['definition'])) return false;
  if (family === 'tspl' && (typeof payloadRecord['program'] !== 'string' || payloadRecord['program'].length === 0)) {
    return false;
  }
  const copies = candidate['copies'];
  if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > MAX_PRINT_COPIES) {
    return false;
  }
  if (candidate['targetPrinterId'] !== undefined && !isPrinterId(candidate['targetPrinterId'])) return false;
  return typeof candidate['createdAt'] === 'string' && !Number.isNaN(Date.parse(candidate['createdAt']));
}
