import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeConnection, claudeEnv } from "./endpoint.js";
import type { PermissionLevel } from "./permissions.js";
import { resultText } from "./session-title.js";
import type { RoleBinding, RoleKind, TokenUsage } from "./types.js";

/**
 * prl-role 的单次角色调用。
 *
 * 每个阶段都是一次独立的 SDK query：编排/审核不带工具或只带只读工具，
 * 执行者带完整工具权限，并且可以逐次请求用户确认。这里定义运行时注入的
 * 接口，SDK 实现由 createSdkRoleAgent 提供，测试和假运行可以注入替身。
 */

export interface RoleAgentProgress {
  /** 最近一次工具调用名；用于界面显示「执行中 · Edit」。 */
  toolName?: string;
}

export interface RoleAgentToolOptions {
  signal: AbortSignal;
  blockedPath?: string;
}

export type RoleAgentPermission = (
  toolName: string,
  input: Record<string, unknown>,
  options: RoleAgentToolOptions,
) => Promise<{
  behavior: "allow" | "deny";
  message?: string;
  /** 允许时替换工具输入；AskUserQuestion 用它把用户答案传回模型。 */
  updatedInput?: Record<string, unknown>;
}>;

export interface RoleAgentRequest {
  role: RoleKind;
  /** 这次调用使用的接口、模型和 effort。 */
  binding: RoleBinding;
  cwd: string;
  /** 工作目录和项目目录不同时（worktree）传给 SDK 的 project-config-root。 */
  projectConfigRoot?: string;
  prompt: string;
  systemPrompt: string;
  /**
   * true：在 claude_code 预设后追加 systemPrompt（执行者）；
   * false：用 systemPrompt 作为完整自定义提示（编排/审核）。
   */
  preset: boolean;
  /** 暴露给模型的工具；缺省表示交给 SDK 默认（执行者）。 */
  tools?: string[];
  maxTurns: number;
  permissionMode: PermissionLevel;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: RoleAgentPermission;
  signal: AbortSignal;
  /** 单次调用超时；缺省由实现决定。 */
  timeoutMs?: number;
  onProgress?: (progress: RoleAgentProgress) => void;
}

export interface RoleAgentResult {
  /** 这一阶段的最终正文。 */
  text: string;
  /** 这次调用里出现过的工具名（去重、按出现顺序）。 */
  tools: string[];
  usage?: TokenUsage;
}

/** 单次角色调用；抛错表示这一阶段失败。 */
export type RoleAgent = (request: RoleAgentRequest) => Promise<RoleAgentResult>;

export interface RoleAgentDeps {
  credential: (providerId: string) => { apiKey: string; baseUrl: string };
  /** 便于测试注入假的 query；缺省使用 SDK 的真实实现。 */
  queryFn?: typeof query;
}

/** 单次角色调用的默认超时：执行者可能跑很久，但也不能无限等。 */
export const ROLE_AGENT_TIMEOUT_MS = 600_000;

/** SDK 消息里出现过的 token 用量字段；assistant 和 result 都兼容。 */
interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** 把 SDK 的 usage（可能缺字段）归一化成 TokenUsage。 */
export function roleAgentUsage(raw: RawUsage | undefined): TokenUsage {
  return {
    input: raw?.input_tokens ?? 0,
    output: raw?.output_tokens ?? 0,
    cacheRead: raw?.cache_read_input_tokens ?? 0,
    cacheWrite: raw?.cache_creation_input_tokens ?? 0,
  };
}

/** 把错误信息里的接口密钥脱敏，避免 stderr 原样暴露凭据。 */
function redactSecret(text: string, secret: string): string {
  const key = secret.trim();
  if (key.length < 8 || !text.includes(key)) return text;
  return text.split(key).join("[redacted]");
}

/** result 失败时的错误信息：优先 SDK 给的 errors/result，其次 stderr 尾部。 */
function failureMessage(result: SDKResultMessage, stderrTail: string, apiKey: string): string {
  if (result.subtype === "success") {
    const text = result.is_error && typeof result.result === "string" ? result.result.trim() : "";
    if (text) return redactSecret(text, apiKey);
  } else {
    const text = (result.errors ?? []).map((item) => item.trim()).filter(Boolean).join("；");
    if (text) return redactSecret(text, apiKey);
  }
  const tail = stderrTail.trim();
  return tail ? redactSecret(tail, apiKey) : "角色调用失败";
}

/** close() 失败不能覆盖真正的原始错误（比如 abort 或执行失败）。 */
function closeQuietly(stream: Query | undefined): void {
  try {
    stream?.close();
  } catch {
    // 子进程可能已经退出；清理失败不影响本次调用的结果。
  }
}

