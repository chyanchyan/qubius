import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AnthropicMessagesRequest,
  AnthropicStreamTranslator,
  buildGeminiRequest,
  estimateInputTokens,
  geminiApiBase,
  geminiModelId,
  toAnthropicResponse,
  type GeminiResponse,
} from "./gemini.js";

/**
 * 本地 Gemini 适配服务。
 *
 * Claude Agent SDK 只能对着 Anthropic Messages 地址发请求，所以 Gemini 接口在
 * 这里多绕一跳：SDK → 127.0.0.1 上的本服务 → Gemini generateContent。
 * 服务只监听回环地址，并要求请求头里的 key 与目标接口配置一致，避免同机其它
 * 进程借用这份密钥。
 */

/** 请求体上限；与主服务的默认请求体上限同一量级。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** 上游错误体只读这么多字节，避免大段 HTML 占内存。 */
const ERROR_BODY_LIMIT = 4_000;
/** count_tokens 是辅助接口；超时后退回本地估算，不拖慢对话。 */
const COUNT_TOKENS_TIMEOUT_MS = 15_000;
const PATH_PATTERN = /^\/gemini\/([^/]+)\/v1\/messages(\/count_tokens)?\/?$/;

export interface GeminiBridgeProvider {
  baseUrl: string;
  apiKey: string;
}

export interface GeminiBridgeDeps {
  /** 按接口配置 id 读取实时配置；不是 Gemini 类型时返回 undefined。 */
  provider: (providerId: string) => GeminiBridgeProvider | undefined;
  /** 测试注入用；默认使用全局 fetch。 */
  fetch?: typeof fetch;
}

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

export class GeminiBridge {
  private readonly server: Server;
  private readonly deps: GeminiBridgeDeps;
  private port: number | undefined;

  constructor(deps: GeminiBridgeDeps) {
    this.deps = deps;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** 绑定随机回环端口；重复调用无副作用。 */
  async start(): Promise<void> {
    if (this.port !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** 给 Claude Agent SDK 用的 ANTHROPIC_BASE_URL。 */
  baseUrl(providerId: string): string {
    if (this.port === undefined) {
      throw new Error("Gemini 适配服务未就绪，请查看服务日志或重启 qubius");
    }
    return `http://127.0.0.1:${this.port}/gemini/${encodeURIComponent(providerId)}`;
  }

  async close(): Promise<void> {
    if (this.port === undefined) return;
    this.port = undefined;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        sendAnthropicError(res, 403, "permission_error", "只允许本机访问");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = PATH_PATTERN.exec(url.pathname);
      if (!match) {
        sendAnthropicError(res, 404, "not_found_error", "未知的 Gemini 适配路径");
        return;
      }
      if (req.method !== "POST") {
        sendAnthropicError(res, 405, "invalid_request_error", "只支持 POST");
        return;
      }
      const providerId = decodeURIComponent(match[1] ?? "");
      const provider = this.deps.provider(providerId);
      if (!provider || !provider.apiKey.trim()) {
        sendAnthropicError(res, 404, "not_found_error", "这个接口配置不存在或不是 Gemini 类型");
        return;
      }
      if (requestKey(req) !== provider.apiKey.trim()) {
        sendAnthropicError(res, 401, "authentication_error", "API key 无效");
        return;
      }
      const body = await readJsonBody(req);
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model) throw new BridgeHttpError(400, "invalid_request_error", "缺少模型名");
      if (match[2]) {
        await this.countTokens(provider, body, model, res);
        return;
      }
      if (body.stream === true) {
        await this.stream(provider, body, model, res);
      } else {
        await this.complete(provider, body, model, res);
      }
    } catch (error) {
      if (error instanceof BridgeHttpError) {
        sendAnthropicError(res, error.status, error.errorType, error.message);
        return;
      }
      console.error("[gemini] 适配请求失败:", error instanceof Error ? error.message : error);
      sendAnthropicError(res, 500, "api_error", "Gemini 适配服务内部错误");
    }
  }

  /** 非流式：一次性拿完整 JSON 再转换。 */
  private async complete(
    provider: GeminiBridgeProvider,
    body: AnthropicMessagesRequest,
    model: string,
    res: ServerResponse,
  ): Promise<void> {
    const built = buildGeminiRequest(body);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const response = await this.fetchUpstream(provider, built.request, model, false, controller.signal)
      .catch(() => undefined);
    if (!response) {
      sendAnthropicError(res, 502, "api_error", "无法连接 Gemini API，请检查接口地址和网络");
      return;
    }
    if (!response.ok) {
      const failure = await upstreamFailure(response, provider.apiKey);
      sendAnthropicError(res, failure.status, failure.errorType, failure.message);
      return;
    }
    let json: GeminiResponse;
    try {
      json = (await response.json()) as GeminiResponse;
    } catch {
      sendAnthropicError(res, 502, "api_error", "Gemini 返回的内容无法解析");
      return;
    }
    if (json.error) {
      const message = redact(json.error.message ?? "未知错误", provider.apiKey);
      sendAnthropicError(res, 502, "api_error", `Gemini 返回错误：${message}`);
      return;
    }
    sendJson(res, 200, toAnthropicResponse(json, model, built.toolNames));
  }

  /** 流式：把 Gemini SSE 逐块翻译成 Anthropic SSE。 */
  private async stream(
    provider: GeminiBridgeProvider,
    body: AnthropicMessagesRequest,
    model: string,
    res: ServerResponse,
  ): Promise<void> {
    const built = buildGeminiRequest(body);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const response = await this.fetchUpstream(provider, built.request, model, true, controller.signal)
      .catch(() => undefined);
    if (!response) {
      sendAnthropicError(res, 502, "api_error", "无法连接 Gemini API，请检查接口地址和网络");
      return;
    }
    if (!response.ok) {
      const failure = await upstreamFailure(response, provider.apiKey);
      sendAnthropicError(res, failure.status, failure.errorType, failure.message);
      return;
    }
    if (!response.body) {
      sendAnthropicError(res, 502, "api_error", "Gemini 没有返回响应内容");
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const translator = new AnthropicStreamTranslator(model, estimateInputTokens(body), built.toolNames);

    try {
      await writeChunk(res, translator.start());
      for await (const data of sseEvents(response.body)) {
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(data) as GeminiResponse;
        } catch {
          continue;
        }
        if (chunk.error) {
          await writeChunk(res, translator.fail(redact(chunk.error.message ?? "Gemini 返回错误", provider.apiKey)));
          break;
        }
        await writeChunk(res, translator.push(chunk));
      }
      await writeChunk(res, translator.finish());
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : "Gemini 流式响应中断";
        try {
          await writeChunk(res, translator.fail(redact(detail, provider.apiKey)));
        } catch {
          // 客户端已经断开，没人接收错误事件了。
        }
      }
    } finally {
      try {
        res.end();
      } catch {
        // 已经结束或连接已关闭。
      }
    }
  }

