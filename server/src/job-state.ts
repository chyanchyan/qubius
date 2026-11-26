/**
 * 作业状态文件的共享契约（server 与 deploy/*.sh 共同遵循）。
 *
 * 目的：`deploy.json` / `edge.json` / `secondary.json` 由 TypeScript 与 shell
 * 两侧写入，字段和取值必须一致，避免出现一侧认得、另一侧不认的状态。
 *
 * - 状态词汇：`running` / `success` / `failed`；`secondary.json` 另有 `idle`
 *   表示尚未运行过。
 * - 时间格式：UTC ISO 8601，秒精度 `YYYY-MM-DDTHH:MM:SSZ`（与 shell 的
 *   `date -u +%Y-%m-%dT%H:%M:%SZ` 一致）。读取端仍接受带毫秒的旧值。
 */

export const JOB_STATES = ["running", "success", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = ["success", "failed"] as const;
export type TerminalJobState = (typeof TERMINAL_JOB_STATES)[number];

const JOB_STATE_SET: ReadonlySet<string> = new Set(JOB_STATES);
const TERMINAL_JOB_STATE_SET: ReadonlySet<string> = new Set(TERMINAL_JOB_STATES);

export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && JOB_STATE_SET.has(value);
}

export function isTerminalJobState(value: unknown): value is TerminalJobState {
  return typeof value === "string" && TERMINAL_JOB_STATE_SET.has(value);
}

/** 当前时间，秒精度 UTC ISO；与 shell 侧时间戳格式一致。 */
export function jobTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 是否是本契约认可的时间戳（允许旧数据的毫秒部分）。 */
export function isJobTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
}
