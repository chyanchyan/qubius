// qubius 的共享 HTTP 客户端：CLI 和 stdio MCP server 都用它访问本机 HTTP API。
// 只用 Node 22 内置 fetch，不引入任何依赖。
import fs from "node:fs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/** 等待对话结束时会停留在这几个状态；needs_input 也算这一轮等待的终点。 */
export const TERMINAL_PHASES = Object.freeze([
  "completed",
  "failed",
  "stopped",
  "needs_input",
]);

export class QubiusApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, body?: unknown, url?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "QubiusApiError";
    this.status = meta.status ?? 0;
    this.body = meta.body;
    this.url = meta.url;
  }
}

function firstValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 解析连接配置：URL 用 --url > QUBIUS_URL > 默认值；
 * 令牌用 --token > QUBIUS_TOKEN > QUBIUS_AUTH_TOKEN > QUBIUS_TOKEN_FILE > 无。
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const rawUrl = firstValue(overrides.url, env.QUBIUS_URL) || DEFAULT_BASE_URL;
  const baseUrl = rawUrl.replace(/\/+$/, "");

  const flagToken = firstValue(overrides.token);
  const envToken = firstValue(env.QUBIUS_TOKEN);
  const authToken = firstValue(env.QUBIUS_AUTH_TOKEN);
  const tokenFile = firstValue(env.QUBIUS_TOKEN_FILE);

  let token = "";
  let tokenSource;
  if (flagToken) {
    token = flagToken;
    tokenSource = "flag";
  } else if (envToken) {
    token = envToken;
    tokenSource = "QUBIUS_TOKEN";
  } else if (authToken) {
    token = authToken;
    tokenSource = "QUBIUS_AUTH_TOKEN";
  } else if (tokenFile) {
    try {
      token = fs.readFileSync(tokenFile, "utf8").trim();
    } catch (error) {
      throw new Error(
        `无法读取令牌文件 ${tokenFile}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    tokenSource = "QUBIUS_TOKEN_FILE";
  }

  return { baseUrl, token, tokenSource };
}

/**
 * 创建客户端。options 同时接受 { url, token } 和 { config, env, fetch }，
 * 测试里可以注入自定义 fetch。
 */
export function createClient(options = {}) {
  const config = options.config ?? resolveConfig(options, options.env ?? process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, signal?: AbortSignal, timeoutMs?: number }} [requestOptions]
   */
  async function request(method, path, requestOptions = {}) {
    const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = { accept: "application/json" };
    if (config.token) headers["x-qubius-token"] = config.token;

    const init = { method, headers };
    if (requestOptions.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(requestOptions.body);
    }

    const { signal, timeoutMs } = requestOptions;
    let timeoutSignal;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timeoutSignal = AbortSignal.timeout(timeoutMs);
      init.signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    } else if (signal) {
      init.signal = signal;
    }

    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      const abortedExternally = Boolean(signal?.aborted);
      if (!abortedExternally && timeoutSignal?.aborted) {
        throw new QubiusApiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, { url });
      }
      if (error instanceof Error && error.name === "TypeError" && /fetch failed/i.test(error.message)) {
        const reason = error.cause instanceof Error ? error.cause.message : error.message;
        throw new QubiusApiError(`无法连接 ${config.baseUrl}：${reason}`, { url });
      }
      throw error;
    }

    const text = await response.text();
    let body;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const detail = body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : typeof body === "string" && body.trim()
          ? body.trim().slice(0, 200)
          : response.statusText || `HTTP ${response.status}`;
      throw new QubiusApiError(detail, { status: response.status, body, url });
    }

    return body;
  }

  const segment = (value) => encodeURIComponent(value);
  const client = {
    config,
    request,

    async listProjects() {
      const body = await request("GET", "/api/projects");
      return body?.projects ?? [];
    },
    getSettings() {
      return request("GET", "/api/settings");
    },
    async listProjectSessions(projectId) {
      const body = await request("GET", `/api/projects/${segment(projectId)}/sessions`);
      return body?.sessions ?? [];
    },
    async getSession(id, requestOptions) {
      const body = await request("GET", `/api/sessions/${segment(id)}`, {
        signal: requestOptions?.signal,
      });
      return body?.session;
    },
    async createSession(projectId, payload) {
      const body = await request("POST", `/api/projects/${segment(projectId)}/sessions`, {
        body: payload,
      });
      return body?.session;
    },
    async sendMessage(id, payload) {
      const body = await request("POST", `/api/sessions/${segment(id)}/messages`, {
        body: payload,
      });
      return body?.session;
    },
    async stopSession(id) {
      const body = await request("POST", `/api/sessions/${segment(id)}/stop`, { body: {} });
      return body?.session;
    },
    async listSchedules(projectId) {
      const body = await request("GET", `/api/projects/${segment(projectId)}/schedules`);
      return body?.schedules ?? [];
    },
    runSchedule(projectId, scheduleId) {
      return request(
        "POST",
        `/api/projects/${segment(projectId)}/schedules/${segment(scheduleId)}/run`,
        { body: {} },
      );
    },
    waitForSession(id, waitOptions = {}) {
      return waitForSession({ ...waitOptions, getSession: client.getSession, id });
    },
  };
  return client;
}

/**
 * 轮询一个对话直到进入终态。返回 { session, phase, timedOut }。
 * timeoutSec 默认 600 秒；sleep / now 可注入，方便测试。
 */
export async function waitForSession({
  getSession,
  id,
  timeoutSec = 600,
  intervalMs = 2000,
  sleep,
  now,
  signal,
  onPoll,
} = {}) {
  if (typeof getSession !== "function") throw new TypeError("waitForSession 需要 getSession");
  const clock = now ?? Date.now;
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const seconds = Number.isFinite(timeoutSec) ? Math.max(0, timeoutSec) : 600;
  const deadline = clock() + seconds * 1000;

  for (;;) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("已取消");
    }
    const session = await getSession(id, signal ? { signal } : undefined);
    if (onPoll) onPoll(session);
    if (session && TERMINAL_PHASES.includes(session.phase)) {
      return { session, phase: session.phase, timedOut: false };
    }
    const remaining = deadline - clock();
    if (remaining <= 0) {
      return { session, phase: session?.phase, timedOut: true };
    }
    await pause(Math.min(intervalMs, remaining));
  }
}

/**
 * 把 --provider/--model/--effort 补全成完整运行配置。
 * 缺任何一项时读取 /api/settings：默认第一套接口、第一个模型、settings.effort。
 */
export async function resolveRunOptions(client, options = {}) {
  const provider = typeof options.provider === "string" && options.provider.trim()
    ? options.provider.trim()
    : "";
  const model = typeof options.model === "string" && options.model.trim()
    ? options.model.trim()
    : "";
  const effort = typeof options.effort === "string" && options.effort.trim()
    ? options.effort.trim()
    : "";

  if (provider && model && effort) return { providerId: provider, model, effort };

  const settings = await client.getSettings();
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];

  let providerId = provider;
  if (!providerId) providerId = providers[0]?.id;
  if (!providerId) throw new Error("没有可用的接口配置，请先在网页里添加");

  let resolvedModel = model;
  if (!resolvedModel) {
    const found = providers.find((item) => item.id === providerId);
    resolvedModel = found?.models?.[0];
    if (!resolvedModel) throw new Error(`接口配置 ${providerId} 还没有模型`);
  }

  const resolvedEffort = effort || settings?.effort || "high";
  return { providerId, model: resolvedModel, effort: resolvedEffort };
}
