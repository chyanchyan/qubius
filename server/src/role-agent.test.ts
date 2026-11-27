import assert from "node:assert/strict";
import test from "node:test";
import {
  query,
  type Options,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkRoleAgent,
  type RoleAgentDeps,
  type RoleAgentRequest,
} from "./role-agent.js";
import type { RoleBinding } from "./types.js";

/** query() 的入参；测试里只关心 options。 */
type QueryParams = Parameters<typeof query>[0];

/** SDK canUseTool 第三个参数的完整形状；toolUseID/requestId 是必填项。 */
type CanUseToolOptions = Parameters<NonNullable<Options["canUseTool"]>>[2];

function toolOptions(overrides: Partial<CanUseToolOptions> = {}): CanUseToolOptions {
  return {
    signal: new AbortController().signal,
    toolUseID: "tool-use-1",
    requestId: "request-1",
    ...overrides,
  };
}

interface RawUsageInput {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function fakeQuery(
  messages: SDKMessage[],
  onCall?: (params: QueryParams) => void,
): typeof query {
  return (params) => {
    onCall?.(params);
    const iterator = (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
    return Object.assign(iterator, { close() {} }) as unknown as Query;
  };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string };

function assistant(content: ContentBlock[], usage?: RawUsageInput): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet",
      content,
      stop_reason: null,
      stop_sequence: null,
      ...(usage ? { usage } : {}),
    },
    parent_tool_use_id: null,
    uuid: "assistant-uuid",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function resultSuccess(text: string, usage?: RawUsageInput): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    ...(usage ? { usage } : {}),
    uuid: "result-uuid",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function resultError(errors: string[], usage?: RawUsageInput): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors,
    ...(usage ? { usage } : {}),
    uuid: "result-uuid",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

/** subtype 是 success，但 is_error 为 true：接口错误把错误文本放在 result 里。 */
function resultApiError(text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: text,
    is_error: true,
    uuid: "result-uuid",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

const credential: RoleAgentDeps["credential"] = () => ({
  apiKey: "sk-test",
  baseUrl: "https://api.example.com",
  proxyUrl: "http://127.0.0.1:7890",
});

function binding(overrides: Partial<RoleBinding> = {}): RoleBinding {
  return {
    providerId: "prov1",
    providerName: "测试接口",
    model: "claude-sonnet",
    effort: "high",
    ...overrides,
  };
}

function request(overrides: Partial<RoleAgentRequest> = {}): RoleAgentRequest {
  return {
    role: "executor",
    binding: binding(),
    cwd: "/tmp/worktree",
    prompt: "完成这个工作单元",
    systemPrompt: "你是执行者",
    preset: true,
    maxTurns: 30,
    permissionMode: "acceptEdits",
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("执行者请求：preset system prompt、未设置 settingSources、透传 projectConfigRoot", async () => {
  let params: QueryParams | undefined;
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([resultSuccess("完成")], (value) => {
      params = value;
    }),
  });

  await agent(request({ projectConfigRoot: "/home/q/project" }));

  assert.ok(params);
  const options = params.options;
  assert.ok(options);
  assert.equal(options.model, "claude-sonnet");
  assert.equal(options.effort, "high");
  assert.equal(options.maxTurns, 30);
  assert.equal(options.permissionMode, "acceptEdits");
  assert.equal(options.env?.ANTHROPIC_BASE_URL, "https://api.example.com");
  assert.equal(options.env?.ANTHROPIC_API_KEY, "sk-test");
  assert.deepEqual(options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: "你是执行者",
  });
  // 执行者沿用 SDK 默认设置源，才能读到项目的 CLAUDE.md。
  assert.equal(Object.hasOwn(options, "settingSources"), false);
  // 没有传 tools 时保持 SDK 默认工具集。
  assert.equal(Object.hasOwn(options, "tools"), false);
  assert.equal(options.projectConfigRoot, "/home/q/project");
  assert.equal(options.persistSession, false);
  assert.equal(options.strictMcpConfig, true);
});

test("审核者请求：custom system prompt、空 settingSources、只读 tools 透传", async () => {
  let params: QueryParams | undefined;
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([resultSuccess("结论：PASS")], (value) => {
      params = value;
    }),
  });

