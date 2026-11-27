import { claudeConnection } from "./endpoint.js";
import { geminiApiBase, geminiModelId } from "./gemini.js";
import { systemProxy } from "./system-proxy.js";
import type { ProviderKind } from "./types.js";
import { upstreamFetch } from "./upstream-fetch.js";

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  detail: string;
}

export interface ProviderTestInput {
  /** 缺省按 Anthropic 兼容接口测试。 */
  kind?: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 这套配置勾选了「走系统代理」时为 true。 */
  systemProxy?: boolean;
}

/** 连接测试请求超时；避免设置页在失效地址上卡住。 */
const TIMEOUT_MS = 15_000;
/** 非 2xx 响应只展示前 300 字，避免把整页 HTML 塞进提示。 */
const DETAIL_BODY_LIMIT = 300;
/** 错误响应体最多读这么多字节；超大错误页不再全部进内存。 */
const ERROR_BODY_READ_LIMIT = 2_000;

interface TimeoutSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * 发一个最小的 /v1/messages 请求来验证地址、密钥和模型是否可用。
 * 只做连通性判定，不把 apiKey 放进任何返回文案。
 */
export async function testProvider(
  input: ProviderTestInput,
  deps?: { fetch?: typeof fetch },
): Promise<ProviderTestResult> {
  const missingProxy = missingProxyHint(input, deps);
  if (missingProxy) return missingProxy;
  if (input.kind === "gemini") return testGeminiProvider(input, deps);
  // DeepSeek 等兼容接口需要先规范化 base 和模型名（例如加 [1m]）。
  const connection = claudeConnection(input.baseUrl, input.model);
  const url = `${connection.baseUrl}/v1/messages`;
  const doFetch = deps?.fetch ?? (input.systemProxy ? upstreamFetch : fetch);
  const timeout = timeoutSignal(TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: connection.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        // 不跟随重定向：登录页/网关跳转后的 200 页面并不代表接口可用。
        redirect: "manual",
        signal: timeout.signal,
      });
    } catch (reason) {
      const name = reason instanceof Error ? reason.name : "";
      if (timeout.signal.aborted || name === "TimeoutError" || name === "AbortError") {
        return { ok: false, detail: `连接超时（${TIMEOUT_MS / 1000} 秒），请检查接口地址和网络` };
      }
      return { ok: false, detail: "网络连接失败，请检查接口地址和网络" };
    }

    const status = response.status;
    if (response.ok) {
      // 2xx 不需要响应体；主动取消，避免保持连接或把内容读进内存。
      await discardBody(response);
      return { ok: true, status, detail: "连接正常" };
    }

    // 浏览器在 manual 重定向下可能给出 opaque 响应（status 0）。
    if (status === 0 || (status >= 300 && status < 400)) {
      await discardBody(response);
      return {
        ok: false,
        status: status || undefined,
        detail: "地址配置错误：接口返回了重定向，请检查接口地址",
      };
    }

    // 读取响应体只用于辅助排查；限制字节数，读失败也不影响按状态码分类。
    const text = await readLimitedText(response, ERROR_BODY_READ_LIMIT);

    if (status === 401 || status === 403) {
      return { ok: false, status, detail: "API key 无效或没有权限" };
    }
    if (status === 404) {
      return { ok: false, status, detail: "地址或模型不存在" };
    }
    if (status === 429) {
      return { ok: false, status, detail: "接口可达，但被限流，请稍后重试" };
    }
    // 上游可能在错误体里回显请求 key（或 Bearer 头），展示前先脱敏。
    const snippet = redactSecrets(text.trim(), input.apiKey).slice(0, DETAIL_BODY_LIMIT);
    return {
      ok: false,
      status,
      detail: snippet ? `HTTP ${status}：${snippet}` : `HTTP ${status}`,
    };
  } finally {
    timeout.cleanup();
  }
}

/**
 * Gemini 原生接口的最小连通性测试：generateContent 发一个 ping。
 * Gemini 的无效 key 大多返回 400 + "API key not valid"，需要单独识别。
 */