/**
 * 用 Claude Agent SDK 起一次性 query 完成一个角色阶段。
 *
 * 执行者用于改代码：沿用 claude_code 预设和项目 CLAUDE.md，工具随手 confirm；
 * 编排/审核只读：完整自定义 system prompt、空 settingSources、只暴露只读工具。
 * 每次调用都不落盘 session，也不加载项目外的 MCP 配置。
 */
export function createSdkRoleAgent(deps: RoleAgentDeps): RoleAgent {
  const queryFn = deps.queryFn ?? query;
  return async (request) => {
    // 已经停止的请求不要再起子进程；尽早给出明确错误。
    if (request.signal.aborted) throw new Error("角色调用已停止");

    const { apiKey, baseUrl } = deps.credential(request.binding.providerId);
    const connection = claudeConnection(baseUrl, request.binding.model);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), request.timeoutMs ?? ROLE_AGENT_TIMEOUT_MS);
    timer.unref();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });

    const textChunks: string[] = [];
    const tools: string[] = [];
    const seenTools = new Set<string>();
    let assistantUsage: RawUsage | undefined;
    let result: SDKResultMessage | undefined;
    let stderrTail = "";
    let stream: Query | undefined;
    try {
      // options 构造也可能同步抛错（例如凭据/接口配置异常），放在 try 里
      // 才能保证刚注册的定时器和 abort 监听器一定被清理。
      const options: Options = {
        cwd: request.cwd,
        model: connection.model,
        effort: request.binding.effort,
        maxTurns: request.maxTurns,
        permissionMode: request.permissionMode,
        persistSession: false,
        strictMcpConfig: true,
        abortController: abort,
        env: claudeEnv(process.env, apiKey, connection),
        stderr: (data) => {
          stderrTail = `${stderrTail}${data}`.slice(-2000);
        },
        systemPrompt: request.preset
          ? { type: "preset", preset: "claude_code", append: request.systemPrompt }
          : { type: "custom", prompt: request.systemPrompt },
      };
      // 执行者沿用 SDK 默认设置源，才能读到项目 CLAUDE.md；只读角色完全隔离。
      if (!request.preset) options.settingSources = [];
      if (request.tools !== undefined) options.tools = request.tools;
      if (request.projectConfigRoot) options.projectConfigRoot = request.projectConfigRoot;
      if (request.allowDangerouslySkipPermissions !== undefined) {
        options.allowDangerouslySkipPermissions = request.allowDangerouslySkipPermissions;
      }
      if (request.canUseTool) {
        const permission = request.canUseTool;
        options.canUseTool = async (toolName, input, toolOptions) => {
          const decision = await permission(toolName, input, {
            signal: toolOptions.signal,
            ...(toolOptions.blockedPath !== undefined ? { blockedPath: toolOptions.blockedPath } : {}),
          });
          if (decision.behavior === "allow") {
            // 不转发 SDK 的 suggestions：是否「本对话记住」由上层权限策略决定，
            // 这里无条件回传等于绕过用户的选择。
            return decision.updatedInput !== undefined
              ? { behavior: "allow", updatedInput: decision.updatedInput }
              : { behavior: "allow" };
          }
          return { behavior: "deny", message: decision.message ?? "已拒绝这次操作" };
        };
      }

      stream = queryFn({ prompt: request.prompt, options });
      for await (const message of stream as AsyncIterable<SDKMessage>) {
        if (message.type === "assistant") {
          if (message.message.usage) assistantUsage = message.message.usage;
          for (const block of message.message.content) {
            if (block.type === "text") {
              if (block.text) textChunks.push(block.text);
            } else if (block.type === "tool_use") {
              if (!seenTools.has(block.name)) {
                seenTools.add(block.name);
                tools.push(block.name);
              }
              request.onProgress?.({ toolName: block.name });
            }
          }
        } else if (message.type === "result") {
          result = message;
        }
      }

      // 没有 result 不能当成成功：SDK 进程可能提前退出。
      if (!result) {
        const tail = stderrTail.trim();
        throw new Error(tail ? redactSecret(tail, apiKey) : "模型没有返回内容");
      }
      // 错误 result 一律失败，即使之前已经流式产出过 assistant 文本；
      // 否则半截内容会被误当成这一阶段的最终结论。
      if (result.subtype !== "success" || result.is_error === true) {
        throw new Error(failureMessage(result, stderrTail, apiKey));
      }
      // 只有成功的非错误结果才进入正文选择：result 正文优先，空则 accumulated。
      const resultValue = resultText(result);
      const accumulated = textChunks.join("\n").trim();
      const final = resultValue && resultValue.trim() ? resultValue : accumulated;
      if (!final.trim()) throw new Error("模型没有返回内容");
      const usage = result.usage
        ? roleAgentUsage(result.usage)
        : assistantUsage
          ? roleAgentUsage(assistantUsage)
          : undefined;
      return {
        text: final,
        tools,
        ...(usage ? { usage } : {}),
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      closeQuietly(stream);
    }
  };
}