  await agent(request({
    role: "sub-reviewer",
    preset: false,
    systemPrompt: "你是审核者",
    tools: ["Read", "Grep", "Glob"],
    permissionMode: "default",
  }));

  assert.ok(params?.options);
  const options = params.options;
  assert.deepEqual(options.systemPrompt, { type: "custom", prompt: "你是审核者" });
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.tools, ["Read", "Grep", "Glob"]);
  assert.equal(options.permissionMode, "default");
  assert.equal(Object.hasOwn(options, "projectConfigRoot"), false);
});

test("聚合 assistant 文本、工具名去重和 onProgress", async () => {
  const progress: string[] = [];
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([
      assistant(
        [
          { type: "text", text: "第一段" },
          { type: "tool_use", name: "Edit" },
        ],
        { input_tokens: 5, output_tokens: 6 },
      ),
      assistant([{ type: "tool_use", name: "Bash" }]),
      assistant([
        { type: "text", text: "第二段" },
        { type: "tool_use", name: "Edit" },
      ]),
      // result 正文为空：应该退回累积的 assistant 文本。
      resultSuccess(""),
    ]),
  });

  const result = await agent(request({
    onProgress: (item) => {
      if (item.toolName) progress.push(item.toolName);
    },
  }));

  assert.equal(result.text, "第一段\n第二段");
  assert.deepEqual(result.tools, ["Edit", "Bash"]);
  // 每次工具调用都通知进度，包括重复出现的工具。
  assert.deepEqual(progress, ["Edit", "Bash", "Edit"]);
  // 没有 result usage 时退回 assistant usage，缺失字段按 0。
  assert.deepEqual(result.usage, { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });
});

test("result 正文优先，usage 从 result 映射", async () => {
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([
      assistant([{ type: "text", text: "中间过程" }], { input_tokens: 1, output_tokens: 1 }),
      resultSuccess("最终结论", {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      }),
    ]),
  });

  const result = await agent(request({ preset: false }));

  assert.equal(result.text, "最终结论");
  assert.deepEqual(result.usage, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
});

test("空返回抛错", async () => {
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([]),
  });

  await assert.rejects(agent(request()), /模型没有返回内容/);
});

test("错误结果没有正文时带上 SDK 的 errors", async () => {
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([resultError(["认证失败：API key 无效"])]),
  });

  await assert.rejects(agent(request()), /认证失败/);
});

test("错误信息为空时退回 stderr 尾部", async () => {
  const queryFn: typeof query = (params) => {
    params.options?.stderr?.("启动失败：找不到 CLI\n");
    const iterator = (async function* () {
      yield resultError([]);
    })();
    return Object.assign(iterator, { close() {} }) as unknown as Query;
  };
  const agent = createSdkRoleAgent({ credential, queryFn });

  await assert.rejects(agent(request()), /找不到 CLI/);
});

test("错误 result 即使已有 assistant 文本也失败", async () => {
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([
      assistant([{ type: "text", text: "做到一半" }]),
      resultError(["执行失败：测试没有通过"]),
    ]),
  });

  await assert.rejects(agent(request()), /测试没有通过/);
});

test("success + is_error 即使已有 assistant 文本也失败，错误取 result.result", async () => {
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([
      assistant([{ type: "text", text: "半截正文" }]),
      resultApiError("接口返回 529 过载"),
    ]),
  });

  await assert.rejects(agent(request()), /529 过载/);
});

test("只有 assistant 文本、没有 result 也失败", async () => {
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([assistant([{ type: "text", text: "只有正文" }])]),
  });

  await assert.rejects(agent(request()), /模型没有返回内容/);
});

