import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  QubiusApiError,
  createClient,
  resolveConfig,
} from "./qubius-client.mjs";
import {
  UsageError,
  parseArgs,
  parseCommand,
  runCli,
} from "./qubius.mjs";

function capture() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    text() {
      return text;
    },
  };
}

function fakeClient(overrides = {}) {
  return {
    listProjects: async () => [{ id: "p1", name: "项目一", path: "/srv/p1" }],
    getSettings: async () => ({
      effort: "high",
      maxConcurrent: 4,
      providers: [{ id: "prov", name: "接口", models: ["m1", "m2"] }],
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
    }),
    sendMessage: async (id) => ({ id, phase: "running", title: "对话一" }),
    stopSession: async (id) => ({ id, phase: "stopped", title: "对话一" }),
    listSchedules: async () => [],
    runSchedule: async (project, schedule) => ({
      scheduleId: schedule,
      ok: true,
      sessionId: "s1",
    }),
    ...overrides,
  };
}

test("resolveConfig：URL 和令牌的优先级", () => {
  const fromFlag = resolveConfig(
    { url: "http://flag:1/", token: "flag-token" },
    { QUBIUS_URL: "http://env:2", QUBIUS_TOKEN: "env-token" },
  );
  assert.equal(fromFlag.baseUrl, "http://flag:1");
  assert.equal(fromFlag.token, "flag-token");

  const fromEnv = resolveConfig({}, { QUBIUS_URL: "http://env:2/", QUBIUS_TOKEN: "env-token" });
  assert.equal(fromEnv.baseUrl, "http://env:2");
  assert.equal(fromEnv.token, "env-token");

  const auth = resolveConfig({}, { QUBIUS_AUTH_TOKEN: "auth-token" });
  assert.equal(auth.token, "auth-token");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-token-"));
  const tokenFile = path.join(dir, "auth-token");
  fs.writeFileSync(tokenFile, "  file-token\n");
  try {
    const fromFile = resolveConfig({}, { QUBIUS_TOKEN_FILE: tokenFile });
    assert.equal(fromFile.token, "file-token");
    assert.equal(fromFile.tokenSource, "QUBIUS_TOKEN_FILE");

    // 环境变量令牌优先于令牌文件。
    const mixed = resolveConfig({}, { QUBIUS_TOKEN: "env-token", QUBIUS_TOKEN_FILE: tokenFile });
    assert.equal(mixed.token, "env-token");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const none = resolveConfig({}, {});
  assert.equal(none.baseUrl, DEFAULT_BASE_URL);
  assert.equal(none.token, "");
});

test("parseArgs：布尔开关、--flag=value 和 '-' 值", () => {
  assert.deepEqual(
    parseArgs(["--json", "--project", "p1", "--prompt", "-"]),
    { positionals: [], flags: { json: true, project: "p1", prompt: "-" } },
  );
  assert.deepEqual(
    parseArgs(["--url=http://127.0.0.1:9", "--wait"]),
    { positionals: [], flags: { url: "http://127.0.0.1:9", wait: true } },
  );
  assert.deepEqual(
    parseArgs(["session", "send", "s1", "-", "--interject"]).positionals,
    ["session", "send", "s1", "-"],
  );
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["--project"]), UsageError);
  assert.throws(() => parseArgs(["--json=1"]), UsageError);
});

test("parseCommand：拆分命令和参数", () => {
  const parsed = parseCommand([
    "session",
    "create",
    "--project",
    "p1",
    "--prompt",
    "做点事",
  ]);
  assert.equal(parsed.group, "session");
  assert.equal(parsed.action, "create");
  assert.deepEqual(parsed.rest, []);
  assert.equal(parsed.flags.project, "p1");
  assert.equal(parsed.flags.prompt, "做点事");

  assert.throws(() => parseCommand([]), UsageError);
  assert.throws(() => parseCommand(["session"]), UsageError);
});

test("session send 的 '-' 从 stdin 读正文", async () => {
  let received;
  const client = fakeClient({
    sendMessage: async (id, payload) => {
      received = { id, payload };
      return { id, phase: "running", title: "对话一" };
    },
  });
  const out = capture();
  const err = capture();

  const code = await runCli(["session", "send", "s1", "-"], {
    client,
    stdout: out.stream,
    stderr: err.stream,
    readStdin: async () => "来自 stdin 的正文",
  });

  assert.equal(code, 0);
  assert.deepEqual(received, { id: "s1", payload: { prompt: "来自 stdin 的正文" } });
  assert.match(out.text(), /s1\trunning/);
});

