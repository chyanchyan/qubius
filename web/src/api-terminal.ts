import { readApiToken, UNAUTHORIZED_EVENT } from "./api";
import {
  terminalCreateBody,
  terminalInputBody,
  terminalResizeBody,
} from "./terminal-protocol";

/**
 * 开发机命令行接口：普通 HTTP，不用 WebSocket。
 * 公网入口套了 Caddy Basic 认证，而 Safari 的 WebSocket 握手不带 Basic 凭据；
 * 普通 fetch/SSE 会正常带上认证，iPhone 上也能用。
 */

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
}

function authHeaders(): Record<string, string> {
  const token = readApiToken();
  return token ? { "X-Qubius-Token": token } : {};
}

function notifyUnauthorized(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

async function failure(response: Response): Promise<Error> {
  if (response.status === 401) notifyUnauthorized();
  let message = "";
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      message = (data as { error: string }).error;
    }
  } catch {
    // 代理错误页不是 JSON。
  }
  return new Error(message || `命令行请求失败（${response.status}）`);
}

async function postJson(url: string, body: string, method = "POST"): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body,
  });
  if (!response.ok) throw await failure(response);
}

export async function createTerminal(
  cols: number,
  rows: number,
  options: { project?: string; signal?: AbortSignal } = {},
): Promise<TerminalInfo> {
  const response = await fetch("/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: terminalCreateBody(cols, rows, options.project),
    signal: options.signal,
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as TerminalInfo;
}

/** 打开 SSE 输出流；调用方从 response.body 里持续读取。 */
export async function openTerminalStream(id: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`/api/terminal/${encodeURIComponent(id)}/stream`, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) throw await failure(response);
  return response;
}

export function sendTerminalInput(id: string, data: string): Promise<void> {
  return postJson(`/api/terminal/${encodeURIComponent(id)}/input`, terminalInputBody(data));
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return postJson(`/api/terminal/${encodeURIComponent(id)}/resize`, terminalResizeBody(cols, rows));
}

export async function closeTerminal(id: string): Promise<void> {
  const response = await fetch(`/api/terminal/${encodeURIComponent(id)}`, {
    method: "DELETE",
    // DELETE 也要带 JSON content-type：服务端对所有非 GET 请求统一校验。
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: "{}",
  });
  // 会话可能已经被服务端回收（例如创建后迟迟没订阅）；404 不算错误。
  if (!response.ok && response.status !== 404) throw await failure(response);
}
