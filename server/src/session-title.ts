import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import { claudeConnection, claudeEnv } from "./endpoint.js";
import { clip } from "./status.js";
import type { SessionCore } from "./types.js";

/**
 * 会话标题。
 *
 * 新建对话先用用户首条消息的原文做标题（只发图片时退回「新对话」占位），
 * 列表里立刻能看清这条对话是做什么的。首个成功轮次结束后，再把「用户请求 +
 * 助手最终回复」交给一个不启用工具的一次性 agent 总结，生成更贴合实际结果的
 * 标题写回会话。
 */

/** 只发图片、没有文字时的占位标题；生成成功或用户手动改名后清除。 */
export const PROVISIONAL_TITLE = "新对话";

/** 送给标题模型的材料上限：两端各取一段，长请求/长报告不会把请求撑大。 */
const REQUEST_CHARS = 4_000;
const REPLY_CHARS = 4_000;

/** 生成标题最多等这么久；卡住时放弃，下一轮成功后再试。 */
const TITLE_TIMEOUT_MS = 25_000;

/**
 * 新建会话的初始标题：取首条用户消息的第一行，折叠空白。
 *
 * 用原文而不是等首轮总结，列表在会话创建时就显示这次要做什么；首轮结束后
 * 仍会被总结出的标题替换。标题不设长度上限，界面用省略号显示、悬停看全文。
 * 没有文字（只发图片）时退回占位词。
 */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const title = firstLine.replace(/\s+/g, " ").trim();
  if (!title) return PROVISIONAL_TITLE;
  return title;
}

/** 标题模型只做一件事，不需要项目说明和工具。 */
export const TITLE_SYSTEM_PROMPT = [
  "你只负责给一个开发对话拟一个会话标题。",
  "只输出标题本身：不要引号、序号、前缀、解释、句末标点或 Markdown。",
  "标题使用与用户请求相同的语言，尽量不超过 20 个汉字（英文不超过 12 个单词）。",
  "标题要具体说明这次对话实际做了什么；不要用「帮助用户」「完成任务」「修复问题」这类空泛说法。",
].join("\n");

export interface TitleSummaryInput {
  /** 首条用户消息（可能为空：只发了图片）。 */
  request: string;
  /** 本轮助手的最终文字回复。 */
  reply: string;
  providerId: string;
  model: string;
  cwd: string;
  /** 服务关闭或超时时中止这次总结。 */
  signal?: AbortSignal;
}

/** 生成标题的函数；返回原始文本，清洗由调用方完成。 */
export type TitleSummarizer = (input: TitleSummaryInput) => Promise<string | undefined>;

/**
 * 从会话记录里挑出发给标题模型的材料：首条用户请求和本轮最后的助手正文。
 * 思考片段、工具调用和流式残片都不算助手回复。
 */
export function titleInput(session: SessionCore): Omit<TitleSummaryInput, "signal"> | undefined {
  const request = session.messages.find((item) => item.role === "user" && item.text.trim());
  const reply = [...session.messages]
    .reverse()
    .find((item) => item.role === "assistant" && item.kind !== "thinking" && !item.partial && item.text.trim());
  if (!request && !reply) return undefined;
  return {
    request: clip(request?.text ?? "", REQUEST_CHARS),
    reply: clip(reply?.text ?? "", REPLY_CHARS),
    providerId: session.providerId,
    model: session.model,
    cwd: session.cwd,
  };
}

/** 标题请求正文；导出仅供测试检查提示词约定。 */
export function titlePrompt(input: Pick<TitleSummaryInput, "request" | "reply">): string {
  return [
    "用户请求：",
    input.request.trim() || "（用户只发送了图片，没有文字说明）",
    "",
    "助手本轮最后的回复：",
    input.reply.trim() || "（没有文字回复）",
    "",
    "请输出会话标题。",
  ].join("\n");
}

/**
 * 清洗模型返回的标题：取第一行，去掉 Markdown/「标题：」前缀、成对引号和
 * 句末标点，折叠空白。标题不设长度上限，超长时由界面省略显示。
 */
export function cleanGeneratedTitle(raw: string): string | undefined {
  const firstLine = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  let title = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:会话|对话)?标题\s*[:：]\s*/i, "")
    .replace(/^title\s*[:：]\s*/i, "")
    .trim();
  title = title.replace(/^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/g, "");
  title = title.replace(/[。．.!,，、;；:：?？]+$/g, "").trim();
  title = title.replace(/\s+/g, " ");
  if (!title) return undefined;
  if (title === PROVISIONAL_TITLE) return undefined;
  return title;
}

/**
 * 从 SDK 的 result 消息里取出标题模型输出。
 *
 * subtype 为 success 时 result 才是模型正文；接口错误（限流、过载等）同样会
 * 以 success + is_error 的形式带回错误文本，必须当成失败，否则错误信息会被
 * 当成标题永久写死。和 status.ts 判定“本轮失败”的条件保持一致。
 */
export function resultText(message: {
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
}): string | undefined {
  if (message.subtype !== "success" || message.is_error === true) return undefined;
  return typeof message.result === "string" ? message.result : undefined;
}

/**
 * 用 SDK 起一个一次性 agent 来总结标题：和主对话走同一套接口配置/鉴权，
 * 但不加载项目设置、不启用内置工具、不落盘 session。
 */
export function createSdkTitleSummarizer(deps: {
  credential: (providerId: string) => { apiKey: string; baseUrl: string };
}): TitleSummarizer {
  return async (input) => {
    const { apiKey, baseUrl } = deps.credential(input.providerId);
    const connection = claudeConnection(baseUrl, input.model);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
    timer.unref();
    const onAbort = () => abort.abort();
    if (input.signal) {
      if (input.signal.aborted) abort.abort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
    const options: Options = {
      cwd: input.cwd,
      model: connection.model,
      effort: "low",
      maxTurns: 1,
      tools: [],
      permissionMode: "default",
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: { type: "custom", prompt: TITLE_SYSTEM_PROMPT },
      abortController: abort,
      env: claudeEnv(process.env, apiKey, connection),
      stderr: () => {},
    };
    let stream: Query | undefined;
    try {
      stream = query({ prompt: titlePrompt(input), options });
      for await (const message of stream) {
        if (message.type !== "result") continue;
        return resultText(message);
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      // 提前拿到 result 后关闭迭代器；异常路径也要确保子进程收掉。
      stream?.close();
    }
  };
}
