import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handleRpc } from "./qubius-mcp.mjs";

const EXPECTED_TOOLS = [
  "qubius_project_list",
  "qubius_session_list",
  "qubius_session_create",
  "qubius_session_send",
  "qubius_session_wait",
  "qubius_session_show",
];

function fakeClient(overrides = {}) {
  return {
    listProjects: async () => [{ id: "p1", name: "项目一", path: "/srv/p1" }],
    getSettings: async () => ({
      effort: "medium",
      providers: [{ id: "prov", name: "接口", models: ["m1"] }],
    }),
    listProjectSessions: async (project) => [
      { id: "s1", projectId: project, phase: "completed", title: "对话一" },
    ],
    getSession: async (id) => ({ id, phase: "completed", title: "对话一" }),
    createSession: async (project, payload) => ({
      id: "s1",
      projectId: project,
      phase: "queued",
      title: payload.prompt,
      ...payload,
    }),
    sendMessage: async (id) => ({ id, phase: "running", title: "对话一" }),
    ...overrides,
  };
}

function request(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function textOf(response) {
  return response.result.content[0].text;
}

test("initialize 返回协议版本、tools 能力和服务器名", async () => {
  const response = await handleRpc(request("initialize", { protocolVersion: "2024-11-05" }), fakeClient());

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.serverInfo.name, "qubius");
  assert.ok(response.result.capabilities.tools);
});

test("notifications/initialized 不响应", async () => {
  const response = await handleRpc(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    fakeClient(),
  );
  assert.equal(response, null);
});

test("ping 返回空结果", async () => {
  const response = await handleRpc(request("ping"), fakeClient());
  assert.deepEqual(response.result, {});
});

test("tools/list 返回全部工具和 JSON Schema", async () => {
  const response = await handleRpc(request("tools/list"), fakeClient());
  const names = response.result.tools.map((tool) => tool.name);

  assert.equal(names.length, EXPECTED_TOOLS.length);
  for (const name of EXPECTED_TOOLS) assert.ok(names.includes(name), name);
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.description, "string");
  }
  assert.equal(TOOLS.length, EXPECTED_TOOLS.length);
});

test("tools/call qubius_project_list 返回 text 内容", async () => {
  const response = await handleRpc(
    request("tools/call", { name: "qubius_project_list", arguments: {} }),
    fakeClient(),
  );

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(textOf(response)), [{ id: "p1", name: "项目一", path: "/srv/p1" }]);
});

test("tools/call qubius_session_list 传项目 id", async () => {
  let received;
  const client = fakeClient({
    listProjectSessions: async (project) => {
      received = project;
      return [{ id: "s1", projectId: project, phase: "completed", title: "对话一" }];
    },
  });

  const response = await handleRpc(
    request("tools/call", { name: "qubius_session_list", arguments: { project: "p1" } }),
    client,
  );

  assert.equal(received, "p1");
  assert.equal(JSON.parse(textOf(response))[0].projectId, "p1");
});

test("tools/call qubius_session_create 补全默认接口和模型", async () => {
  let created;
  const client = fakeClient({
    createSession: async (project, payload) => {
      created = { project, payload };
      return { id: "s1", projectId: project, phase: "queued" };
    },
  });

  const response = await handleRpc(
    request("tools/call", {
      name: "qubius_session_create",
      arguments: { project: "p1", prompt: "做点事", title: "标题" },
    }),
    client,
  );

  assert.equal(response.result.isError, undefined);
  assert.deepEqual(created, {
    project: "p1",
    payload: {
      prompt: "做点事",
      providerId: "prov",
      model: "m1",
      effort: "medium",
      title: "标题",
    },
  });
});

test("tools/call qubius_session_send 不等待时直接返回会话", async () => {
  let sent;
  const client = fakeClient({
    sendMessage: async (id, payload) => {
      sent = { id, payload };
      return { id, phase: "running", title: "对话一" };
    },
  });

  const response = await handleRpc(
    request("tools/call", {
      name: "qubius_session_send",
      arguments: { id: "s1", text: "继续", interject: true },
    }),
    client,
  );

  assert.deepEqual(sent, { id: "s1", payload: { prompt: "继续", interject: true } });
  assert.equal(JSON.parse(textOf(response)).phase, "running");
  assert.equal(response.result.isError, undefined);
});

test("tools/call qubius_session_wait 返回终态和状态标志", async () => {
  const client = fakeClient({
    getSession: async (id) => ({ id, phase: "needs_input", title: "对话一" }),
  });

  const response = await handleRpc(
    request("tools/call", { name: "qubius_session_wait", arguments: { id: "s1" } }),
    client,
  );

  const payload = JSON.parse(textOf(response));
  assert.equal(payload.phase, "needs_input");
  assert.equal(payload.timedOut, false);
  assert.equal(response.result.isError, undefined);
});

test("tools/call 失败时返回 isError 文本", async () => {
  const client = fakeClient({
    getSession: async () => {
      throw new Error("找不到对话");
    },
  });

  const response = await handleRpc(
    request("tools/call", { name: "qubius_session_show", arguments: { id: "missing" } }),
    client,
  );

  assert.equal(response.result.isError, true);
  assert.match(textOf(response), /找不到对话/);
});

test("tools/call 未知工具返回 JSON-RPC error", async () => {
  const response = await handleRpc(
    request("tools/call", { name: "qubius_nope", arguments: {} }),
    fakeClient(),
  );

  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /qubius_nope/);
});

test("未知方法返回 -32601", async () => {
  const response = await handleRpc(request("nope/nope"), fakeClient());
  assert.equal(response.error.code, -32601);
});

test("无效请求返回 -32600", async () => {
  const response = await handleRpc(null, fakeClient());
  assert.equal(response.error.code, -32600);
});
