/**
 * 定时器端口 + 默认实现 + 确定性假时钟（超时自动迁移的时间机制，端口注入）。
 *
 * 引擎是纯域（零 IO）：真实定时器不内建，通过 ApprovalTimerPort 注入——运行时
 * 缺省用宿主 setTimeout（DEFAULT_TIMER_PORT），测试与确定性场景注入假时钟
 * （createFakeTimerPort）。假时钟本身也是纯内存对象（不触真实时间），随包导出
 * 供下游（business-store / 组合根）测试复用。
 *
 * 端口语义合同（运行时依赖，违约由运行时的防御性检查兜底）：
 * - schedule(delayMs, onFire)：delayMs 毫秒后调用一次 onFire，返回不透明句柄；
 * - cancel(handle)：作废未触发的定时器；对已触发/已取消句柄重复 cancel 是无操作；
 * - onFire 回调内同步 schedule / cancel 均合法（假时钟在同一 advance 内正确处理链式触发）。
 *
 * 注意（默认端口）：未触发的宿主 setTimeout 会挂住 Node 事件循环；带 autoAfterMs
 * 配置的运行时不再使用时应调用 stop() 释放（见 runtime.ts）。
 */
export type ApprovalTimerHandle = object | number;

export interface ApprovalTimerPort {
  schedule(delayMs: number, onFire: () => void): ApprovalTimerHandle;
  cancel(handle: ApprovalTimerHandle): void;
}

/** 默认端口：宿主 setTimeout / clearTimeout（Node 与浏览器同形 API）。 */
export const DEFAULT_TIMER_PORT: ApprovalTimerPort = {
  schedule: (delayMs, onFire) => setTimeout(onFire, delayMs),
  cancel: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** 假时钟：ApprovalTimerPort 的确定性实现（测试/单进程演示用，纯内存）。 */
export interface FakeApprovalTimerPort extends ApprovalTimerPort {
  /**
   * 虚拟时钟推进 ms 毫秒：按触发时刻（同刻按注册序）逐个触发到期定时器；
   * 触发过程中新排定/取消的定时器在剩余窗口内继续生效（支持链式自动迁移）。
   */
  advance(ms: number): void;
  /** 尚未触发且未取消的定时器数（孤儿定时器断言用）。 */
  pending(): number;
  /** 虚拟当前时刻（毫秒，从 0 起）。 */
  nowMs(): number;
}

interface FakeTimer {
  fireAt: number;
  seq: number;
  onFire: () => void;
  canceled: boolean;
  fired: boolean;
}

export function createFakeTimerPort(): FakeApprovalTimerPort {
  let now = 0;
  let seq = 0;
  const timers: FakeTimer[] = [];

  const pickNextDue = (target: number): FakeTimer | undefined => {
    let due: FakeTimer | undefined;
    for (const timer of timers) {
      if (timer.canceled || timer.fired || timer.fireAt > target) continue;
      if (due === undefined || timer.fireAt < due.fireAt || (timer.fireAt === due.fireAt && timer.seq < due.seq)) {
        due = timer;
      }
    }
    return due;
  };

  return {
    schedule: (delayMs, onFire) => {
      if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error(`invalid timer delay: expected a finite ms >= 0, got ${String(delayMs)}`);
      }
      seq += 1;
      const timer: FakeTimer = { fireAt: now + delayMs, seq, onFire, canceled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      const timer = timers.find((t) => t === (handle as unknown as FakeTimer));
      if (timer !== undefined) timer.canceled = true;
    },
    advance: (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        throw new Error(`invalid advance: expected a finite ms >= 0, got ${String(ms)}`);
      }
      const target = now + ms;
      for (;;) {
        const due = pickNextDue(target);
        if (due === undefined) break;
        if (due.fireAt > now) now = due.fireAt;
        due.fired = true;
        due.onFire();
      }
      now = target;
    },
    pending: () => timers.filter((t) => !t.canceled && !t.fired).length,
    nowMs: () => now,
  };
}
