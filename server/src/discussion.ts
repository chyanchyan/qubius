import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import { claudeConnection, claudeEnv } from "./endpoint.js";
import { resultText } from "./session-title.js";
import { clip } from "./status.js";
import type { DiscussionKind, DiscussionParticipant } from "./types.js";

/**
 * 多模型讨论。
 *
 * 会话里第一个模型先回答，后面的模型逐个审阅；只要还有审阅者不一致，就回到
 * 第一个模型答辩/修订，再让所有审阅者复审，直到全部一致或达到轮次上限。最后
 * 由第一个模型整合出最终结论。每个参与者只做一次不带工具的模型调用，所以
 * 讨论不会改动工作区，也不会触发授权确认。
 *
 * dis-prl 模式在这套流程前加一步拆分：第一个模型把请求拆成若干子任务，每个
 * 子任务各跑一遍原流程（互相并行），最后所有模型再对子结论做一次集成讨论。
 */

/** 一场讨论最多几个参与者；防止用户误点出一长串串行调用。 */
export const MAX_DISCUSSION_PARTICIPANTS = 8;
/** 最多几轮“回答 → 审阅 → 答辩 → 复审”；达到上限后仍由第一个模型给结论。 */
export const MAX_DISCUSSION_ROUNDS = 3;
/** 并行讨论最多拆几个子任务；同时限制了子讨论的并发数。 */
export const MAX_DISCUSSION_SUBTASKS = 4;
/** 单次模型调用最多等这么久；卡住时整场讨论失败，用户可以重试。 */
export const DISCUSSION_CALL_TIMEOUT_MS = 180_000;

/** 传给下一次调用的一条讨论发言。 */
export interface DiscussionEntry {
  participant: DiscussionParticipant;
  kind: DiscussionKind;
  round: number;
  text: string;
}

export interface DiscussantRequest {
  participant: DiscussionParticipant;
  kind: DiscussionKind;
  round: number;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
}

/** 单次模型调用；抛错表示这一轮讨论失败。测试里注入假实现。 */
export type Discussant = (request: DiscussantRequest) => Promise<string>;

export const DISCUSSION_KIND_LABEL: Record<DiscussionKind, string> = {
  decompose: "拆分",
  answer: "回答",
  review: "审阅",
  rebuttal: "答辩",
  final: "最终结论",
};

export function discussionSystemPrompt(participant: DiscussionParticipant): string {
  return [
    `你正在参加一场多模型讨论，你的身份是「${participant.name}」（模型 ${participant.model}）。`,
    "请独立、严谨地思考。只输出本轮要求的内容，不要输出寒暄、思考过程标记或多余的前后缀。",
  ].join("\n");
}

export function answerPrompt(topic: string): string {
  return [
    "讨论主题（用户的请求）：",
    topic.trim(),
    "",
    "请给出你的完整回答。",
  ].join("\n");
}

/** 拆分请求：要求第一个模型输出 JSON 字符串数组，方便稳定解析。 */
export function decomposePrompt(topic: string): string {
  return [
    "讨论主题（用户的请求）：",
    topic.trim(),
    "",
    "请判断这个请求是否适合拆成多个互相独立的子任务并行处理。",
    `适合拆分时输出 2-${MAX_DISCUSSION_SUBTASKS} 个子任务；它本身就是一个单一问题时只输出 1 个。`,
    '只输出 JSON 字符串数组，例如 ["子任务一", "子任务二"]，不要输出解释、编号或代码块标记。',
  ].join("\n");
}

/** 子讨论的主题：保留整体请求作为背景，只聚焦当前子任务。 */
export function subtaskTopic(title: string, topic: string): string {
  return [
    "整体请求：",
    topic.trim(),
    "",
    "本次只讨论其中一个子任务：",
    title.trim(),
  ].join("\n");
}

/** 集成讨论的主题：把各子任务的结论交给同一个讨论流程整合。 */
export function integrationTopic(
  topic: string,
  results: Array<{ title: string; conclusion: string; failed?: string }>,
): string {
  const lines = [
    "整体请求：",
    topic.trim(),
    "",
    "以下是拆分后各子任务讨论得到的结论，请把它们整合成一个完整答复：",
  ];
  for (const [index, result] of results.entries()) {
    lines.push("", `【子任务 ${index + 1}：${result.title}】`);
    lines.push(result.failed ? `（这个子任务讨论失败：${result.failed}）` : result.conclusion || "（子任务没有给出结论）");
  }
  return lines.join("\n");
}

/**
 * 解析拆分结果：优先按 JSON 数组，其次兼容“- 条目”“1. 条目”这种列表。
 * 返回空数组表示无法可靠解析，调用方应退回不拆分的普通讨论。
 */
