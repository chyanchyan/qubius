import type { BackgroundTask } from "./api";

/**
 * 后台 shell 任务（curl/wget/pip 等长命令）的纯逻辑。
 *
 * 服务端只把输出尾部交给客户端，这里负责清理 ANSI 转义、取最后一行、
 * 从进度行里解析百分比，并提供排序/文案等展示辅助。全部是纯函数，
 * 不依赖 React/DOM，方便单独测试。
 */

/** 轮询任务输出的间隔（毫秒）。 */
export const TASK_POLL_MS = 1000;

/** CSI、OSC、字符集切换和其余双字符转义。 */
const ANSI_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-_]/g;

/**
 * 进度百分比：支持 `42%`、`42.5%`、`42,5%`。
 *
 * 先用不含 lookbehind 的正则全局匹配（Safari 16.4 以下不支持 lookbehind，
 * 会导致整个 bundle 无法执行），再在匹配处检查前一个字符，排除 `-5%`、
 * `1.2.3%` 这类片段。
 */
const PERCENT_RE = /(\d{1,3}(?:[.,]\d+)?)\s*%/g;

const TASK_STATUS_LABEL: Record<BackgroundTask["status"], string> = {
  running: "进行中",
  completed: "完成",
  failed: "失败",
  stopped: "已停止",
};

/** 任务是否还在跑。 */
export function isTaskActive(task: BackgroundTask): boolean {
  return task.status === "running";
}

/** 任务栏收起时的计数：运行中、已完成、失败。 */
export interface TaskCounts {
  running: number;
  completed: number;
  failed: number;
}

/**
 * 按状态汇总任务数量，供收起状态的任务栏展示。
 *
 * 「已完成」只统计 completed；failed 单独计数，保证收起时也不会漏掉失败任务。
 */
export function countTasks(tasks: BackgroundTask[]): TaskCounts {
  const counts: TaskCounts = { running: 0, completed: 0, failed: 0 };
  for (const task of tasks) {
    if (task.status === "running") counts.running += 1;
    else if (task.status === "completed") counts.completed += 1;
    else if (task.status === "failed") counts.failed += 1;
  }
  return counts;
}

/**
 * 任务用时：startedAt 合法时，从开始算到 endedAt（合法）或 now；否则 0。
 * 负值按 0 处理，避免服务端时间抖动出现负数。
 */
export function taskDurationMs(task: BackgroundTask, now: number): number {
  const started = Date.parse(task.startedAt);
  if (!Number.isFinite(started)) return 0;
  const ended = task.endedAt ? Date.parse(task.endedAt) : Number.NaN;
  const stop = Number.isFinite(ended) ? ended : now;
  if (!Number.isFinite(stop)) return 0;
  return Math.max(0, stop - started);
}

/** 展示名：优先用描述，空描述回退到「后台任务」。 */
export function taskDisplayName(task: BackgroundTask): string {
  const description = task.description?.trim();
  return description || "后台任务";
}

/** 中文状态标签。 */
export function taskStatusLabel(status: BackgroundTask["status"]): string {
  return TASK_STATUS_LABEL[status] ?? status;
}

/**
 * 输出的最后一条非空行。
 *
 * 先去掉 ANSI 颜色/光标转义，再按 `\r`（进度条原地刷新）和 `\n` 切分；
 * 末尾空行或纯空白行会被跳过，取前一条非空内容。空输出返回 ""。
 */
export function latestTaskLine(output: string): string {
  if (!output) return "";
  const plain = output.replace(ANSI_RE, "");
  const lines = plain.split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return line;
  }
  return "";
}

/**
 * 从最后一行解析进度百分比。
 *
 * 支持小数、逗号或点号小数；取最后一个落在 0–100 的百分比，因此
 * `50% 120%` 得到 50，只有 `120%` 时没有 percent。`line` 始终返回清理后的
 * 最后一行。
 */
export function parseTaskProgress(output: string): { percent?: number; line: string } {
  const line = latestTaskLine(output);
  const matches = [...line.matchAll(PERCENT_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const start = match.index ?? 0;
    const before = start > 0 ? line[start - 1] : "";
    // 前面紧邻数字、小数点、逗号或负号：不是独立的百分比。
    if (before && /[\d.,-]/.test(before)) continue;
    const percent = Number.parseFloat(match[1]!.replace(",", "."));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    return { percent, line };
  }
  return { line };
}

/**
 * 展示排序：running 在前；同状态按 startedAt 从新到旧，非法/缺失排在后面；
 * 时间相同或都缺失时用 taskId 稳定兜底。返回新数组，不修改入参。
 */
export function sortTasksForDisplay(tasks: BackgroundTask[]): BackgroundTask[] {
  return [...tasks].sort((a, b) => {
    const activeDiff = Number(isTaskActive(b)) - Number(isTaskActive(a));
    if (activeDiff !== 0) return activeDiff;

    const aStart = parseTime(a.startedAt);
    const bStart = parseTime(b.startedAt);
    if (aStart !== undefined && bStart !== undefined) {
      if (aStart !== bStart) return bStart - aStart;
    } else if (aStart !== undefined) {
      return -1;
    } else if (bStart !== undefined) {
      return 1;
    }

    if (a.taskId === b.taskId) return 0;
    return a.taskId < b.taskId ? -1 : 1;
  });
}

function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
