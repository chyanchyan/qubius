import { proxyUrlForTarget } from "./proxy.js";
import type { ProviderKind, ProxySettings } from "./types.js";
import { fetchUpstream, type UpstreamFetch } from "./upstream-fetch.js";

/**
 * 接口配置的余额查询。
 *
 * 只有服务商公开了余额接口时才能查：目前支持 DeepSeek 的
 * `GET https://api.deepseek.com/user/balance`。Gemini 和 Anthropic 官方
 * 接口都没有余额查询，需要到各自控制台看账单，这里返回“不支持”。
 */

export interface ProviderBalance {
  /** 币种，例如 CNY。 */
  currency: string;
  /** 总余额。服务商以字符串返回，这里保持原样避免浮点误差。 */
  total: string;
  /** 赠送金额；服务商没返回时省略。 */
  granted?: string;
  /** 充值金额；服务商没返回时省略。 */
  toppedUp?: string;
}

export interface ProviderBalanceResult {
  ok: boolean;
  /** 这个接口类型/地址是否提供余额查询能力；false 时 ok 恒为 false。 */
  supported: boolean;
  detail: string;
  balances?: ProviderBalance[];
}

export interface ProviderBalanceInput {
  kind?: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** 全局代理设置；余额接口域名在白名单里时才走代理。 */
  proxy?: ProxySettings;
}

/** 连接余额接口的超时；避免设置页在失效地址上卡住。 */
const TIMEOUT_MS = 15_000;
/** 错误响应只展示前 300 字。 */
const DETAIL_BODY_LIMIT = 300;
/** 响应体最多读这么多字节；超大错误页不再全部进内存。 */
const BODY_READ_LIMIT = 4_000;

interface TimeoutSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * 返回这套配置的余额查询地址；没有公开余额接口时返回 undefined。
 * DeepSeek 的 Anthropic 兼容地址是 `https://api.deepseek.com/anthropic`，
 * 余额接口在站点根路径下，所以只取 origin。
 */
export function balanceEndpoint(kind: ProviderKind, baseUrl: string): string | undefined {
  if (kind !== "anthropic") return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.hostname !== "api.deepseek.com") return undefined;
  return `${url.origin}/user/balance`;
}

/** 前端在缺少密钥时也要知道这套配置本身有没有余额能力。 */
export function supportsBalance(kind: ProviderKind, baseUrl: string): boolean {
  return balanceEndpoint(kind, baseUrl) !== undefined;
}

function unsupportedDetail(kind: ProviderKind): string {
  if (kind === "gemini") {
    return "Gemini 没有余额查询接口；用量和账单请到 Google AI Studio 或 Google Cloud 控制台查看。";
  }
  return "这套接口没有公开的余额查询接口；请到服务商控制台查看余额。";
}

/**
 * 查询一套接口配置的余额。网络/鉴权错误也按正常结果返回，
 * 由前端直接展示；不把 apiKey 放进任何返回文案。
 */
export async function queryProviderBalance(
  input: ProviderBalanceInput,
  deps?: { fetch?: UpstreamFetch; endpoint?: string },
): Promise<ProviderBalanceResult> {
  const kind = input.kind ?? "anthropic";
  const endpoint = deps?.endpoint ?? balanceEndpoint(kind, input.baseUrl);
  if (!endpoint) return { ok: false, supported: false, detail: unsupportedDetail(kind) };

  const proxyUrl = proxyUrlForTarget(endpoint, input.proxy);
  const doFetch = deps?.fetch ?? fetchUpstream;
  const timeout = timeoutSignal(TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        // 不跟随重定向：登录页/网关跳转后的 200 页面并不代表接口可用。
        redirect: "manual",
        signal: timeout.signal,
      }, proxyUrl);
    } catch (reason) {
      const name = reason instanceof Error ? reason.name : "";
      if (timeout.signal.aborted || name === "TimeoutError" || name === "AbortError") {
        return { ok: false, supported: true, detail: `连接超时（${TIMEOUT_MS / 1000} 秒），请检查接口地址和网络` };
      }
      return { ok: false, supported: true, detail: "网络连接失败，请检查接口地址和网络" };
    }

    const status = response.status;
    if (!response.ok) {
      if (status === 0 || (status >= 300 && status < 400)) {
        await discardBody(response);
        return { ok: false, supported: true, detail: "地址配置错误：接口返回了重定向，请检查接口地址" };
      }
      const text = await readLimitedText(response, BODY_READ_LIMIT);
      if (status === 401 || status === 403) {
        return { ok: false, supported: true, detail: "API key 无效或没有权限" };
      }
      if (status === 404) {
        return { ok: false, supported: true, detail: "余额接口不存在，请检查接口地址" };
      }
      // 上游错误体可能回显请求 key，展示前先脱敏。
      const snippet = redactSecrets(text.trim(), input.apiKey).slice(0, DETAIL_BODY_LIMIT);
      return {
        ok: false,
        supported: true,
        detail: snippet ? `HTTP ${status}：${snippet}` : `HTTP ${status}`,
      };
    }

    const text = await readLimitedText(response, BODY_READ_LIMIT);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, supported: true, detail: "余额接口返回的不是 JSON，请检查接口地址" };
    }
    return parseDeepseekBalance(parsed);
  } finally {
    timeout.cleanup();
  }
}

/** DeepSeek 余额结构：`{ is_available, balance_infos: [...] }`。 */
function parseDeepseekBalance(parsed: unknown): ProviderBalanceResult {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, supported: true, detail: "余额接口返回格式无法识别" };
  }
  const record = parsed as Record<string, unknown>;
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos : [];
  const balances: ProviderBalance[] = [];
  for (const info of infos) {
    if (!info || typeof info !== "object") continue;
    const item = info as Record<string, unknown>;
    const currency = asText(item.currency);
    const total = asText(item.total_balance);
    if (!currency || !total) continue;
    const granted = asText(item.granted_balance);
    const toppedUp = asText(item.topped_up_balance);
    balances.push({
      currency,
      total,
      ...(granted ? { granted } : {}),
      ...(toppedUp ? { toppedUp } : {}),
    });
  }
  if (balances.length === 0) {
    return { ok: false, supported: true, detail: "余额接口没有返回可识别的余额信息" };
  }
  const available = record.is_available !== false;
  return {
    ok: true,
    supported: true,
    detail: available ? "账户可用" : "账户不可用：余额可能不足",
    balances,
  };
}

/** 服务商可能用字符串或数字表示金额；统一转成字符串，缺失时返回空串。 */
function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
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

/** 只读响应体前 limit 字节，然后取消流；避免超大错误页占内存。 */
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