test("canUseTool 不回传 suggestions，透传 updatedInput 与 deny message", async () => {
  let params: QueryParams | undefined;
  const calls: Array<{ blockedPath?: string }> = [];
  const decisions: Array<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message?: string }
  > = [
    { behavior: "allow" },
    { behavior: "allow", updatedInput: { answers: { q1: "A" } } },
    { behavior: "deny", message: "用户拒绝了这次操作" },
  ];
  let index = 0;
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([resultSuccess("完成")], (value) => {
      params = value;
    }),
  });

  await agent(request({
    canUseTool: async (_toolName, _input, options) => {
      calls.push(options);
      return decisions[index++]!;
    },
  }));

  assert.ok(params?.options?.canUseTool);
  const canUseTool = params.options.canUseTool;
  const suggestion: PermissionUpdate = {
    type: "addRules",
    rules: [{ toolName: "Read" }],
    behavior: "allow",
    destination: "session",
  };

  // 即使 SDK 给了 suggestions，普通 allow 也只返回 behavior。
  const allowed = await canUseTool("Read", {}, toolOptions({ suggestions: [suggestion] }));
  assert.deepEqual(allowed, { behavior: "allow" });
  assert.equal(calls[0]?.blockedPath, undefined);

  // AskUserQuestion 的用户答案通过 updatedInput 原样传回模型。
  const withInput = await canUseTool("AskUserQuestion", { questions: [] }, toolOptions());
  assert.deepEqual(withInput, { behavior: "allow", updatedInput: { answers: { q1: "A" } } });

  const blockedPath = "/etc/passwd";
  const denied = await canUseTool("Bash", { command: "cat" }, toolOptions({ blockedPath }));
  assert.deepEqual(denied, { behavior: "deny", message: "用户拒绝了这次操作" });
  assert.equal(calls[2]?.blockedPath, blockedPath);
});

test("运行中 abort 会尽快结束并关闭 stream", async () => {
  let closed = false;
  const queryFn: typeof query = (params) => {
    const signal = params.options?.abortController?.signal;
    const iterator = (async function* () {
      yield assistant([{ type: "text", text: "开始" }]);
      await new Promise<never>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("缺少 abort controller"));
          return;
        }
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    })();
    return Object.assign(iterator, {
      close() {
        closed = true;
      },
    }) as unknown as Query;
  };
  const agent = createSdkRoleAgent({ credential, queryFn });
  const controller = new AbortController();
  const pending = agent(request({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(pending, /aborted/);
  assert.equal(closed, true);
});

test("close() 抛错不覆盖原始错误", async () => {
  const queryFn: typeof query = () => {
    const iterator = (async function* () {
      throw new Error("原始失败");
    })();
    return Object.assign(iterator, {
      close() {
        throw new Error("close 失败");
      },
    }) as unknown as Query;
  };
  const agent = createSdkRoleAgent({ credential, queryFn });

  await assert.rejects(agent(request()), /原始失败/);
});

test("signal 已中止时不起 query", async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const agent = createSdkRoleAgent({
    credential,
    queryFn: fakeQuery([resultSuccess("不应该执行")], () => {
      called = true;
    }),
  });

  await assert.rejects(agent(request({ signal: controller.signal })), /已停止/);
  assert.equal(called, false);
});

test("stderr 回退抛错时会脱敏接口密钥", async () => {
  const secret = "sk-ant-secret-1234567890";
  const agent = createSdkRoleAgent({
    credential: () => ({ apiKey: secret, baseUrl: "https://example.test" }),
    queryFn: ((params: QueryParams) => {
      params.options?.stderr?.(`fatal: auth failed for ${secret}`);
      const iterator = (async function* () {
        // 没有 result，触发 stderr 回退。
      })();
      return Object.assign(iterator, { close() {} }) as unknown as Query;
    }) as typeof query,
  });

  await assert.rejects(
    agent(request()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret), "错误信息不能包含明文 apiKey");
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