async function testGeminiProvider(
  input: ProviderTestInput,
  deps?: { fetch?: typeof fetch },
): Promise<ProviderTestResult> {
  const missingProxy = missingProxyHint(input, deps);
  if (missingProxy) return missingProxy;
  const url = `${geminiApiBase(input.baseUrl)}/models/${encodeURIComponent(geminiModelId(input.model))}:generateContent`;
  const doFetch = deps?.fetch ?? (input.systemProxy ? upstreamFetch : fetch);
  const timeout = timeoutSignal(TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": input.apiKey,
        },
        // 不设 maxOutputTokens：2.5 Pro 等模型的思考预算不能为 0，
        // 太小的输出上限反而会被 Gemini 以 400 拒绝。
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        }),
        redirect: "manual",
        signal: timeout.signal,
      });
    } catch (reason) {
      const name = reason instanceof Error ? reason.name : "";
      if (timeout.signal.aborted || name === "TimeoutError" || name === "AbortError") {
        return { ok: false, detail: `连接超时（${TIMEOUT_MS / 1000} 秒），请检查接口地址和网络` };
      }
      return { ok: false, detail: "网络连接失败，请检查接口地址和网络" };
    }

    const status = response.status;
    if (response.ok) {
      await discardBody(response);
      return { ok: true, status, detail: "连接正常" };
    }
    if (status === 0 || (status >= 300 && status < 400)) {
      await discardBody(response);
      return {
        ok: false,
        status: status || undefined,
        detail: "地址配置错误：接口返回了重定向，请检查接口地址",
      };
    }

    const text = await readLimitedText(response, ERROR_BODY_READ_LIMIT);
    let message = text.trim();
    try {
      const json = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof json.error?.message === "string") message = json.error.message;
    } catch {
      // 不是 JSON 就保留原文。
    }
    const snippet = redactSecrets(message, input.apiKey).slice(0, DETAIL_BODY_LIMIT);

    if (status === 401 || status === 403) {
      return { ok: false, status, detail: "API key 无效或没有权限" };
    }
    if (status === 400 && /api[_ ]?key/i.test(snippet)) {
      return { ok: false, status, detail: "API key 无效或没有权限" };
    }
    if (status === 404 || (status === 400 && /not found|not supported|does not exist/i.test(snippet))) {
      return { ok: false, status, detail: "地址或模型不存在" };
    }
    if (status === 429) {
      return { ok: false, status, detail: "接口可达，但被限流，请稍后重试" };
    }
    return {
      ok: false,
      status,
      detail: snippet ? `HTTP ${status}：${snippet}` : `HTTP ${status}`,
    };
  } finally {
    timeout.cleanup();
  }
}

/**
 * 勾选了「走系统代理」但本机没有检测到代理时提前给出可读提示，
 * 避免最终只剩一句「网络连接失败」。注入 fetch 的测试不走代理，不检查。
 */
function missingProxyHint(
  input: ProviderTestInput,
  deps?: { fetch?: typeof fetch },
): ProviderTestResult | undefined {
  if (!input.systemProxy || deps?.fetch || systemProxy()) return undefined;
  return {
    ok: false,
    detail: "已勾选走系统代理，但没有检测到系统代理（检查 Windows Internet 选项或 HTTPS_PROXY 环境变量）",
  };
}

/** 上游错误体可能回显请求 key；详情展示前一律替换成 ***。 */
function redactSecrets(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text
    .split(`Bearer ${apiKey}`)
    .join("***")
    .split(apiKey)
    .join("***");
}

/** 只读错误体前 limit 字节，然后取消流；避免超大错误页占内存。 */
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
      // 已经读完或流已关闭，取消失败无所谓。
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

/** 不需要响应体时主动取消，避免占着连接或继续下载。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 忽略：响应体可能已经被消费或关闭。
  }
}

/** 优先用 AbortSignal.timeout；老运行时退回 AbortController + setTimeout。 */
function timeoutSignal(ms: number): TimeoutSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}
