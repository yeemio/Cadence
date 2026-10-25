/**
 * 打印机注册表端口（M1 增量 4-K，Done-when 2）
 *
 * 注册表的存储与发现（操作系统打印机枚举 / server 下发 / 手工配置）是
 * 环境相关动作，由接线层实现；本模块只定义端口形状 + 一个纯内存实现
 * （组合根占位与测试用）。描述符构造即冻结。
 */
import { isPrinterId, type PrinterId } from './print-job.js';
import type { PrintFamily } from './print-port.js';

export interface PrinterDescriptor {
  readonly printerId: PrinterId;
  /** 展示名（站点配置，如车间/产线标签机位） */
  readonly name: string;
  /** 支持的载荷族：pdf / tspl 至少其一 */
  readonly families: readonly PrintFamily[];
  /** 是否在线（接线层探测折算） */
  readonly online: boolean;
}

export interface PrinterRegistryPort {
  /** 全量打印机快照 */
  list(): Promise<readonly PrinterDescriptor[]>;
  /** 按标识取单台；不存在返回 null */
  get(printerId: PrinterId): Promise<PrinterDescriptor | null>;
}

const FAMILIES: readonly PrintFamily[] = ['pdf', 'tspl'];

function isPrintFamily(value: unknown): value is PrintFamily {
  return value === 'pdf' || value === 'tspl';
}

function assertDescriptor(descriptor: PrinterDescriptor): void {
  if (typeof descriptor !== 'object' || descriptor === null) {
    throw new Error('invalid printer descriptor: expected an object');
  }
  if (!isPrinterId(descriptor.printerId)) {
    throw new Error('invalid printer descriptor: printerId must be a valid PrinterId');
  }
  if (typeof descriptor.name !== 'string' || descriptor.name.trim().length === 0 || descriptor.name.length > 128) {
    throw new Error('invalid printer descriptor: name must be a non-empty string of 1~128 chars');
  }
  if (
    !Array.isArray(descriptor.families) ||
    descriptor.families.length === 0 ||
    !descriptor.families.every(isPrintFamily)
  ) {
    throw new Error(`invalid printer descriptor: families must be a non-empty subset of ${FAMILIES.join(' / ')}`);
  }
  if (typeof descriptor.online !== 'boolean') {
    throw new Error('invalid printer descriptor: online must be a boolean');
  }
}

/** 纯内存注册表：构造期整表校验（标识去重）、冻结；查询零副作用 */
export function createInMemoryPrinterRegistry(
  printers: readonly PrinterDescriptor[],
): PrinterRegistryPort {
  if (!Array.isArray(printers)) {
    throw new Error('invalid printer registry: expected an array of printer descriptors');
  }
  const seen = new Set<string>();
  for (const printer of printers) {
    assertDescriptor(printer);
    const key = printer.printerId as string;
    if (seen.has(key)) {
      throw new Error(`invalid printer registry: duplicate printerId '${key}'`);
    }
    seen.add(key);
  }
  const snapshot: readonly PrinterDescriptor[] = Object.freeze(
    printers.map((printer) => Object.freeze({ ...printer, families: Object.freeze([...printer.families]) })),
  );

  return {
    async list(): Promise<readonly PrinterDescriptor[]> {
      return snapshot;
    },
    async get(printerId: PrinterId): Promise<PrinterDescriptor | null> {
      if (!isPrinterId(printerId)) {
        throw new Error('invalid printer registry lookup: printerId must be a valid PrinterId');
      }
      return snapshot.find((printer) => (printer.printerId as string) === (printerId as string)) ?? null;
    },
  };
}
