import { createHash, randomBytes } from "node:crypto";

/**
 * Anthropic Messages ⇄ Gemini generateContent 的纯转换层。
 *
 * Claude Agent SDK 只会说 Anthropic Messages；这里把它翻译成 Gemini 原生
 * generateContent 请求，再把 Gemini 的普通/流式响应翻译回 Anthropic 的
 * message 结构和 SSE 事件。网络和鉴权放在 gemini-bridge.ts。
 */

/** Gemini 的 API 地址：默认补 /v1beta，用户已经写到版本路径时原样保留。 */
export function geminiApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = /\/(v1beta|v1|v1alpha)$/.test(path) ? path : `${path}/v1beta`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return `${trimmed}/v1beta`;
  }
}

/** 允许写 `gemini-2.5-pro` 或 `models/gemini-2.5-pro`；URL 里只保留模型名。 */
export function geminiModelId(model: string): string {
  return model.trim().replace(/^models\//, "");
}

export interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  model?: unknown;
  max_tokens?: unknown;
  messages?: unknown;
  system?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  stop_sequences?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
  /** Gemini 3 要求工具调用带上思考签名；我们用官方允许的占位值跳过校验。 */
  thoughtSignature?: string;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  toolConfig?: {
    functionCallingConfig: {
      mode: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: GeminiUsage;
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  error?: { code?: number; message?: string; status?: string };
}

/** 构造 Gemini 请求；同时返回「Gemini 函数名 → Claude Code 原始工具名」的映射。 */
export interface GeminiRequestBuild {
  request: GeminiRequest;
  /** 响应里的 functionCall.name 要映射回原始工具名，Claude Code 才认得。 */
  toolNames: Map<string, string>;
}

export function buildGeminiRequest(body: AnthropicMessagesRequest): GeminiRequestBuild {
  const names = new NameMap();
  const toolUseNames = new Map<string, string>();
  const contents = translateContents(body.messages, toolUseNames, names);
  const tools = translateTools(body.tools, names);
  const system = systemText(body.system);
  const request: GeminiRequest = { contents };
  if (system) request.systemInstruction = { parts: [{ text: system }] };
  if (tools.length > 0) {
    request.tools = [{ functionDeclarations: tools }];
    const toolConfig = translateToolChoice(body.tool_choice, tools, names);
    if (toolConfig) request.toolConfig = toolConfig;
  }
  const generationConfig = translateGeneration(body);
  if (generationConfig) request.generationConfig = generationConfig;
  return { request, toolNames: names.toOriginal };
}

/** Gemini 官方文档给出的跳过思考签名校验的占位值。 */
const THOUGHT_SIGNATURE_PLACEHOLDER = "skip_thought_signature_validator";

function translateContents(
  value: unknown,
  toolUseNames: Map<string, string>,
  names: NameMap,
): GeminiContent[] {
  if (!Array.isArray(value)) return [];
  const contents: GeminiContent[] = [];
  for (const raw of value) {
    if (!isObject(raw)) continue;
    const role = raw.role === "assistant" ? "model" : "user";
    const blocks = typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : Array.isArray(raw.content)
        ? raw.content
        : [];
    const parts: GeminiPart[] = [];
    /** Gemini 3 只在当前回合的第一个 functionCall 上要求签名；同一条消息后续并行调用不重复带。 */
    let firstFunctionCall = true;
    for (const block of blocks) {
      if (!isObject(block)) continue;
      const type = typeof block.type === "string" ? block.type : "";
      if (type === "text") {
        if (typeof block.text === "string" && block.text.length > 0) parts.push({ text: block.text });
      } else if (type === "image" || type === "document") {
        const part = mediaPart(block.source);
        if (part) parts.push(part);
      } else if (type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : "";
        const original = typeof block.name === "string" ? block.name : "";
        if (!original) continue;
        if (id) toolUseNames.set(id, original);
        parts.push({
          functionCall: {
            name: names.toGemini(original),
            args: isObject(block.input) ? block.input : {},
          },
          // Anthropic 的历史里没有 Gemini 的加密思考签名；官方允许用占位值跳过
          // 校验，否则 Gemini 3 会把「当前回合的工具调用缺签名」直接判成 400。
          ...(firstFunctionCall ? { thoughtSignature: THOUGHT_SIGNATURE_PLACEHOLDER } : {}),
        });
        firstFunctionCall = false;
      } else if (type === "tool_result") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const original = toolUseNames.get(id);
        const result = toolResultContent(block.content);
        if (original) {
          const text = block.is_error === true ? `Error: ${result.text}` : result.text;
          parts.push({
            functionResponse: {
              name: names.toGemini(original),
              response: { result: text || "(no output)" },
            },
          });
          parts.push(...result.media);
        } else {
          // 找不到对应的 tool_use（历史被裁剪等）时退化成文本，避免 Gemini
          // 因为 functionResponse.name 没有声明过而直接 400。
          if (result.text) parts.push({ text: `[tool result] ${result.text}` });
          parts.push(...result.media);
        }
      }
      // thinking / redacted_thinking / 服务端工具块在 Gemini 侧没有对应物，丢弃。
    }
    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    // Gemini 对连续的同一角色更宽容，但合并后能少掉一些兼容性问题。
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function translateTools(value: unknown, names: NameMap): GeminiFunctionDeclaration[] {
  if (!Array.isArray(value)) return [];
  const declarations: GeminiFunctionDeclaration[] = [];
  for (const raw of value) {
    if (!isObject(raw)) continue;
    const original = typeof raw.name === "string" ? raw.name : "";
    // Anthropic 的服务端工具（web_search 等）只有 type 没有 input_schema。
    if (!original || !isObject(raw.input_schema)) continue;
    const declaration: GeminiFunctionDeclaration = {
      name: names.toGemini(original),
      parameters: sanitizeSchema(raw.input_schema),
    };
    if (typeof raw.description === "string" && raw.description) {
      declaration.description = raw.description;
    }
    declarations.push(declaration);
  }
  return declarations;
}

function translateToolChoice(
  value: unknown,
  tools: GeminiFunctionDeclaration[],
  names: NameMap,
): GeminiRequest["toolConfig"] | undefined {
  if (tools.length === 0) return undefined;
  if (!isObject(value)) return { functionCallingConfig: { mode: "AUTO" } };
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (type === "any") return { functionCallingConfig: { mode: "ANY" } };
  if (type === "tool" && typeof value.name === "string") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [names.toGemini(value.name)],
      },
    };
  }
  return { functionCallingConfig: { mode: "AUTO" } };
}