test("session create：未给 provider/model 时用设置里的第一套", async () => {
  let created;
  const client = fakeClient({
    createSession: async (project, payload) => {
      created = { project, payload };
      return { id: "s1", projectId: project, phase: "queued", title: "做点事" };
    },
  });

  const code = await runCli(
    ["session", "create", "--project", "proj", "--prompt", "做点事"],
    { client, stdout: capture().stream, stderr: capture().stream },
  );

  assert.equal(code, 0);
  assert.deepEqual(created, {
    project: "proj",
    payload: { prompt: "做点事", providerId: "prov", model: "m1", effort: "high" },
  });
});

test("session create：参数齐全时不再读取设置", async () => {
  let settingsRead = 0;
  let created;
  const client = fakeClient({
    getSettings: async () => {
      settingsRead += 1;
      throw new Error("不应该读取设置");
    },
    createSession: async (project, payload) => {
      created = payload;
      return { id: "s1", projectId: project, phase: "queued", title: "题目" };
    },
  });

  const code = await runCli(
    [
      "session",
      "create",
      "--project",
      "proj",
      "--prompt",
      "做点事",
      "--provider",
      "prov",
      "--model",
      "m9",
      "--effort",
      "low",
      "--title",
      "题目",
    ],
    { client, stdout: capture().stream, stderr: capture().stream },
  );

  assert.equal(code, 0);
  assert.equal(settingsRead, 0);
  assert.deepEqual(created, {
    prompt: "做点事",
    providerId: "prov",
    model: "m9",
    effort: "low",
    title: "题目",
  });
});

for (const [phase, expected] of [
  ["completed", 0],
  ["needs_input", 2],
  ["failed", 1],
  ["stopped", 1],
]) {
  test(`session wait：${phase} 映射退出码 ${expected}`, async () => {
    const client = fakeClient({
      getSession: async (id) => ({ id, phase, title: "对话一" }),
    });
    const err = capture();
    const code = await runCli(["session", "wait", "s1"], {
      client,
      stdout: capture().stream,
      stderr: err.stream,
    });
    assert.equal(code, expected);
    if (phase === "needs_input") assert.match(err.text(), /需要人工输入/);
  });
}

test("session wait：超时退出码 3", async () => {
  const client = fakeClient({
    getSession: async (id) => ({ id, phase: "running", title: "对话一" }),
  });
  const err = capture();
  const code = await runCli(["session", "wait", "s1", "--timeout", "0"], {
    client,
    stdout: capture().stream,
    stderr: err.stream,
  });

  assert.equal(code, 3);
  assert.match(err.text(), /等待超时/);
});

test("session send --wait 发送后继续等待", async () => {
  let sends = 0;
  let polls = 0;
  const client = fakeClient({
    sendMessage: async (id) => {
      sends += 1;
      return { id, phase: "running", title: "对话一" };
    },
    getSession: async (id) => {
      polls += 1;
      return { id, phase: "completed", title: "对话一" };
    },
  });

  const code = await runCli(["session", "send", "s1", "继续", "--wait"], {
    client,
    stdout: capture().stream,
    stderr: capture().stream,
  });

  assert.equal(code, 0);
  assert.equal(sends, 1);
  assert.equal(polls, 1);
});

test("--json 时 stdout 只输出 JSON", async () => {
  const out = capture();
  const err = capture();
  const code = await runCli(["project", "list", "--json"], {
    client: fakeClient(),
    stdout: out.stream,
    stderr: err.stream,
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.text()), [{ id: "p1", name: "项目一", path: "/srv/p1" }]);
  assert.equal(err.text(), "");
});

test("runCli 把 API 错误写到 stderr 并返回 1", async () => {
  const client = fakeClient({
    getSession: async () => {
      throw new QubiusApiError("找不到对话", { status: 404 });
    },
  });
  const err = capture();
  const code = await runCli(["session", "show", "missing"], {
    client,
    stdout: capture().stream,
    stderr: err.stream,
  });

  assert.equal(code, 1);
  assert.match(err.text(), /找不到对话/);
  assert.match(err.text(), /HTTP 404/);
});

test("createClient 携带令牌、映射错误并支持超时", async () => {
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/api/projects") {
        assert.equal(req.headers["x-qubius-token"], "test-token");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ projects: [{ id: "p1" }] }));
        return;
      }
      if (req.url === "/api/slow") {
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 200);
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "请求坏了", echo: body }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const client = createClient({ url: `http://127.0.0.1:${port}`, token: "test-token" });

  try {
    assert.deepEqual(await client.listProjects(), [{ id: "p1" }]);

    await assert.rejects(
      () => client.request("GET", "/api/nope"),
      (error) => {
        assert.ok(error instanceof QubiusApiError);
        assert.equal(error.status, 400);
        assert.equal(error.message, "请求坏了");
        return true;
      },
    );

    await assert.rejects(
      () => client.request("GET", "/api/slow", { timeoutMs: 20 }),
      (error) => {
        assert.ok(error instanceof QubiusApiError);
        assert.match(error.message, /超时/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
