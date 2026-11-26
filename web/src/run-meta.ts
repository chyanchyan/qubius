import type { Session } from "./api";
import { formatClockTime, formatElapsed } from "./format";

export interface RunMeta {
  /** 会话仍在推进：显示运行时长，调用方据此每秒刷新。 */
  live: boolean;
  /** 右侧主文案：运行中显示已运行时长，落定后显示结束时刻；没有可显示内容时为空。 */
  timing: string;
}

type RunSession = Pick<Session, "phase" | "runStartedAt" | "runEndedAt">;

/**
 * 列表行右侧的时间文案。
 *
 * 运行状态以 phase 为准：即使还残留旧的 runEndedAt（后台子 agent 的通知会在
 * 主轮 result 之后唤醒主 agent 继续跑），只要 phase 仍是活跃状态就继续显示运行时长，
 * 不能再显示“结束”。phase 落定后才使用 runEndedAt。
 */
export function runMeta(session: RunSession, now: number): RunMeta {
  const startedAt = session.runStartedAt ? Date.parse(session.runStartedAt) : Number.NaN;
  if ((session.phase === "running" || session.phase === "needs_input") && Number.isFinite(startedAt)) {
    return { live: true, timing: `运行 ${formatElapsed(now - startedAt)}` };
  }
  const endedAt = session.runEndedAt ? Date.parse(session.runEndedAt) : Number.NaN;
  const timing = session.phase !== "queued" && Number.isFinite(endedAt)
    ? `结束 ${formatClockTime(session.runEndedAt)}`
    : "";
  return { live: false, timing };
}
