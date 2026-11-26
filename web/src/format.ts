import type { Effort, TokenUsage } from "./api";

/**
 * 对话里的轻量格式化工具。全部是纯函数：时间只读本地时间字段，
 * 因此测试可以用 new Date(2026, 0, 2, ...) 构造出不受运行环境时区影响的输入。
 */

const THOUSAND = 1_000;
const MILLION = 1_000_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 紧凑 token 数：999 原样，1234 → 1.2k，1234567 → 1.2M。 */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < THOUSAND) return String(Math.round(value));

  let divisor = MILLION;
  let suffix = "M";
  if (value < MILLION) {
    divisor = THOUSAND;
    suffix = "k";
  }
  let rounded = Math.round((value / divisor) * 10) / 10;
  /* 999,999 会进到 1000k；此时抬到 M，避免出现四位数的 k。 */
  if (rounded >= THOUSAND && suffix === "k") {
    divisor = MILLION;
    suffix = "M";
    rounded = Math.round((value / divisor) * 10) / 10;
  }
  return `${rounded.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

function parseDate(at?: string): Date | null {
  if (!at) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 本地时区的 MM-DD HH:MM；缺失或无效返回空字符串。 */
export function formatMessageTime(at?: string): string {
  const date = parseDate(at);
  if (!date) return "";
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 本地时区的 YYYY-MM-DD HH:MM:SS（含秒），用作 time 元素的 title。 */
export function formatMessageFullTime(at?: string): string {
  const date = parseDate(at);
  if (!date) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 运行时长：不足 1 小时为 m:ss，达到 1 小时为 h:mm:ss；无效或负数按 0 处理。 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 列表里的时刻（结束时间）：当天只显示 HH:MM，其他日期显示 MM-DD HH:MM。 */
export function formatClockTime(at?: string, now: Date = new Date()): string {
  const date = parseDate(at);
  if (!date) return "";
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** 缺失、非数字或非有限值一律按 0 处理，避免脏数据渲染出 NaN。 */
export function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * 列表/消息里的相对时间；超过一周退回 MM-DD HH:MM。
 * now 可注入，方便测试；未来时间用于定时任务的「下次运行」。
 */
export function formatRelativeTime(at?: string, now = Date.now()): string {
  const date = parseDate(at);
  if (!date) return "";
  const diff = now - date.getTime();
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < MINUTE) return "即将";
    if (ahead < HOUR) return `${Math.max(1, Math.round(ahead / MINUTE))} 分钟后`;
    if (ahead < DAY) return `${Math.max(1, Math.round(ahead / HOUR))} 小时后`;
    return `${Math.max(1, Math.round(ahead / DAY))} 天后`;
  }
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)} 天前`;
  return formatMessageTime(at);
}

/** 确认倒计时：最大到 0，格式 m:ss；超过一小时显示 h:mm:ss。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 定时任务的间隔用人类可读的单位展示，避免出现「每 1440 分钟」。 */
export function formatIntervalMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes % (7 * 1440) === 0) {
    const weeks = minutes / (7 * 1440);
    return weeks === 1 ? "每周" : `每 ${weeks} 周`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "每天" : `每 ${days} 天`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "每小时" : `每 ${hours} 小时`;
  }
  return `每 ${minutes} 分钟`;
}

/** effort 原始值来自接口，界面统一显示中文；括号里保留英文便于对照配置。 */
export const EFFORT_LABEL: Record<Effort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最大",
};

export const EFFORT_DESCRIPTION: Record<Effort, string> = {
  low: "速度最快，适合简单任务",
  medium: "速度和深度平衡",
  high: "默认档，较深入",
  xhigh: "更深入，耗时更长",
  max: "最深入，耗时最长",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort as Effort] ?? effort;
}

export function effortOptionLabel(effort: Effort): string {
  return `${EFFORT_LABEL[effort]} (${effort})`;
}

/** 输入总量 = 非缓存输入 + 缓存读取 + 缓存写入。 */
export function inputTokenTotal(usage: TokenUsage): number {
  return safeTokenCount(usage.input) + safeTokenCount(usage.cacheRead) + safeTokenCount(usage.cacheWrite);
}

/** usage 里至少有一个有限数字时才值得展示 token（旧数据可能是空对象）。 */
export function hasTokenUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  if (!usage) return false;
  return (
    Number.isFinite(usage.input) ||
    Number.isFinite(usage.output) ||
    Number.isFinite(usage.cacheRead) ||
    Number.isFinite(usage.cacheWrite)
  );
}

/** 带千分位的整数，避免依赖运行环境的 Intl 行为。 */
export function groupDigits(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.round(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 可见的 token 标签：↑输入总量 ↓输出量。 */
export function formatUsageLabel(usage: TokenUsage): string {
  return `↑${formatCompactTokens(inputTokenTotal(usage))} ↓${formatCompactTokens(safeTokenCount(usage.output))}`;
}

/** token 明细 title：输入总量 15,586 tokens（非缓存 13,586、缓存读取 2,000、缓存写入 0）· 输出 191 tokens。 */
export function formatUsageTitle(usage: TokenUsage): string {
  const input = safeTokenCount(usage.input);
  const cacheRead = safeTokenCount(usage.cacheRead);
  const cacheWrite = safeTokenCount(usage.cacheWrite);
  const output = safeTokenCount(usage.output);
  return `输入总量 ${groupDigits(input + cacheRead + cacheWrite)} tokens（非缓存 ${groupDigits(input)}、缓存读取 ${groupDigits(cacheRead)}、缓存写入 ${groupDigits(cacheWrite)}）· 输出 ${groupDigits(output)} tokens`;
}
