/**
 * 工具调用摘要：把 SDK 记录的 input JSON 变成一行人话。
 *
 * 对话折叠行用这里的摘要代替原始 JSON（例如 `Bash {"command":"grep ..."}`），
 * 展开后仍显示完整输入和结果。输入解析失败时回退到正则提取或首个非空行的
 * 截断文本，保证任何情况下都有可读内容。
 */

/** 未知工具按这个顺序取首个非空字符串。 */
const GENERIC_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
  "subagent_type",
] as const;

/** 坏 JSON 时按这个顺序从原文里找第一个字符串字段（含部分工具专属字段）。 */
const FALLBACK_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "glob",
  "url",
  "query",
  "description",
  "prompt",
  "subagent_type",
  "shell_id",
  "header",
  "question",
] as const;

/** 这些字段的值按路径处理：去掉 cwd 前缀。 */
const PATH_KEYS = new Set<string>(["file_path", "notebook_path", "path"]);

/** 摘要总长上限（含省略号）。 */
const MAX_SUMMARY = 80;

/** TodoWrite 进行中条目的正文最多展示多少字。 */
const TODO_ACTIVE_LIMIT = 30;

export function summarizeTool(toolName: string, input: string, cwd?: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const record = toolInputRecord(trimmed);
  if (!record) return finish(fallbackSummary(trimmed, cwd));

  let summary = "";
  switch (toolName) {
    case "Bash": {
      const command = stringValue(record.command).replace(/\s+/g, " ").trim();
      summary = command || genericSummary(record, cwd);
      break;
    }
    case "Read": {
      const file = relativePath(stringValue(record.file_path), cwd);
      summary = file ? `${file}${readRangeSuffix(record)}` : genericSummary(record, cwd);
      break;
    }
    case "Edit":
    case "Write": {
      summary = relativePath(stringValue(record.file_path), cwd) || genericSummary(record, cwd);
      break;
    }
    case "MultiEdit": {
      const file = relativePath(stringValue(record.file_path), cwd);
      if (file) {
        const edits = Array.isArray(record.edits) ? record.edits : null;
        summary = edits ? `${file} · ${edits.length} 处` : file;
      } else {
        summary = genericSummary(record, cwd);
      }
      break;
    }
    case "NotebookEdit": {
      summary = relativePath(stringValue(record.notebook_path), cwd) || genericSummary(record, cwd);
      break;
    }
    case "Grep": {
      const pattern = stringValue(record.pattern);
      if (!pattern) {
        summary = genericSummary(record, cwd);
        break;
      }
      // 有 glob 时用 glob 定位，否则退回 path。
      const glob = stringValue(record.glob);
      const location = glob || relativePath(stringValue(record.path), cwd);
      summary = location ? `${pattern} 于 ${location}` : pattern;
      break;
    }
    case "Glob": {
      const pattern = stringValue(record.pattern);
      if (!pattern) {
        summary = genericSummary(record, cwd);
        break;
      }
      const path = relativePath(stringValue(record.path), cwd);
      summary = path ? `${pattern} 于 ${path}` : pattern;
      break;
    }
    case "WebFetch": {
      summary = stringValue(record.url) || genericSummary(record, cwd);
      break;
    }
    case "WebSearch": {
      summary = stringValue(record.query) || genericSummary(record, cwd);
      break;
    }
    case "Task":
    case "Agent": {
      summary =
        stringValue(record.description) ||
        stringValue(record.prompt) ||
        genericSummary(record, cwd);
      break;
    }
    case "TodoWrite": {
      const todos = Array.isArray(record.todos) ? record.todos : null;
      if (!todos) {
        summary = genericSummary(record, cwd);
        break;
      }
      summary = `${todos.length} 项待办`;
      const active = todos.filter(
        (item) => isRecord(item) && item.status === "in_progress",
      );
      if (active.length === 1 && isRecord(active[0])) {
        const content = stringValue(active[0].content);
        if (content) summary += ` · ${truncate(content, TODO_ACTIVE_LIMIT)}`;
      }
      break;
    }
    case "AskUserQuestion": {
      const questions = Array.isArray(record.questions) ? record.questions : [];
      const first = isRecord(questions[0]) ? questions[0] : null;
      summary = first
        ? stringValue(first.header) || stringValue(first.question)
        : "";
      if (!summary) summary = genericSummary(record, cwd);
      break;
    }
    case "BashOutput":
    case "KillShell": {
      summary = stringValue(record.shell_id) || genericSummary(record, cwd);
      break;
    }
    case "ExitPlanMode": {
      summary = "提交计划";
      break;
    }
    default: {
      summary = genericSummary(record, cwd);
      break;
    }
  }
  return finish(summary);
}

/** 把工具输入的 JSON 文本解析成对象；不是 JSON 对象时返回 null。 */
export function toolInputRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 工具耗时：不足 1 秒显示毫秒，否则保留一位小数的秒，分钟级用 m分s秒。 */
export function formatToolDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || (ms as number) < 0) return "";
  const value = ms as number;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(value / 1000);
  return `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function genericSummary(record: Record<string, unknown>, cwd?: string): string {
  for (const key of GENERIC_KEYS) {
    const value = stringValue(record[key]);
    if (!value) continue;
    return PATH_KEYS.has(key) ? relativePath(value, cwd) : value;
  }
  return "";
}

/** Read 的行段后缀：`offset-limit` 区间、只有 offset 的开放区间、只有 limit 的条数。 */
function readRangeSuffix(record: Record<string, unknown>): string {
  const offset = numberValue(record.offset);
  const limit = numberValue(record.limit);
  if (offset !== undefined && limit !== undefined && limit > 0) {
    return `:${offset}-${offset + limit - 1}`;
  }
  if (offset !== undefined) return `:${offset}+`;
  if (limit !== undefined && limit > 0) return ` ×${limit}`;
  return "";
}

/** 去掉 cwd 前缀；值不是 cwd 下的绝对路径时原样返回。 */
function relativePath(value: string, cwd?: string): string {
  if (!value || !cwd) return value;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return value.startsWith(base) ? value.slice(base.length) : value;
}

/** 坏 JSON 回退：正则找第一个关键字段的字符串值，再退回首个非空行。 */
function fallbackSummary(text: string, cwd?: string): string {
  const field = extractField(text);
  if (field) {
    const value = field.value.replace(/\s+/g, " ").trim();
    return PATH_KEYS.has(field.key) ? relativePath(value, cwd) : value;
  }
  return firstLine(text);
}

function extractField(text: string): { key: string; value: string } | null {
  for (const key of FALLBACK_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(text);
    if (!match) continue;
    const value = unescapeJsonString(match[1]).trim();
    if (value) return { key, value };
  }
  return null;
}

/** 处理 JSON 字符串转义，至少覆盖 `\"` 和 `\\`。 */
function unescapeJsonString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    switch (escape[0]) {
      case "u":
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      default:
        return escape;
    }
  });
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : text;
}

/** 压成一行并截到上限（含省略号）。 */
function finish(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  const chars = Array.from(line);
  return chars.length > MAX_SUMMARY
    ? `${chars.slice(0, MAX_SUMMARY - 1).join("")}…`
    : line;
}
