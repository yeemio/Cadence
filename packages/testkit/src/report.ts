/**
 * 文本报告格式化：每场景 pass/fail + diff 明细 + 汇总（CLI stdout 用）。
 */
import type { DiffEntry } from './comparator/comparator.js';
import type { ReconcileReport, ScenarioResult } from './harness.js';

function formatDiffLine(diff: DiffEntry): string {
  const parts: string[] = [`    ${diff.path}:`];
  if (diff.expected === undefined && diff.actual === undefined && diff.note !== undefined) {
    parts.push(diff.note);
    return parts.join(' ');
  }
  if (diff.kind === 'missing') {
    parts.push(`期望 ${diff.expected ?? '?'}`);
  } else if (diff.kind === 'unexpected') {
    parts.push(`实际 ${diff.actual ?? '?'}`);
  } else if (diff.kind === 'shape') {
    parts.push(diff.note ?? '形状不符');
    if (diff.actual !== undefined) {
      parts.push(`实际 ${diff.actual}`);
    }
  } else {
    parts.push(`期望 ${diff.expected ?? '?'} 实际 ${diff.actual ?? '?'}`);
  }
  if (diff.note !== undefined && diff.kind !== 'shape') {
    parts.push(`（${diff.note}）`);
  }
  return parts.join(' ');
}

function formatResult(result: ScenarioResult): readonly string[] {
  const status = result.passed ? 'PASS' : 'FAIL';
  const meta: string[] = [`${status} ${result.name} (${result.durationMs}ms)`];
  if (result.recordedAt !== null) {
    meta.push(`参考录制于 ${result.recordedAt}`);
  } else {
    meta.push('参考未录制');
  }
  const lines = [meta.join(' · ')];
  if (result.error !== undefined) {
    lines.push(`    目标调用失败：${result.error}`);
  }
  for (const diff of result.diffs) {
    lines.push(formatDiffLine(diff));
  }
  return lines;
}

/** 全量报告文本（结果行 + diff 明细 + 汇总行）。 */
export function formatTextReport(report: ReconcileReport): string {
  const lines: string[] = [];
  for (const result of report.results) {
    lines.push(...formatResult(result));
  }
  lines.push('------');
  lines.push(`对账汇总：${report.results.length} 场景 · ${report.passedCount} 通过 · ${report.failedCount} 失败`);
  return lines.join('\n');
}