  /** 把 Anthropic 的 count_tokens 请求转发给 Gemini；失败时退回本地估算。 */
  private async countTokens(
    provider: GeminiBridgeProvider,
    body: AnthropicMessagesRequest,
    model: string,
    res: ServerResponse,
  ): Promise<void> {
    const built = buildGeminiRequest(body);
    const request: Record<string, unknown> = { contents: built.request.contents };
    if (built.request.systemInstruction) request.systemInstruction = built.request.systemInstruction;
    if (built.request.tools) request.tools = built.request.tools;
    const url = `${geminiApiBase(provider.baseUrl)}/models/${encodeURIComponent(geminiModelId(model))}:countTokens`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COUNT_TOKENS_TIMEOUT_MS);
    timer.unref();
    try {
      const response = await this.doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": provider.apiKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
        return;
      }
      const json = (await response.json()) as { totalTokens?: unknown };
      const total = typeof json.totalTokens === "number" && Number.isFinite(json.totalTokens)
        ? json.totalTokens
        : estimateInputTokens(body);
      sendJson(res, 200, { input_tokens: total });
    } catch {
      sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
    } finally {
      clearTimeout(timer);
    }
  }

  private fetchUpstream(
    provider: GeminiBridgeProvider,
    request: ReturnType<typeof buildGeminiRequest>["request"],
    model: string,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const method = stream ? "streamGenerateContent" : "generateContent";
    const url = `${geminiApiBase(provider.baseUrl)}/models/${encodeURIComponent(geminiModelId(model))}:${method}`
      + (stream ? "?alt=sse" : "");
    return this.doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": provider.apiKey,
      },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    return (this.deps.fetch ?? fetch)(url, init);
  }
}

function requestKey(req: IncomingMessage): string {
  const direct = req.headers["x-api-key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJsonBody(req: IncomingMessage): Promise<AnthropicMessagesRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new BridgeHttpError(413, "invalid_request_error", "请求体过大");
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeHttpError(400, "invalid_request_error", "请求体不是合法的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeHttpError(400, "invalid_request_error", "请求体必须是对象");
  }
  return parsed as AnthropicMessagesRequest;
}

interface UpstreamFailure {
  status: number;
  errorType: string;
  message: string;
}

async function upstreamFailure(response: Response, apiKey: string): Promise<UpstreamFailure> {
  const text = await readLimitedText(response, ERROR_BODY_LIMIT);
  let message = text.trim();
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof json.error?.message === "string") message = json.error.message;
  } catch {
    // 不是 JSON 就保留原文。
  }
  message = redact(message, apiKey).slice(0, 1_000) || `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return { status: 401, errorType: "authentication_error", message: "Gemini API key 无效或没有权限" };
  }
  if (response.status === 429) {
    return { status: 429, errorType: "rate_limit_error", message: "Gemini 接口被限流，请稍后重试" };
  }
  if (response.status === 404) {
    return { status: 404, errorType: "not_found_error", message: `Gemini 模型或地址不存在：${message}` };
  }
  return {
    status: response.status >= 400 && response.status <= 599 ? response.status : 502,
    errorType: "api_error",
    message: `Gemini 请求失败（HTTP ${response.status}）：${message}`,
  };
}

/** 读 Gemini SSE：按空行切事件，拼接 event 里所有 data: 行。 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = eventData(raw);
        if (data !== undefined) yield data;
        index = buffer.indexOf("\n\n");
      }
    }
    buffer = `${buffer}${decoder.decode()}`;
    const data = eventData(buffer);
    if (data !== undefined) yield data;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已经结束或已被取消。
    }
  }
}

function eventData(raw: string): string | undefined {
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  return data;
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = limit - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch {
    // 读取中断时保留已经拿到的内容。
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 忽略重复取消。
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** 上游错误体可能回显 key；展示前替换掉。 */
function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("***");
}

/** 写 SSE 片段；缓冲区满时等 drain，避免慢客户端把内存撑大。 */
async function writeChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (!chunk) return;
  if (res.destroyed || res.writableEnded) throw new Error("客户端已断开");
  if (res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(data);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  } catch {
    // 客户端已断开，响应写不出去。
  }
}

/** Anthropic SDK 把错误统一读成 {type:"error", error:{type, message}}。 */
function sendAnthropicError(
  res: ServerResponse,
  status: number,
  errorType: string,
  message: string,
): void {
  sendJson(res, status, { type: "error", error: { type: errorType, message } });
}