export function parseSubtasks(text: string): string[] {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(body.slice(start, end + 1));
      if (Array.isArray(value)) return normalizeSubtasks(value);
    } catch {
      // 不是合法 JSON，继续尝试按行解析。
    }
  }
  // 只接受真正的列表行，避免把「可以拆成两个子任务：」这类前导说明当成子任务。
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const item = line.match(/^\s*(?:[-*]|\d+[.、)])\s+(.+)$/)?.[1];
    if (item) lines.push(item.trim());
  }
  // 单行散文或只有一条列表通常不是一个可拆分的方案，交给调用方退回普通讨论。
  return lines.length > 1 ? normalizeSubtasks(lines) : [];
}

function normalizeSubtasks(items: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(clip(text, 200));
    if (result.length >= MAX_DISCUSSION_SUBTASKS) break;
  }
  return result;
}

function discussionTranscript(entries: DiscussionEntry[]): string {
  if (entries.length === 0) return "（还没有发言）";
  const body = entries
    .map((entry) => {
      const round = entry.round > 1 ? ` · 第 ${entry.round} 轮` : "";
      return [
        `【${entry.participant.name} · ${DISCUSSION_KIND_LABEL[entry.kind]}${round}】`,
        clip(entry.text, 6_000),
      ].join("\n");
    })
    .join("\n\n");
  // 上下文过长时保留最近的部分，早期的结论通常已经被后续发言覆盖。
  return clip(body, 24_000);
}

export function reviewPrompt(topic: string, entries: DiscussionEntry[]): string {
  return [
    "讨论主题（用户的请求）：",
    topic.trim(),
    "",
    "当前讨论记录：",
    discussionTranscript(entries),
    "",
    "请以审阅者身份检查上面的回答或修订：指出事实错误、遗漏和可以改进的地方；如果你完全同意，也请明确说明同意的理由。",
    "最后一行必须单独输出「裁定：一致」或「裁定：不一致」，不要在这一行加其它字符。",
  ].join("\n");
}

export function rebuttalPrompt(topic: string, entries: DiscussionEntry[]): string {
  return [
    "讨论主题（用户的请求）：",
    topic.trim(),
    "",
    "当前讨论记录：",
    discussionTranscript(entries),
    "",
    "你是第一个发言的模型。审阅者们提出了上面的意见，请逐条回应：合理的意见采纳并修订你的方案，不合理的说明理由。",
    "只输出修订后的方案和必要的回应，不要重复已经达成一致的内容。",
  ].join("\n");
}

export function finalPrompt(topic: string, entries: DiscussionEntry[], agreed: boolean): string {
  return [
    "讨论主题（用户的请求）：",
    topic.trim(),
    "",
    "完整讨论记录：",
    discussionTranscript(entries),
    "",
    agreed
      ? "所有审阅者已经表示一致。请给出最终结论。"
      : "轮次上限已到，部分审阅者仍然有不同意见。请给出最终结论，并明确说明仍未解决的分歧。",
    "最终结论要直接回答用户请求，整合讨论结果；不要重复讨论过程，不要提及“讨论记录”。",
  ].join("\n");
}

/**
 * 从审阅回复里解析裁定。取最后一次出现的「一致/不一致」；没有裁定时按
 * “不一致”处理，宁可多讨论一轮，也不要把没表态当成同意。
 */
export function parseAgreement(text: string): boolean {
  const matches = [...text.matchAll(/裁定\s*[：:]\s*(不\s*一致|一致)/g)];
  const last = matches[matches.length - 1];
  if (!last) return false;
  return last[1] === "一致";
}

/** 用 SDK 起一次性 agent 做一次讨论发言：和标题总结一样不带工具、不落盘。 */
export function createSdkDiscussant(deps: {
  credential: (providerId: string) => { apiKey: string; baseUrl: string };
}): Discussant {
  return async (input) => {
    const { apiKey, baseUrl } = deps.credential(input.participant.providerId);
    const connection = claudeConnection(baseUrl, input.participant.model);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DISCUSSION_CALL_TIMEOUT_MS);
    timer.unref();
    const onAbort = () => abort.abort();
    if (input.signal.aborted) abort.abort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    const options: Options = {
      cwd: input.cwd,
      model: connection.model,
      effort: input.participant.effort,
      maxTurns: 1,
      tools: [],
      permissionMode: "default",
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: { type: "custom", prompt: input.systemPrompt },
      abortController: abort,
      env: claudeEnv(process.env, apiKey, connection),
      stderr: () => {},
    };
    let stream: Query | undefined;
    try {
      stream = query({ prompt: input.prompt, options });
      for await (const message of stream) {
        if (message.type !== "result") continue;
        const text = resultText(message);
        if (!text || !text.trim()) {
          const detail = message.subtype === "success" ? "模型没有返回内容" : "模型调用失败";
          throw new Error(detail);
        }
        return text;
      }
      throw new Error("模型没有返回内容");
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      stream?.close();
    }
  };
}