function translateGeneration(body: AnthropicMessagesRequest): GeminiRequest["generationConfig"] | undefined {
  const config: NonNullable<GeminiRequest["generationConfig"]> = {};
  if (isFiniteNumber(body.max_tokens) && body.max_tokens > 0) {
    config.maxOutputTokens = Math.floor(body.max_tokens);
  }
  if (isFiniteNumber(body.temperature)) config.temperature = body.temperature;
  if (isFiniteNumber(body.top_p)) config.topP = body.top_p;
  if (isFiniteNumber(body.top_k)) config.topK = body.top_k;
  if (Array.isArray(body.stop_sequences)) {
    const sequences = body.stop_sequences.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (sequences.length > 0) config.stopSequences = sequences;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const block of value) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function mediaPart(source: unknown): GeminiPart | undefined {
  if (!isObject(source)) return undefined;
  if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { inlineData: { mimeType: source.media_type, data: source.data } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return {
      fileData: {
        mimeType: typeof source.media_type === "string" ? source.media_type : "application/octet-stream",
        fileUri: source.url,
      },
    };
  }
  // Anthropic 也允许纯文本文档（type: "text"），直接作为文本部分传入。
  if (source.type === "text" && typeof source.data === "string") {
    return { text: source.data };
  }
  return undefined;
}

function toolResultContent(value: unknown): { text: string; media: GeminiPart[] } {
  if (typeof value === "string") return { text: value, media: [] };
  if (!Array.isArray(value)) return { text: "", media: [] };
  const texts: string[] = [];
  const media: GeminiPart[] = [];
  for (const block of value) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "image" || block.type === "document") {
      const part = mediaPart(block.source);
      if (part) media.push(part);
    }
  }
  return { text: texts.join("\n"), media };
}

/**
 * Gemini 函数声明只接受 OpenAPI 的一个子集；Claude Code 的工具 schema 里
 * 可能有 additionalProperties、$ref 等，直接透传会被 400 拒绝。这里递归裁剪，
 * 保留 Gemini 能理解的类型信息。
 */
const SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minProperties",
  "maxProperties",
]);

