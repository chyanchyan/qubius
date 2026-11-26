import { claudeConnection } from "./endpoint.js";

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  detail: string;
}

export interface ProviderTestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
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
  // DeepSeek 等兼容接口需要先规范化 base 和模型名（例如加 [1m]）。
  const connection = claudeConnection(input.baseUrl, input.model);
  const url = `${connection.baseUrl}/v1/messages`;
  const doFetch = deps?.fetch ?? fetch;
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
