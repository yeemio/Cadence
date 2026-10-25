/**
 * 标签打印场景构造器（M1 增量 4-K，Done-when 6）
 *
 * 通用标签形状：二维码 + 若干文本行，产出完整 TSPL 命令串（可直接经
 * 标签族端口提交）。命令序：SIZE → GAP → DIRECTION → CLS → QRCODE →
 * TEXT×n → PRINT 1（+ COPY n-1）。
 *
 * 坐标单位为 dots（TSPL 原生单位）；mm 布局用 mmToDots 换算
 * （dots = mm × dpi / 25.4，203 / 300 / 600 为热敏打印常见 dpi）。
 * 默认文本布局：x = 8 dots，y 自 8 dots 起每行 +30 dots（font "2"）；
 * 显式给定的 xDots / yDots / font 优先生效。
 */
import {
  buildTsplProgram,
  tsplCls,
  tsplCopy,
  tsplDirection,
  tsplGap,
  tsplPrint,
  tsplQrcode,
  tsplSize,
  tsplText,
  type TsplEccLevel,
} from './tspl.js';

/** 毫米 → dots 换算（dpi ∈ {203, 300, 600}，四舍五入） */
export function mmToDots(mm: number, dpi: 203 | 300 | 600): number {
  if (!Number.isFinite(mm) || mm <= 0) {
    throw new Error(`invalid mm value: expected a positive finite number, got ${String(mm)}`);
  }
  return Math.round((mm * dpi) / 25.4);
}

export interface LabelTextLine {
  readonly text: string;
  /** 缺省 8（dots） */
  readonly xDots?: number;
  /** 缺省自 8 起按行序 +30（dots） */
  readonly yDots?: number;
  /** 缺省 "2" */
  readonly font?: string;
}

export interface QrLabelSpec {
  readonly size: { readonly widthMm: number; readonly heightMm: number };
  /** 标签间隙（mm），缺省 2 */
  readonly gapMm?: number;
  /** 打印方向，缺省 1 */
  readonly direction?: 0 | 1;
  readonly qrcode: {
    readonly content: string;
    readonly xDots: number;
    readonly yDots: number;
    readonly cellWidth?: number;
    readonly ecc?: TsplEccLevel;
  };
  /** 至少一行文本（转义语义见 tspl.ts 模块头） */
  readonly lines: readonly LabelTextLine[];
  /** 打印份数（PRINT 1 + COPY n-1 语义，见 tspl.ts），缺省 1 */
  readonly copies?: number;
}

const DEFAULT_LINE_HEIGHT_DOTS = 30;
const DEFAULT_LINE_START_DOTS = 8;

/** 含二维码 + 文本行的标签程序构造器 */
export function buildQrLabelProgram(spec: QrLabelSpec): string {
  if (spec.size === null || typeof spec.size !== 'object') {
    throw new Error('invalid label spec: size is required');
  }
  if (!Array.isArray(spec.lines) || spec.lines.length === 0) {
    throw new Error('invalid label spec: at least one text line is required');
  }
  const copies = spec.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1) {
    throw new Error(`invalid label copies: expected a positive integer, got ${String(copies)}`);
  }

  const commands: string[] = [
    tsplSize(spec.size.widthMm, spec.size.heightMm),
    tsplGap(spec.gapMm ?? 2, 0),
    tsplDirection(spec.direction ?? 1),
    tsplCls(),
    tsplQrcode(spec.qrcode.xDots, spec.qrcode.yDots, spec.qrcode.content, {
      ...(spec.qrcode.cellWidth === undefined ? {} : { cellWidth: spec.qrcode.cellWidth }),
      ...(spec.qrcode.ecc === undefined ? {} : { ecc: spec.qrcode.ecc }),
    }),
  ];

  spec.lines.forEach((line, index) => {
    const xDots = line.xDots ?? DEFAULT_LINE_START_DOTS;
    const yDots = line.yDots ?? DEFAULT_LINE_START_DOTS + index * DEFAULT_LINE_HEIGHT_DOTS;
    commands.push(
      tsplText(xDots, yDots, line.text, {
        ...(line.font === undefined ? {} : { font: line.font }),
      }),
    );
  });

  // COPY n 语义：在已打印 1 张的基础上追加重印 n 张 → 总份数 = 1 + n
  commands.push(tsplPrint(1));
  if (copies > 1) commands.push(tsplCopy(copies - 1));

  return buildTsplProgram(commands);
}
