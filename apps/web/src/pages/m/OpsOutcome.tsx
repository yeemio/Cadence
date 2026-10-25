/**
 * 命令三分结果反馈（S3 移动作业页共享小件）：postCommand 归一的
 * CommandOutcomeView（committed/rejected/indeterminate）→ 单行反馈。
 * rejected 是业务结果不是传输错误（后端 201 + status:'rejected' 直返），
 * reason 原样带回；传输错误仍走 ApiErrorHint（由各页自行挂接）。
 */
import type { CommandOutcomeView } from '@/data/commandClient';

export function OpsOutcome({ outcome }: { readonly outcome: CommandOutcomeView | null }) {
  if (outcome === null) return null;
  if (outcome.committed) {
    return <p className="text-xs text-emerald-700">已提交。</p>;
  }
  if (outcome.status === 'rejected') {
    return <p className="text-xs text-destructive">被拒绝：{outcome.reason ?? '未知原因'}</p>;
  }
  return <p className="text-xs text-amber-700">结果不确定（{outcome.status}）——请稍后核对后再试。</p>;
}
