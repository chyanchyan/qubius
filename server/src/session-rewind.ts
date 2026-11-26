import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptItem } from "./types.js";

/** 没有更早 chain 条目时的截断点；永远不是一个真实 uuid。 */
export const ROOT_FORK_POINT = "root";

/** SDK transcript 里的一条主线程 chain 条目（已从 SessionMessage 解析）。 */
export interface ChainEntry {
  uuid: string;
  kind: "user" | "assistant" | "system";
  /** user 且是真实 prompt（含文本或图片，不只是 tool_result）。 */
  prompt: boolean;
  /** prompt 的纯文本（多个 text block 用换行连接）；非 prompt 为 ""。 */
  text: string;
  /** 各个 text block 的原文；用于和本地消息做逐块精确匹配。 */
  texts: string[];
  hasImages: boolean;
}

/**
 * 把 SDK transcript 解析成主线程 chain 条目。
 *
 * 子 agent 的消息（parent_tool_use_id 非空）不属于主线程 chain，直接跳过。
 * user 条目里的 tool_result 只是工具回填，不算 prompt；文本/图片才是用户输入。
 * assistant/system 原样作为 chain 条目，但不参与 prompt 配对。
 */
export function entriesFromSdkMessages(messages: SessionMessage[]): ChainEntry[] {
  const entries: ChainEntry[] = [];
  for (const message of messages) {
    if (!message || message.parent_tool_use_id) continue;
    if (typeof message.uuid !== "string" || !message.uuid) continue;
    const kind: ChainEntry["kind"] = message.type === "assistant"
      ? "assistant"
      : message.type === "system"
        ? "system"
        : "user";
    if (kind === "user") {
      const parsed = parseUserContent(message.message);
      entries.push({
        uuid: message.uuid,
        kind,
        prompt: parsed.prompt,
        text: parsed.prompt ? parsed.text : "",
        texts: parsed.texts,
        hasImages: parsed.hasImages,
      });
      continue;
    }
    entries.push({ uuid: message.uuid, kind, prompt: false, text: "", texts: [], hasImages: false });
  }
  return entries;
}

interface ParsedUserContent {
  prompt: boolean;
  text: string;
  texts: string[];
  hasImages: boolean;
}

/**
 * 解析一条 user 条目的 content：
 * - 字符串按纯文本 prompt；
 * - 数组里收集 text 块、image 块，忽略 tool_result（工具回填不是用户输入）；
 * - 多个 text 块用换行连接（工作流指令是额外的前置 text 块）。
 */
function parseUserContent(message: unknown): ParsedUserContent {
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content === "string") {
    const texts = content.length > 0 ? [content] : [];
    return { prompt: content.length > 0, text: content, texts, hasImages: false };
  }
  if (!Array.isArray(content)) return { prompt: false, text: "", texts: [], hasImages: false };
  const texts: string[] = [];
  let hasImages = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "image") {
      hasImages = true;
    }
  }
  const text = texts.join("\n");
  return { prompt: hasImages || text.length > 0, text, texts, hasImages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 找本地 transcript 里这条用户消息的下标。
 * 只认 user 条目：tool 结果和 assistant 正文不能作为回滚/分叉目标。
 */
export function findUserMessageIndex(messages: TranscriptItem[], messageId: string): number {
  return messages.findIndex((item) => item.role === "user" && item.id === messageId);
}

/** 回滚用：目标消息之前的所有条目（不含目标本身）。 */
export function sliceBefore(messages: TranscriptItem[], index: number): TranscriptItem[] {
  if (index <= 0) return [];
  return messages.slice(0, index);
}

/** 分叉用：目标消息及之前的所有条目（含目标本身）。 */
export function sliceThrough(messages: TranscriptItem[], index: number): TranscriptItem[] {
  if (index < 0) return [];
  return messages.slice(0, index + 1);
}

/**
 * 按 SDK transcript 重新映射本地用户消息的 sdkUuid/forkPoint。
 *
 * 回滚/分叉后 SDK 的 chain uuid 会变（新会话、forkSession 都会重映射），本地
 * 旧指针必须失效重写。做法：把本地用户消息和 SDK 里的 prompt 条目从末尾向前
 * 贪心配对（文本按 text block 逐块精确匹配；本地文本为空时要求是图片 prompt），
 * 为配上的消息写新的 sdkUuid 和"前一条 chain 条目"作为 forkPoint；没有配上的
 * 用户消息删掉旧指针，避免指向已经不存在的 uuid。
 *
 * 返回新的消息数组（未变化的条目对象原样复用）和新的 lastSdkUuid。
 */
export function remapForks(
  messages: TranscriptItem[],
  entries: ChainEntry[],
): { messages: TranscriptItem[]; lastSdkUuid?: string } {
  // 只把真实 prompt 作为配对候选；tool_result / assistant 只参与 forkPoint 计算。
  const prompts: Array<{ entry: ChainEntry; index: number }> = [];
  entries.forEach((entry, index) => {
    if (entry.prompt) prompts.push({ entry, index });
  });

  const next = messages.slice();
  let cursor = prompts.length - 1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role !== "user") continue;
    let matched = -1;
    for (let j = cursor; j >= 0; j -= 1) {
      if (matchesPrompt(prompts[j].entry, item)) {
        matched = j;
        break;
      }
    }
    if (matched < 0) {
      // 没有对应的 SDK 条目：旧指针指向已经不存在的 chain，必须清掉。
      if (item.sdkUuid !== undefined || item.forkPoint !== undefined) {
        const cleaned = { ...item };
        delete cleaned.sdkUuid;
        delete cleaned.forkPoint;
        next[i] = cleaned;
      }
      continue;
    }
    const { entry, index } = prompts[matched];
    cursor = matched - 1;
    next[i] = {
      ...item,
      sdkUuid: entry.uuid,
      forkPoint: index > 0 ? entries[index - 1].uuid : ROOT_FORK_POINT,
    };
  }
  return { messages: next, lastSdkUuid: entries.at(-1)?.uuid };
}

/**
 * 一条本地用户消息和一条 SDK prompt 条目是否对应。
 *
 * 文本必须精确命中某个 text block（或拼接后的整体文本），不能用 endsWith：
 * 工作流指令是额外 text block、会被逐块命中；而 SDK 追加的提醒/后缀不能把
 * 一条不相关的本地消息误配过去。本地文本为空时按图片 prompt 匹配。
 */
function matchesPrompt(entry: ChainEntry, item: TranscriptItem): boolean {
  const text = typeof item.text === "string" ? item.text : "";
  if (!text) return entry.hasImages;
  return entry.text === text || entry.texts.includes(text);
}