function sanitizeSchema(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return { type: "string" };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "const") {
      out.enum = [raw];
    } else if (key === "properties" && isObject(raw)) {
      const properties: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(raw)) properties[name] = sanitizeSchema(schema);
      out.properties = properties;
    } else if (key === "items") {
      out.items = sanitizeSchema(raw);
    } else if (key === "anyOf" && Array.isArray(raw)) {
      out.anyOf = raw.map((item) => sanitizeSchema(item));
    } else if (key === "required" && Array.isArray(raw)) {
      const required = raw.filter((item) => typeof item === "string");
      if (required.length > 0) out.required = required;
    } else if (key === "default") {
      out.default = raw;
    } else if (SCHEMA_KEYS.has(key)) {
      out[key] = raw;
    }
  }
  if (out.properties !== undefined && out.type === undefined) out.type = "object";
  if (Object.keys(out).length === 0) return { type: "string" };
  return out;
}

/** 把工具名规整成 Gemini 允许的形式，并保留反查表。 */
class NameMap {
  readonly toOriginal = new Map<string, string>();
  private readonly toGeminiName = new Map<string, string>();
  private readonly used = new Set<string>();

  toGemini(original: string): string {
    const existing = this.toGeminiName.get(original);
    if (existing) return existing;
    // 冒号不在 Gemini 文档列出的允许字符里，一并换成下划线。
    let base = original.replace(/[^A-Za-z0-9_.-]/g, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    if (base.length > 64) {
      base = `${base.slice(0, 55)}_${createHash("sha1").update(original).digest("hex").slice(0, 8)}`;
    }
    let name = base;
    let suffix = 2;
    while (this.used.has(name)) {
      const tag = `_${suffix}`;
      name = `${base.slice(0, 64 - tag.length)}${tag}`;
      suffix += 1;
    }
    this.used.add(name);
    this.toGeminiName.set(original, name);
    this.toOriginal.set(name, original);
    return name;
  }
}

export interface AnthropicResponseBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  stop_sequence: null;
  usage: AnthropicUsage;
}

/** 非流式响应：Gemini generateContent 的 JSON → Anthropic message。 */
export function toAnthropicResponse(
  json: GeminiResponse,
  model: string,
  names: Map<string, string>,
): AnthropicMessageResponse {
  const candidate = json.candidates?.[0];
  const outcome = partsToBlocks(candidate?.content?.parts ?? [], names);
  const blocks = outcome.blocks;
  if (blocks.length === 0) {
    if (json.promptFeedback?.blockReason) {
      blocks.push({ type: "text", text: blockedText(json.promptFeedback.blockReason) });
    } else {
      const notice = earlyFinishText(candidate?.finishReason);
      if (notice) blocks.push({ type: "text", text: notice });
    }
  }
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: stopReason(candidate?.finishReason, outcome.toolUse),
    stop_sequence: null,
    usage: toAnthropicUsage(json.usageMetadata),
  };
}

function partsToBlocks(
  parts: GeminiPart[],
  names: Map<string, string>,
): { blocks: AnthropicResponseBlock[]; toolUse: boolean } {
  const blocks: AnthropicResponseBlock[] = [];
  let text = "";
  let toolUse = false;
  const flush = (): void => {
    if (!text) return;
    blocks.push({ type: "text", text });
    text = "";
  };
  for (const part of parts) {
    if (part.thought === true) continue;
    if (typeof part.text === "string") {
      text += part.text;
      continue;
    }
    if (part.functionCall && part.functionCall.name) {
      flush();
      const name = names.get(part.functionCall.name) ?? part.functionCall.name;
      blocks.push({
        type: "tool_use",
        id: toolUseId(),
        name,
        input: isObject(part.functionCall.args) ? part.functionCall.args : {},
      });
      toolUse = true;
    }
  }
  flush();
  return { blocks, toolUse };
}

function stopReason(
  finishReason: string | undefined,
  toolUse: boolean,
): AnthropicMessageResponse["stop_reason"] {
  if (toolUse) return "tool_use";
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  return "end_turn";
}

