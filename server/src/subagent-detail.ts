import fs from "node:fs";
import { findSubagentTranscript } from "./sdk-files.js";

/**
 * 子 agent 详情：把 Claude Code 写的 sidechain transcript 归一化成前端能直接
 * 渲染的条目列表。
 *
 * transcript 是每行一条 SDK 消息的 JSONL。这里只保留用户提示、assistant 正文、
 * 思考和工具调用/结果；流式增量本来就不落盘，所以每条 assistant 消息就是一次
 * 完整调用。读取按尾部截断，避免一个跑了一小时的大任务把内存和响应撑爆。
 */

export interface SubagentTranscriptEntry {
  id: string;
  kind: "prompt" | "text" | "thinking" | "tool";
  text: string;
  toolName?: string;
  result?: string;
  toolStatus?: "ok" | "error";
}

export interface SubagentTranscript {
  entries: SubagentTranscriptEntry[];
  /** 文件太大或条目太多，只返回了尾部最近的一部分。 */
  truncated: boolean;
}

/** 单次读取的文件尾部上限；再大的任务只展示最近这部分。 */
export const SUBAGENT_READ_BYTES = 4 * 1024 * 1024;
/** 响应里最多保留的条目数；工具输出多时只取最近这些。 */
export const SUBAGENT_MAX_ENTRIES = 200;
/** 单条正文/工具输入/提示的长度上限。 */
export const SUBAGENT_TEXT_CAP = 8_000;
/** 工具结果的长度上限。 */
export const SUBAGENT_RESULT_CAP = 4_000;

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawEntry {
  type?: string;
  message?: { content?: unknown };
}

interface ParseOptions {
  /** 读取时已经从文件中间开始，结果只含尾部。 */
  truncated?: boolean;
  maxEntries?: number;
  maxText?: number;
  maxResult?: number;
}

/** 读取并解析一个子任务的 transcript；找不到记录时返回 undefined。 */
export async function readSubagentTranscript(
  sessionId: string,
  taskId: string,
  configDir?: string,
): Promise<SubagentTranscript | undefined> {
  const file = await findSubagentTranscript(sessionId, taskId, configDir);
  if (!file) return undefined;
  const { text, truncated } = await readTail(file, SUBAGENT_READ_BYTES);
  return parseSubagentTranscript(text, { truncated });
}

/**
 * 把 JSONL 文本解析成详情条目。
 *
 * - 工具结果按 tool_use_id 回填到对应工具条目；找不到调用的孤立结果直接丢弃。
 * - 解析失败的行静默跳过：尾部读取可能从一行中间开始，运行中的文件也可能
 *   正在写最后一行。
 */
export function parseSubagentTranscript(raw: string, options: ParseOptions = {}): SubagentTranscript {
  const maxEntries = options.maxEntries ?? SUBAGENT_MAX_ENTRIES;
  const maxText = options.maxText ?? SUBAGENT_TEXT_CAP;
  const maxResult = options.maxResult ?? SUBAGENT_RESULT_CAP;
  const entries: SubagentTranscriptEntry[] = [];
  const toolIndexes = new Map<string, number>();
  let truncated = options.truncated === true;
  let counter = 0;

  const cap = (value: string, limit: number): string => {
    if (value.length <= limit) return value;
    truncated = true;
    return `${value.slice(0, limit)}\n…（已截断）`;
  };
  const push = (entry: Omit<SubagentTranscriptEntry, "id">): SubagentTranscriptEntry => {
    counter += 1;
    const item: SubagentTranscriptEntry = { id: `e${counter}`, ...entry };
    entries.push(item);
    return item;
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const message = parsed as RawEntry;
    const content = message.message?.content;
    if (message.type === "assistant") {
      if (!Array.isArray(content)) continue;
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Block;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          push({ kind: "thinking", text: cap(block.thinking, maxText) });
        } else if (block.type === "text" && typeof block.text === "string" && block.text) {
          push({ kind: "text", text: cap(block.text, maxText) });
        } else if (block.type === "tool_use") {
          const toolUseId = typeof block.id === "string" ? block.id : "";
          push({
            kind: "tool",
            toolName: typeof block.name === "string" && block.name ? block.name : "工具",
            text: cap(safeJson(block.input), maxText),
          });
          if (toolUseId) toolIndexes.set(toolUseId, entries.length - 1);
        }
      }
      continue;
    }
    if (message.type !== "user") continue;
    if (typeof content === "string") {
      if (content.trim()) push({ kind: "prompt", text: cap(content, maxText) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as Block;
      if (block.type === "tool_result") {
        const index = typeof block.tool_use_id === "string"
          ? toolIndexes.get(block.tool_use_id)
          : undefined;
        if (index === undefined) continue;
        const tool = entries[index];
        tool.result = cap(resultText(block.content), maxResult);
        tool.toolStatus = block.is_error === true ? "error" : "ok";
      } else if (block.type === "text" && typeof block.text === "string" && block.text) {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) push({ kind: "prompt", text: cap(texts.join("\n"), maxText) });
  }

  if (entries.length > maxEntries) {
    truncated = true;
    /* 尾部是新步骤，开头的提示说明这个子任务被要求做什么；截断时两头的
       优先信息都保留，中间只留最近的部分。 */
    const firstPrompt = maxEntries > 0 ? entries.find((item) => item.kind === "prompt") : undefined;
    const keepTail = maxEntries - (firstPrompt ? 1 : 0);
    const tail = keepTail > 0 ? entries.slice(-keepTail) : [];
    return { entries: firstPrompt ? [firstPrompt, ...tail] : tail, truncated };
  }
  return { entries, truncated };
}

/** 工具输入按原始 JSON 文本保存，前端会再按需格式化。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

/** 工具结果可能是字符串、内容块数组或单个块；只取其中的文本。 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const block = item as Block;
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "image") return "[图片]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const block = content as Block;
    if (typeof block.text === "string") return block.text;
  }
  return "";
}

/** 读取文件尾部最多 limit 字节；文件小于上限时全量读取。 */
async function readTail(
  file: string,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const stat = await fs.promises.stat(file);
  const start = Math.max(0, stat.size - limit);
  const length = stat.size - start;
  if (length <= 0) return { text: "", truncated: false };
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8", 0, bytesRead), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
