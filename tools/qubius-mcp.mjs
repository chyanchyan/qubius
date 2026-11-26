#!/usr/bin/env node
// qubius 的 stdio MCP server：一行一个 JSON-RPC 2.0 消息，响应也是一行一个 JSON。
// 只依赖 qubius-client.mjs 和 Node 内置模块。
import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  createClient,
  resolveRunOptions,
  waitForSession,
} from "./qubius-client.mjs";

const PROTOCOL_VERSION = "2024-11-05";

function serverVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_INFO = Object.freeze({ name: "qubius", version: serverVersion() });

const PROPERTIES = {
  project: { type: "string", description: "项目 id" },
  projectId: { type: "string", description: "项目 id" },
  prompt: { type: "string", description: "首条消息正文" },
  text: { type: "string", description: "要发送的消息正文" },
  id: { type: "string", description: "对话 id" },
  provider: { type: "string", description: "接口配置 id，省略时用第一套" },
  model: { type: "string", description: "模型，省略时用第一个模型" },
  effort: { type: "string", description: "low、medium、high、xhigh 或 max" },
  title: { type: "string", description: "对话标题" },
  workflow: { type: "string", description: "prl、ser、plan、discuss 或 dis-prl" },
  interject: { type: "boolean", description: "插话：立即交给正在运行的 agent" },
  wait: { type: "boolean", description: "发送后等待本轮结束" },
  timeout: { type: "number", description: "等待秒数，默认 600" },
};

function schema(properties, required = []) {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

export const TOOLS = Object.freeze([
  {
    name: "qubius_project_list",
    description: "列出 qubius 里的项目",
    inputSchema: schema({}),
  },
  {
    name: "qubius_session_list",
    description: "列出某个项目下的对话",
    inputSchema: schema({ project: PROPERTIES.project }, ["project"]),
  },
  {
    name: "qubius_session_create",
    description: "创建对话并发送首条消息",
    inputSchema: schema(
      {
        project: PROPERTIES.project,
        prompt: PROPERTIES.prompt,
        provider: PROPERTIES.provider,
        model: PROPERTIES.model,
        effort: PROPERTIES.effort,
        title: PROPERTIES.title,
        workflow: PROPERTIES.workflow,
      },
      ["project", "prompt"],
    ),
  },
  {
    name: "qubius_session_send",
    description: "向已有对话发送消息，可选等待本轮结束",
    inputSchema: schema(
      {
        id: PROPERTIES.id,
        text: PROPERTIES.text,
        interject: PROPERTIES.interject,
        wait: PROPERTIES.wait,
        timeout: PROPERTIES.timeout,
      },
      ["id", "text"],
    ),
  },
  {
    name: "qubius_session_wait",
    description: "等待对话进入 completed/failed/stopped/needs_input",
    inputSchema: schema({ id: PROPERTIES.id, timeout: PROPERTIES.timeout }, ["id"]),
  },
  {
    name: "qubius_session_show",
    description: "查看对话详情",
    inputSchema: schema({ id: PROPERTIES.id }, ["id"]),
  },
]);

function requireString(args, name) {
  const value = args?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少参数：${name}`);
  }
  return value;
}

function waitTimeout(value) {
  if (value === undefined) return 600;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("timeout 必须是非负秒数");
  }
  return value;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function mergeWaitText(result) {
  return pretty({
    phase: result.phase,
    timedOut: result.timedOut,
    session: result.session,
  });
}

const HANDLERS = {
  async qubius_project_list(_args, client) {
    return pretty(await client.listProjects());
  },

  async qubius_session_list(args, client) {
    const project = requireString(args, "project");
    return pretty(await client.listProjectSessions(project));
  },

  async qubius_session_create(args, client) {
    const project = requireString(args, "project");
    const prompt = requireString(args, "prompt");
    const run = await resolveRunOptions(client, {
      provider: args?.provider,
      model: args?.model,
      effort: args?.effort,
    });
    const payload = { prompt, ...run };
    if (typeof args?.title === "string" && args.title) payload.title = args.title;
    if (typeof args?.workflow === "string" && args.workflow) payload.workflow = args.workflow;
    return pretty(await client.createSession(project, payload));
  },

  async qubius_session_send(args, client) {
    const id = requireString(args, "id");
    const text = requireString(args, "text");
    const payload = { prompt: text };
    if (args?.interject === true) payload.interject = true;
    const session = await client.sendMessage(id, payload);
    if (args?.wait !== true) return pretty(session);

    const result = await waitForSession({
      getSession: client.getSession,
      id,
      timeoutSec: waitTimeout(args?.timeout),
    });
    return {
      text: mergeWaitText(result),
      isError: result.timedOut || result.phase === "failed" || result.phase === "stopped",
    };
  },

  async qubius_session_wait(args, client) {
    const id = requireString(args, "id");
    const result = await waitForSession({
      getSession: client.getSession,
      id,
      timeoutSec: waitTimeout(args?.timeout),
    });
    return {
      text: mergeWaitText(result),
      isError: result.timedOut || result.phase === "failed" || result.phase === "stopped",
    };
  },

  async qubius_session_show(args, client) {
    const id = requireString(args, "id");
    return pretty(await client.getSession(id));
  },
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function callTool(id, params, client) {
  if (!params || typeof params !== "object") {
    return fail(id, -32602, "tools/call 缺少参数");
  }
  const name = params.name;
  if (typeof name !== "string" || !name) {
    return fail(id, -32602, "tools/call 缺少工具名");
  }
  const handler = HANDLERS[name];
  if (!handler) return fail(id, -32602, `未知工具：${name}`);

  const args = params.arguments && typeof params.arguments === "object"
    ? params.arguments
    : {};
  try {
    const output = await handler(args, client);
    const text = typeof output === "string" ? output : output.text;
    const isError = typeof output === "object" && output?.isError === true;
    return ok(id, {
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    });
  } catch (error) {
    return ok(id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

/**
 * 处理一条 JSON-RPC 请求。通知（没有 id）返回 null，调用方不写响应。
 * client 需要提供 qubius-client 里的 HTTP 方法；测试可注入假实现。
 */
export async function handleRpc(request, client) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return fail(null, -32600, "无效的请求");
  }

  const hasId = hasOwn(request, "id");
  const id = hasId ? request.id : null;
  const method = request.method;
  if (typeof method !== "string" || !method) {
    return hasId ? fail(id, -32600, "缺少 method") : null;
  }

  // initialized 以及其它通知都不响应。
  if (method.startsWith("notifications/")) return null;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call":
        return await callTool(id, request.params, client);
      default:
        return hasId ? fail(id, -32601, `未知方法：${method}`) : null;
    }
  } catch (error) {
    if (!hasId) return null;
    return fail(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function writeResponse(output, response) {
  output.write(`${JSON.stringify(response)}\n`);
}

/** 从 stdin 逐行读 JSON-RPC，按顺序把响应写回 stdout。 */
export function startServer({ input = process.stdin, output = process.stdout, client = createClient() } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();

  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        writeResponse(output, fail(null, -32700, "无法解析 JSON"));
        return;
      }
      const response = await handleRpc(request, client);
      if (response) writeResponse(output, response);
    }).catch((error) => {
      output.write(`${JSON.stringify(fail(null, -32603, error instanceof Error ? error.message : String(error)))}\n`);
    });
  });

  return new Promise((resolve) => {
    rl.on("close", () => {
      chain.finally(resolve);
    });
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer().catch((error) => {
    process.stderr.write(`qubius-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