export function toAnthropicUsage(usage: GeminiUsage | undefined): AnthropicUsage {
  const prompt = numberOrZero(usage?.promptTokenCount);
  const cached = numberOrZero(usage?.cachedContentTokenCount);
  return {
    // Gemini 的 promptTokenCount 包含缓存命中；Anthropic 的 input_tokens 不含。
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: numberOrZero(usage?.candidatesTokenCount) + numberOrZero(usage?.thoughtsTokenCount),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export function estimateInputTokens(body: AnthropicMessagesRequest): number {
  try {
    return Math.max(1, Math.round(JSON.stringify(body).length / 4));
  } catch {
    return 1;
  }
}

/**
 * 流式响应的状态机：把 Gemini 的增量 chunk 逐个翻译成 Anthropic SSE。
 * Gemini 的文本是增量下发，函数调用通常在一个 chunk 里完整出现。
 */
export class AnthropicStreamTranslator {
  private readonly messageId = messageId();
  private readonly names: Map<string, string>;
  private index = 0;
  private current: { index: number; kind: "text" } | undefined;
  private sawToolUse = false;
  private finishReason: string | undefined;
  private usage: GeminiUsage = {};
  private ended = false;
  private blockedNotice = false;
  private emitted = false;

  constructor(
    private readonly model: string,
    private readonly estimatedInput: number,
    names: Map<string, string>,
  ) {
    this.names = names;
  }

  start(): string {
    return sse("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.estimatedInput,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  push(chunk: GeminiResponse): string {
    if (chunk.usageMetadata) this.usage = { ...this.usage, ...chunk.usageMetadata };
    let out = "";
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) this.finishReason = candidate.finishReason;
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (part.thought === true) continue;
      if (typeof part.text === "string") {
        if (!part.text) continue;
        out += this.openText();
        this.emitted = true;
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index: this.currentIndex(),
          delta: { type: "text_delta", text: part.text },
        });
        continue;
      }
      if (part.functionCall?.name) {
        out += this.closeCurrent();
        this.emitted = true;
        const index = this.index++;
        const name = this.names.get(part.functionCall.name) ?? part.functionCall.name;
        const input = isObject(part.functionCall.args) ? part.functionCall.args : {};
        out += sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: toolUseId(), name, input: {} },
        });
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        });
        out += sse("content_block_stop", { type: "content_block_stop", index });
        this.sawToolUse = true;
      }
    }
    if (chunk.promptFeedback?.blockReason && !this.blockedNotice) {
      this.blockedNotice = true;
      this.emitted = true;
      out += this.openText();
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.currentIndex(),
        delta: { type: "text_delta", text: blockedText(chunk.promptFeedback.blockReason) },
      });
    }
    return out;
  }

  finish(): string {
    if (this.ended) return "";
    this.ended = true;
    let out = "";
    if (!this.emitted) {
      const notice = earlyFinishText(this.finishReason);
      if (notice) {
        out += this.openText();
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index: this.currentIndex(),
          delta: { type: "text_delta", text: notice },
        });
      }
    }
    out += this.closeCurrent();
    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason(this.finishReason, this.sawToolUse), stop_sequence: null },
      usage: this.finalUsage(),
    });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }

  fail(message: string): string {
    this.ended = true;
    return sse("error", { type: "error", error: { type: "api_error", message } });
  }

  private openText(): string {
    if (this.current) return "";
    const index = this.index++;
    this.current = { index, kind: "text" };
    return sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
  }

  private closeCurrent(): string {
    if (!this.current) return "";
    const index = this.current.index;
    this.current = undefined;
    return sse("content_block_stop", { type: "content_block_stop", index });
  }

  private currentIndex(): number {
    if (!this.current) throw new Error("没有打开的文本块");
    return this.current.index;
  }

  /**
   * message_start 里的输入 token 是本地估算；Gemini 在流末尾给出真实值时再覆盖。
   * 如果整个流都没有 usageMetadata，就不要用 0 覆盖估算值。
   */
  private finalUsage(): Record<string, number> {
    const usage: Record<string, number> = {
      output_tokens: numberOrZero(this.usage.candidatesTokenCount)
        + numberOrZero(this.usage.thoughtsTokenCount),
    };
    if (this.usage.promptTokenCount !== undefined) {
      const computed = toAnthropicUsage(this.usage);
      usage.input_tokens = computed.input_tokens;
      usage.cache_read_input_tokens = computed.cache_read_input_tokens;
      usage.cache_creation_input_tokens = computed.cache_creation_input_tokens;
    }
    return usage;
  }
}

function blockedText(reason: string): string {
  return `（Gemini 拒绝了这次请求：${reason}。）`;
}

/** 没有正文、也不是正常结束时，给用户一句可见的说明，而不是空白回复。 */
function earlyFinishText(reason: string | undefined): string | undefined {
  if (!reason || reason === "STOP" || reason === "MAX_TOKENS") return undefined;
  return `（Gemini 提前结束了回复：${reason}。）`;
}

export function messageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

export function toolUseId(): string {
  return `toolu_${randomBytes(12).toString("hex")}`;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrZero(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}
