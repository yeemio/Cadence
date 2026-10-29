import type { CommandOutcomeView } from '../data/commandClient';

export function ReceiptInspectionHint({ outcome }: { outcome: CommandOutcomeView }) {
  const rows = outcome.committed && Array.isArray(outcome.body?.['receiptInspections']) ? outcome.body['receiptInspections'] as Record<string, unknown>[] : [];
  if (rows.length === 0) return null;
  const labels: Record<string, string> = { created: '已创建来料待检', existing: '已有同来源质检单', unclassified: '未自动建检：来源类别未确定', 'not-created': '未创建来料待检', failed: '来料待检投递失败' };
  return <ul role="status" className="flex flex-col gap-2 text-sm">{rows.map((row) => <li key={String(row['sourceRefId'])} className={row['inspectionId'] ? 'text-emerald-700' : 'text-amber-700'}>
    行 {String(row['lineNo'])}：{labels[String(row['status'])] ?? '请核对来料检状态'}。{row['inspectionId'] ? `质检单：${String(row['inspectionId'])}` : String(row['reason'] ?? '请联系品质核对来源后处理；收货本身已生效。')}
  </li>)}</ul>;
}
