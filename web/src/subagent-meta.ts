import type { Subagent } from "./api";
import { formatCompactTokens, formatElapsed } from "./format";

/**
 * 子任务行上的用量与用时。
 *
 * SDK 通过 task_progress / task_notification 报告累计 token、工具调用次数和
 * 执行时长；字段可能缺失（旧会话、还没收到第一条进度）。运行中的执行时长
 * 只到上一次报告为止，用 usageAt 续到当前时刻，避免每帧重新数墙钟时把
 * 两次运行之间的等待也算进去。
 */

type TokenSource = Pick<Subagent, "tokens">;
type TimingSource = Pick<
  Subagent,
  "status" | "startedAt" | "runStartedAt" | "endedAt" | "durationMs" | "usageAt"
>;

function parseTime(at?: string): number | undefined {
  if (!at) return undefined;
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : undefined;
}

function count(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** 已报告的 token 总量；没有有效值时返回 undefined（而不是 0）。 */
export function subagentTokenTotal(agent: TokenSource): number | undefined {
  const tokens = count(agent.tokens);
  return tokens !== undefined && tokens > 0 ? tokens : undefined;
}

/**
 * 运行时长（毫秒）。优先用 SDK 的执行时长；运行中按上次报告时间续算。
 * 没有用量数据时退回墙钟：当前轮开始（旧数据用首次开始）到结束/现在。
 */
export function subagentElapsedMs(agent: TimingSource, now: number): number | undefined {
  const reported = count(agent.durationMs);
  if (reported !== undefined) {
    if (agent.status !== "running") return reported;
    const at = parseTime(agent.usageAt);
    return at === undefined ? reported : reported + Math.max(0, now - at);
  }
  const start = parseTime(agent.runStartedAt) ?? parseTime(agent.startedAt);
  if (start === undefined) return undefined;
  const end = agent.status === "running" ? now : parseTime(agent.endedAt) ?? now;
  return Math.max(0, end - start);
}

/** 折叠行右侧的紧凑指标，例如「1.2k tok · 2:14」；没有数据时为空字符串。 */
export function subagentMetrics(agent: TokenSource & TimingSource, now: number): string {
  const parts: string[] = [];
  const tokens = subagentTokenTotal(agent);
  if (tokens !== undefined) parts.push(`${formatCompactTokens(tokens)} tok`);
  const elapsed = subagentElapsedMs(agent, now);
  if (elapsed !== undefined && elapsed > 0) parts.push(formatElapsed(elapsed));
  return parts.join(" · ");
}

/** 展开后的明细行：状态、工具调用次数、用时和 token 数。 */
export function subagentStats(agent: Subagent, now: number): string[] {
  const parts: string[] = [];
  const toolUses = count(agent.toolUses);
  if (toolUses !== undefined && toolUses > 0) parts.push(`工具 ${toolUses} 次`);
  const elapsed = subagentElapsedMs(agent, now);
  if (elapsed !== undefined) parts.push(`运行 ${formatElapsed(elapsed)}`);
  const tokens = subagentTokenTotal(agent);
  if (tokens !== undefined) parts.push(`${formatCompactTokens(tokens)} tok`);
  if ((agent.runs ?? 1) > 1) parts.push(`第 ${agent.runs} 轮`);
  return parts;
}
