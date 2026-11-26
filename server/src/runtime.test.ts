import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvalInput,
  approvalRequiresExpand,
  canRemember,
  clearRemembered,
  isRemembered,
  normalizeTaskOutput,
  pendingExpiresAt,
  PromptQueue,
  rememberKey,
  runConfigChanged,
  Runtime,
  sdkStartMode,
  sessionDirProblem,
  type Approval,
  type RunConfig,
} from "./runtime.js";
import { PROVISIONAL_TITLE, type TitleSummarizer, type TitleSummaryInput } from "./session-title.js";
import { ROOT_FORK_POINT } from "./session-rewind.js";
import { Store, type CreateSessionInput } from "./store.js";

/**
 * canSubmit 是纯同步的状态检查：用临时 Store + fake 模式覆盖空会话/正常会话，
 * 不启动任何 run，也不等待 30 秒的停止超时。
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-runtime-"));
}

function createInput(id: string): CreateSessionInput {
  return {
    id,
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "标题",
    providerId: "prov1",
    providerName: "服务商",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    prompt: "你好",
  };
}

function waitUntil(condition: () => boolean, timeout = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("等待条件超时"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 未完成`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function makeRuntime(
  dataDir: string,
  extra: { titleSummarizer?: TitleSummarizer } = {},
): { store: Store; runtime: Runtime } {
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
    permission: () => "default",
    secrets: () => [],
    ...extra,
  });
  return { store, runtime };
}

test("canSubmit：会话不存在时返回 404", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    assert.deepEqual(runtime.canSubmit("missing"), {
      ok: false,
      status: 404,
      error: "找不到对话",
    });
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("canSubmit：正常会话返回可提交", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    store.create(createInput("s1"));
    assert.deepEqual(runtime.canSubmit("s1"), { ok: true });
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("queueSnapshot 展示排队消息，cancelPrompt 可撤回且重复撤回返回 false", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    // 第一条含“慢”，fake 会等 1200ms，给后续消息留出排队窗口。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await new Promise((resolve) => setImmediate(resolve));

    runtime.submit("s1", { text: "第二条", images: [] });
    runtime.submit("s1", { text: "第三条", images: [] });

    const snapshot = runtime.queueSnapshot("s1");
    assert.deepEqual(snapshot.map((item) => item.text), ["第二条", "第三条"]);
    for (const item of snapshot) {
      assert.ok(item.id.length > 0);
      assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
      assert.equal(item.images, 0);
    }

    const target = snapshot[0]!.id;
    assert.equal(runtime.cancelPrompt("s1", target), true);
    assert.equal(runtime.cancelPrompt("s1", target), false);
    assert.deepEqual(runtime.queueSnapshot("s1").map((item) => item.text), ["第三条"]);

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("queueSnapshot 也覆盖还没开始运行的 buffered 消息", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtimeStore.create(createInput("s2"));
    // s1 占住唯一的并发槽，s2 的消息只能留在 buffered 里。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await new Promise((resolve) => setImmediate(resolve));
    runtime.submit("s2", { text: "等待中的消息", images: [] });

    const snapshot = runtime.queueSnapshot("s2");
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]!.text, "等待中的消息");
    assert.equal(runtime.cancelPrompt("s2", snapshot[0]!.id), true);
    assert.deepEqual(runtime.queueSnapshot("s2"), []);

    // 撤回最后一条排队消息后，Store 的排队标记必须同步清掉，不能永远显示“排队”。
    const cancelled = runtimeStore.get("s2");
    assert.equal(cancelled?.queued, false);
    assert.equal(cancelled?.phase, "stopped");

    await runtime.stop("s1");
    await runtime.stop("s2");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("live 队列已关闭时撤回 buffered 消息不会残留等待项或启动空 run", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 2,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtimeStore.create(createInput("s2"));
    runtimeStore.create(createInput("s3"));

    // s1 占住一个槽；s2 快速跑完一轮后 live 队列仍打开但已空闲。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    runtime.submit("s2", { text: "快一点", images: [] });
    await waitUntil(() => runtimeStore.get("s2")?.phase === "completed");

    // s3 入队会同步触发 releaseIdle，把 s2 空闲的 live 队列关掉。
    runtime.submit("s3", { text: "第三条", images: [] });

    // 此时 s2 的 live 队列已关闭但仍在 Map 里，submit 会落到 buffered：这是交叉窗口。
    // 下面三步之间不 await，确保取消发生在该微任务窗口内。
    runtime.submit("s2", { text: "撤回我", images: [] });
    const queued = runtime.queueSnapshot("s2");
    assert.equal(queued.length, 1);
    assert.equal(runtime.cancelPrompt("s2", queued[0]!.id), true);
    assert.deepEqual(runtime.queueSnapshot("s2"), []);

    // Store 的排队标记要清掉，且不能为 s2 启动空 run 占住后面的 s3。
    const cancelled = runtimeStore.get("s2");
    assert.equal(cancelled?.queued, false);
    assert.notEqual(cancelled?.phase, "queued");
    assert.notEqual(cancelled?.phase, "running");

    await waitUntil(() => runtimeStore.get("s3")?.phase === "completed", 800);

    await runtime.stop("s1");
    await runtime.stop("s2");
    await runtime.stop("s3");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PromptQueue：shouldRestart 为 true 时不消费消息并保留队列", async () => {
  const queue = new PromptQueue(() => true);
  queue.push({ id: "p1", createdAt: new Date().toISOString(), text: "你好", images: [] });
  const first = await queue.messages().next();
  assert.equal(first.done, true);
  assert.equal(queue.size, 1);
  assert.deepEqual(queue.snapshot().map((item) => item.id), ["p1"]);
});

test("PromptQueue：shouldRestart 为 false 时正常产出消息", async () => {
  const queue = new PromptQueue(() => false);
  queue.push({ id: "p1", createdAt: new Date().toISOString(), text: "你好", images: [] });
  const iterator = queue.messages();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(queue.size, 0);
  await iterator.return?.(undefined);
});

/** 从 PromptQueue 产出的 SDKUserMessage 里取出用户正文，方便断言顺序。 */
function queueText(message: { message: { content: unknown } }): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text"
      ? [(block as { text: string }).text]
      : []))
    .join("\n");
}

test("PromptQueue：排队消息要 releaseNext 才放行，promote 立即放行", async () => {
  const at = new Date().toISOString();
  const queue = new PromptQueue(() => false);
  queue.push({ id: "p1", createdAt: at, text: "先跑", images: [] });
  queue.push({ id: "p2", createdAt: at, text: "排队", images: [] }, true);
  const iterator = queue.messages();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(queueText(first.value!), "先跑");

  // 排队消息不能自己冒出来：轮末由 runtime 调 releaseNext。
  const blocked = iterator.next();
  assert.equal(await Promise.race([
    blocked.then(() => "yield"),
    new Promise((resolve) => setTimeout(() => resolve("wait"), 20)),
  ]), "wait");
  assert.equal(queue.releaseNext(), true);
  const second = await blocked;
  assert.equal(second.done, false);
  assert.equal(queueText(second.value!), "排队");
  // 已经没有排队项了。
  assert.equal(queue.releaseNext(), false);
  await iterator.return?.(undefined);

  // 插话 / 「现在发送」：promote 直接放行，不用等 result。
  const prompt = new PromptQueue(() => false);
  prompt.push({ id: "p1", createdAt: at, text: "先跑", images: [] });
  prompt.push({ id: "p2", createdAt: at, text: "插话", images: [] }, true);
  const promptIterator = prompt.messages();
  await promptIterator.next();
  const pending = promptIterator.next();
  assert.equal(await Promise.race([
    pending.then(() => "yield"),
    new Promise((resolve) => setTimeout(() => resolve("wait"), 20)),
  ]), "wait");
  assert.equal(prompt.promote("p2"), true);
  // 重复放行同一个也返回 true：它可能还没被 agent 取走。
  assert.equal(prompt.promote("p2"), true);
  assert.equal(prompt.promote("missing"), false);
  const promoted = await pending;
  assert.equal(queueText(promoted.value!), "插话");
  await promptIterator.return?.(undefined);
});

test("PromptQueue：edit 改写正文，remove 后 promote 失败", async () => {
  const at = new Date().toISOString();
  const queue = new PromptQueue(() => false);
  queue.push({ id: "p1", createdAt: at, text: "原文", images: [] });
  assert.equal(queue.edit("p1", "改过"), true);
  assert.equal(queue.edit("missing", "改过"), false);
  assert.equal(queue.snapshot()[0]?.text, "改过");
  assert.equal(queue.remove("p1"), true);
  assert.equal(queue.promote("p1"), false);
});

test("runConfigChanged：任一配置字段变化都返回 true", () => {
  const config: RunConfig = { providerId: "p1", model: "m1", effort: "high" };
  assert.equal(runConfigChanged(config, { ...config }), false);
  assert.equal(runConfigChanged(config, { ...config, providerId: "p2" }), true);
  assert.equal(runConfigChanged(config, { ...config, model: "m2" }), true);
  assert.equal(runConfigChanged(config, { ...config, effort: "low" }), true);
});

test("中途改 model/effort 后下一轮用新配置重启，不会误判失败", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "第一轮", images: [] });
    await waitUntil(() => runtimeStore.get("s1")?.phase === "completed");
    const before = runtimeStore.get("s1")?.messages.length ?? 0;

    // 轮间修改 provider/model/effort，下一条消息应触发旧 query 收尾、新配置重启。
    runtimeStore.updateRunConfig("s1", {
      providerId: "prov1",
      providerName: "服务商",
      model: "model-y",
      effort: "low",
    });
    runtime.submit("s1", { text: "第二轮", images: [] });

    await waitUntil(() => {
      const session = runtimeStore.get("s1");
      return !!session
        && session.phase === "completed"
        && session.lastResult === "success"
        && session.messages.length > before
        && !session.queued
        && !session.turnActive;
    }, 2000);

    const session = runtimeStore.get("s1");
    assert.equal(session?.phase, "completed");
    assert.equal(session?.lastResult, "success");
    assert.equal(session?.queued, false);
    assert.equal(session?.turnActive, false);
    assert.deepEqual(runtime.queueSnapshot("s1"), []);

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("空闲重启与连续提交并发时不会重复消费，也不会卡住停止", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 2,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "第一轮", images: [] });
    await waitUntil(() => runtimeStore.get("s1")?.phase === "completed");

    runtimeStore.updateRunConfig("s1", {
      providerId: "prov1",
      providerName: "服务商",
      model: "model-y",
      effort: "low",
    });
    // 同步连续两次提交：第一条触发空闲重启并关闭旧队列，第二条进入 buffered 并
    // 调用 schedule()。releasing 守卫必须阻止新 run 在旧 finally 之前启动。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    runtime.submit("s1", { text: "第二条", images: [] });

    // 新 run 已用新配置启动、正在消费“慢慢来”，队列里应当只剩“第二条”。
    await waitUntil(() => {
      const items = runtime.queueSnapshot("s1");
      return items.length === 1 && items[0]?.text === "第二条";
    });
    assert.deepEqual(runtime.queueSnapshot("s1").map((item) => item.text), ["第二条"]);

    // 停止必须及时结束：慢消息的 1200ms 等待应被 abort，不能等 30 秒 zombie 超时。
    const started = Date.now();
    await within(runtime.stop("s1"), 1000);
    assert.ok(Date.now() - started < 1000);
    assert.equal(runtimeStore.get("s1")?.phase, "stopped");
    assert.equal(runtimeStore.get("s1")?.queued, false);
    assert.equal(runtimeStore.get("s1")?.turnActive, false);
    assert.deepEqual(runtime.queueSnapshot("s1"), []);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("approvalInput：Bash 取原文，其他工具格式化 JSON，超长截断", () => {
  assert.deepEqual(approvalInput({ command: "echo a\necho b" }, "Bash"), {
    inputText: "echo a\necho b",
    inputTruncated: false,
  });
  assert.deepEqual(approvalInput({ file_path: "a.ts", content: "x" }, "Write"), {
    inputText: JSON.stringify({ file_path: "a.ts", content: "x" }, null, 2),
    inputTruncated: false,
  });
  const full = "x".repeat(64 * 1024 + 25);
  const long = approvalInput({ command: full }, "Bash");
  assert.equal(long.inputTruncated, true);
  assert.equal(long.inputText.length, 64 * 1024);
  assert.equal(long.inputText, full.slice(0, 64 * 1024));
});

test("approvalInput：按 UTF-8 字节截断，不切开多字节字符", () => {
  const full = "你".repeat(30_000); // 90000 字节
  const result = approvalInput({ command: full }, "Bash");
  assert.equal(result.inputTruncated, true);
  assert.ok(Buffer.byteLength(result.inputText, "utf8") <= 64 * 1024);
  assert.ok(!result.inputText.includes("�"));
  assert.ok(full.startsWith(result.inputText));
});

test("approvalRequiresExpand：Bash 看换行/长度，非 Bash 只看长度和截断", () => {
  assert.equal(approvalRequiresExpand("Bash", "echo hi", false), false);
  assert.equal(approvalRequiresExpand("Bash", "echo a\necho b", false), true);
  assert.equal(approvalRequiresExpand("Bash", "x".repeat(2000), false), false);
  assert.equal(approvalRequiresExpand("Bash", "x".repeat(2001), false), true);

  // 缩进 JSON 必然含换行，但小对象不应要求展开。
  const smallWrite = JSON.stringify({ file_path: "a.ts", content: "x" }, null, 2);
  assert.ok(smallWrite.includes("\n"));
  assert.equal(approvalRequiresExpand("Write", smallWrite, false), false);
  assert.equal(approvalRequiresExpand("Write", "x".repeat(8001), false), true);
  assert.equal(approvalRequiresExpand("Write", "x", true), true);
  assert.equal(approvalRequiresExpand("Bash", "x", true), true);
});

test("canRemember/rememberKey：只记住文件工具，按目录区分并规范化路径", () => {
  for (const tool of ["Bash", "Agent", "Task", "AskUserQuestion", "BashOutput", "KillBash", "Read"]) {
    assert.equal(canRemember(tool), false, tool);
  }
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(canRemember(tool), true, tool);
  }
  assert.equal(
    rememberKey("Write", { file_path: "/a/b/c.ts" }),
    `Write:${path.dirname(path.resolve("/a/b/c.ts"))}`,
  );
  assert.equal(
    rememberKey("Edit", { path: "src/x.ts" }),
    `Edit:${path.dirname(path.resolve("src/x.ts"))}`,
  );
  assert.equal(
    rememberKey("MultiEdit", { notebook_path: "nbs/a.ipynb" }),
    `MultiEdit:${path.dirname(path.resolve("nbs/a.ipynb"))}`,
  );
  assert.equal(
    rememberKey("NotebookEdit", { target_file: "x.ipynb" }),
    `NotebookEdit:${path.dirname(path.resolve("x.ipynb"))}`,
  );
  // 相对/绝对、`./` 写法指向同一目录时生成同一个键。
  assert.equal(
    rememberKey("Write", { file_path: "src/./x.ts" }),
    rememberKey("Write", { file_path: path.join(process.cwd(), "src", "y.ts") }),
  );
  // 路径取不到时退化成工具名。
  assert.equal(rememberKey("Write", {}), "Write");
  assert.equal(rememberKey("Bash", { command: "ls" }), "Bash");
});

test("isRemembered：只有文件工具按目录命中，命令和提问永不拦截", () => {
  const srcKey = rememberKey("Write", { file_path: "src/a.ts" });
  assert.equal(isRemembered(undefined, "Write", { file_path: "src/a.ts" }), false);
  assert.equal(isRemembered(new Set([srcKey]), "Write", { file_path: "src/b.ts" }), true);
  assert.equal(isRemembered(new Set([srcKey]), "Write", { file_path: "lib/c.ts" }), false);
  assert.equal(isRemembered(new Set(["Bash"]), "Bash", { command: "ls" }), false);
  assert.equal(isRemembered(new Set(["AskUserQuestion"]), "AskUserQuestion", {}), false);
});

test("需要展开的确认缺 approvedFull 时拒绝允许，补上后放行", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    store.create(createInput("s1"));
    let resolved: Approval | undefined;
    const waiters = (runtime as unknown as {
      waiters: Map<string, { requestId: string; resolve: (approval: Approval) => void; reject: (error: Error) => void }>;
    }).waiters;
    waiters.set("s1", {
      requestId: "r1",
      resolve: (approval) => {
        resolved = approval;
      },
      reject: () => undefined,
    });
    store.setPending("s1", {
      requestId: "r1",
      kind: "permission",
      toolName: "Bash",
      inputPreview: "a b",
      inputText: "a\nb",
      inputTruncated: false,
      requiresExpand: true,
    });

    assert.throws(() => runtime.answer("s1", "r1", { behavior: "allow" }), /需要展开完整输入后才能允许/);
    // 用 typeof 避免 TS 依据 assert.equal 把 resolved 窄化成 undefined。
    assert.equal(typeof resolved, "undefined");
    // 校验失败后确认仍在等待，补上 approvedFull 可以重试。
    runtime.answer("s1", "r1", { behavior: "allow", approvedFull: true });
    assert.equal(resolved?.behavior, "allow");
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("需要展开的确认直接拒绝不需要 approvedFull", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    store.create(createInput("s1"));
    let resolved: Approval | undefined;
    (runtime as unknown as {
      waiters: Map<string, { requestId: string; resolve: (approval: Approval) => void; reject: (error: Error) => void }>;
    }).waiters.set("s1", {
      requestId: "r1",
      resolve: (approval) => {
        resolved = approval;
      },
      reject: () => undefined,
    });
    store.setPending("s1", {
      requestId: "r1",
      kind: "permission",
      toolName: "Bash",
      inputPreview: "a b",
      inputText: "a\nb",
      inputTruncated: false,
      requiresExpand: true,
    });
    runtime.answer("s1", "r1", { behavior: "deny" });
    assert.equal(resolved?.behavior, "deny");
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("clearRemembered 清空指定会话的放行记录", () => {
  const remembered = new Map<string, Set<string>>([["s1", new Set(["Write:src"])]]);
  assert.equal(clearRemembered(remembered, "s1"), true);
  assert.equal(remembered.has("s1"), false);
  assert.equal(isRemembered(remembered.get("s1"), "Write", { file_path: "src/a.ts" }), false);
  assert.equal(clearRemembered(remembered, "missing"), false);
});

test("forgetApprovals 对没有记录的会话也安全", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const { store: runtimeStore, runtime } = makeRuntime(dataDir);
    store = runtimeStore;
    runtimeStore.create(createInput("s1"));
    runtime.forgetApprovals("s1");
    runtime.forgetApprovals("missing");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("runtime.stop 手动停止后对话记为已停止而不是失败", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    // fake 模式遇到“慢”会等待，给 stop 留出命中运行中会话的窗口。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await new Promise((resolve) => setImmediate(resolve));

    await runtime.stop("s1");

    const session = runtimeStore.get("s1");
    assert.equal(session?.phase, "stopped");
    assert.equal(session?.lastResult, "stopped");
    assert.equal(session?.lastError, "已停止");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("本轮已完成后 stop 只收掉空闲进程，不会把完成改写成已停止", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "你好", images: [] });
    // 等 fake 轮次落定：query 仍开着等待下一条消息，但会话已经“本轮完成”。
    await waitUntil(() => runtimeStore.get("s1")?.phase === "completed");

    await runtime.stop("s1");

    const session = runtimeStore.get("s1");
    assert.equal(session?.phase, "completed");
    assert.equal(session?.lastResult, "success");
    assert.equal(session?.lastError, undefined);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("normalizeTaskOutput：normalizes snake_case SDK response", () => {
  assert.deepEqual(
    normalizeTaskOutput({ output: "hello", total_bytes: 5, truncated: true }),
    { output: "hello", totalBytes: 5, truncated: true },
  );
});

test("normalizeTaskOutput：缺失字段按保守默认值处理", () => {
  assert.deepEqual(normalizeTaskOutput({}), { output: "", totalBytes: 0, truncated: false });
  assert.deepEqual(normalizeTaskOutput(undefined), { output: "", totalBytes: 0, truncated: false });
  assert.deepEqual(normalizeTaskOutput(null), { output: "", totalBytes: 0, truncated: false });
  // output 非字符串、bytes 缺失
  assert.deepEqual(
    normalizeTaskOutput({ output: 123, truncated: false }),
    { output: "", totalBytes: 0, truncated: false },
  );
});

test("normalizeTaskOutput：负数/NaN/Infinity 的字节数按 0，truncated 非 true 按 false", () => {
  assert.deepEqual(
    normalizeTaskOutput({ output: "x", total_bytes: -1, truncated: false }),
    { output: "x", totalBytes: 0, truncated: false },
  );
  assert.deepEqual(
    normalizeTaskOutput({ output: "x", total_bytes: Number.NaN, truncated: 1 }),
    { output: "x", totalBytes: 0, truncated: false },
  );
  assert.deepEqual(
    normalizeTaskOutput({ output: "x", total_bytes: Number.POSITIVE_INFINITY, truncated: "true" }),
    { output: "x", totalBytes: 0, truncated: false },
  );
  assert.deepEqual(
    normalizeTaskOutput({ output: "x", total_bytes: 0, truncated: 0 }),
    { output: "x", totalBytes: 0, truncated: false },
  );
});

test("没有活跃 query 时 taskOutput/backgroundTask/stopTask 分别拒绝", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    // fake 模式不创建 Query 句柄。
    await assert.rejects(runtime.taskOutput("s1", "task-1"), { message: "对话当前没有运行中的进程" });
    await assert.rejects(runtime.backgroundTask("s1", "tool-1"), { message: "对话当前没有运行中的进程" });
    await assert.rejects(runtime.stopTask("s1", "task-1"), { message: "对话当前没有运行中的进程" });
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("空 taskId/toolUseId 被拒绝", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    await assert.rejects(runtime.taskOutput("s1", "  "), { message: "缺少任务 id" });
    await assert.rejects(runtime.backgroundTask("s1", ""), { message: "缺少任务 id" });
    await assert.rejects(runtime.stopTask("s1", "\t\n"), { message: "缺少任务 id" });
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("任务控制方法转发到活跃 Query 句柄并保留 this", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    const calls: Array<[string, string]> = [];
    const handle = {
      async getTaskOutput(this: unknown, taskId: string) {
        assert.equal(this, handle);
        calls.push(["output", taskId]);
        return { output: "progress", total_bytes: 8, truncated: false };
      },
      async backgroundTasks(this: unknown, toolUseId: string) {
        assert.equal(this, handle);
        calls.push(["background", toolUseId]);
        return true;
      },
      async stopTask(this: unknown, taskId: string) {
        assert.equal(this, handle);
        calls.push(["stop", taskId]);
      },
    };
    // 直接注入私有 Map：只在测试里做，避免生产代码暴露测试专用 setter。
    (runtime as unknown as { queries: Map<string, unknown> }).queries.set("s1", handle);

    assert.deepEqual(
      await runtime.taskOutput("s1", " task-1 "),
      { output: "progress", totalBytes: 8, truncated: false },
    );
    assert.equal(await runtime.backgroundTask("s1", " tool-1 "), true);
    await runtime.stopTask("s1", " task-1 ");
    assert.deepEqual(calls, [
      ["output", "task-1"],
      ["background", "tool-1"],
      ["stop", "task-1"],
    ]);
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Query 不含 getTaskOutput 时给出明确错误", async () => {
  const dataDir = tempDir();
  try {
    const { store, runtime } = makeRuntime(dataDir);
    (runtime as unknown as { queries: Map<string, unknown> }).queries.set("s1", {
      backgroundTasks: async () => true,
      stopTask: async () => undefined,
    });
    await assert.rejects(runtime.taskOutput("s1", "task-1"), {
      message: "当前 SDK 不支持读取后台任务输出",
    });
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("有运行中的后台任务时 releaseIdle 不释放 query，下载结束后再让位", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtimeStore.create(createInput("s2"));

    // s1 本轮已完成，但后台下载还在跑：query 必须继续占用唯一的并发槽。
    runtime.submit("s1", { text: "快一点", images: [] });
    await waitUntil(() => runtimeStore.get("s1")?.phase === "completed");
    runtimeStore.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-1",
      task_id: "shell-1",
      task_type: "local_bash",
      description: "下载模型",
    });
    assert.equal(runtimeStore.get("s1")?.backgroundTasks?.[0]?.status, "running");

    runtime.submit("s2", { text: "快一点", images: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isActive("s1"), true);
    assert.equal(runtimeStore.get("s2")?.phase, "queued");

    // 后台任务结束后，s2 才应接手并发槽并完成。
    runtimeStore.apply("s1", {
      type: "system",
      subtype: "task_notification",
      uuid: "bg-2",
      task_id: "shell-1",
      status: "completed",
      summary: "下载完成",
    });
    runtime.submit("s2", { text: "再快一点", images: [] });
    await waitUntil(() => runtimeStore.get("s2")?.phase === "completed", 2000);

    await runtime.stop("s1");
    await runtime.stop("s2");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("run 收尾时调用 stopBackgroundTasks 收敛 running 后台任务", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtimeStore.beginTurn("s1");
    runtimeStore.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-1",
      task_id: "shell-1",
      task_type: "local_bash",
      description: "下载模型",
    });

    // 记录 Runtime finally 对 stopBackgroundTasks 的调用；用户 stop 先把任务收敛，
    // 所以这里主要验证“进程收尾时一定会调用”且幂等。
    const calls: Array<[string, string]> = [];
    const original = runtimeStore.stopBackgroundTasks.bind(runtimeStore);
    (runtimeStore as unknown as {
      stopBackgroundTasks: (id: string, summary: string) => void;
    }).stopBackgroundTasks = (id, summary) => {
      calls.push([id, summary]);
      original(id, summary);
    };

    runtime.submit("s1", { text: "慢慢来", images: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.stop("s1");

    assert.deepEqual(calls, [["s1", "对话进程已结束"]]);
    assert.equal(runtimeStore.get("s1")?.backgroundTasks?.[0]?.status, "stopped");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("setMaxConcurrent 调高后立即启动排队中的对话", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtimeStore.create(createInput("s2"));

    // s1 含“慢”字，fake 会占住唯一的并发槽约 1200ms；s2 只能排队。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    runtime.submit("s2", { text: "快一点", images: [] });
    assert.equal(runtimeStore.get("s2")?.phase, "queued");

    // 调高并发上限后不需要等 s1 结束，s2 应立刻开始并完成。
    runtime.setMaxConcurrent(2);
    await waitUntil(() => runtimeStore.get("s2")?.phase === "completed", 800);

    await runtime.stop("s1");
    await runtime.stop("s2");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("确认超时时间按当前时间加上服务端等待时长，0 表示不倒计时", () => {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(pendingExpiresAt(now, 10 * 60_000), "2026-01-02T03:14:05.000Z");
  assert.equal(pendingExpiresAt(now, 60_000), "2026-01-02T03:05:05.000Z");
  assert.equal(pendingExpiresAt(now, 0), undefined);
});

test("项目目录不存在时，开跑前给出可读错误而不是 SDK 的原始 stderr", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    const runtime = new Runtime(store, {
      maxConcurrent: 1,
      fake: false,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "acceptEdits",
      secrets: () => [],
    });
    const cwd = path.join(dataDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    store.create({
      ...createInput("s1"),
      projectPath: path.join(dataDir, "missing-project"),
      cwd,
      git: true,
    });

    runtime.submit("s1", { text: "你好", images: [] });
    await waitUntil(() => store.get("s1")?.phase === "failed");
    assert.match(store.get("s1")?.lastError ?? "", /项目目录不存在或不可访问/);
    assert.match(store.get("s1")?.lastError ?? "", /更新项目配置/);
    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sessionDirProblem：cwd 或项目目录缺失时分别报错", () => {
  const base = tempDir();
  try {
    const cwd = path.join(base, "work");
    const project = path.join(base, "project");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    assert.equal(sessionDirProblem({ cwd, projectPath: project }), undefined);
    assert.match(sessionDirProblem({ cwd: path.join(base, "gone"), projectPath: project }) ?? "", /工作目录/);
    assert.match(sessionDirProblem({ cwd, projectPath: path.join(base, "gone") }) ?? "", /项目目录/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("PromptQueue：yield 的 SDKUserMessage 带上排队时给的 uuid", async () => {
  const queue = new PromptQueue(() => false);
  queue.push({
    id: "p1",
    createdAt: new Date().toISOString(),
    text: "你好",
    images: [],
    uuid: "uuid-1",
  });
  const iterator = queue.messages();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.uuid, "uuid-1");
  await iterator.return?.(undefined);

  // 没有 uuid 时不要凭空生成一个：SDK 自行分配 chain uuid。
  const plain = new PromptQueue(() => false);
  plain.push({ id: "p2", createdAt: new Date().toISOString(), text: "无 uuid", images: [] });
  const plainIterator = plain.messages();
  const second = await plainIterator.next();
  assert.equal(second.done, false);
  assert.equal(second.value && "uuid" in second.value, false);
  await plainIterator.return?.(undefined);
});

test("sdkStartMode：回滚新建、首次新建、其余 resume", () => {
  // 回滚到最开始：即使有 claudeSessionId 也必须新建（不能 resume 旧 transcript）。
  assert.deepEqual(sdkStartMode({ id: "s1", claudeSessionId: "sdk-1", newSdkSession: true }), {
    kind: "new",
    id: "sdk-1",
  });
  // 从未跑过：沿用本地会话 id 新建。
  assert.deepEqual(sdkStartMode({ id: "s1" }), { kind: "new", id: "s1" });
  // 有 SDK 会话且没有回滚标记：resume。
  assert.deepEqual(sdkStartMode({ id: "s1", claudeSessionId: "sdk-1" }), {
    kind: "resume",
    id: "sdk-1",
  });
});

test("fake 模式：isFake、文件检查点回滚与分叉接口", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const { store: runtimeStore, runtime } = (() => {
      const s = new Store(dataDir);
      return { store: s, runtime: new Runtime(s, {
        maxConcurrent: 1,
        fake: true,
        credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
        permission: () => "default",
        secrets: () => [],
      }) };
    })();
    store = runtimeStore;

    assert.equal(runtime.isFake(), true);
    assert.equal(runtime.canRewindFiles("s1"), false);
    await assert.rejects(runtime.rewindFiles("s1", "u1"), /没有运行中的进程/);

    // transcript / fork 接口不依赖进程存活。
    const forked = await runtime.forkSdkSession("source-sdk", "up-to", "/tmp/project");
    assert.equal(typeof forked, "string");
    assert.ok(forked.length > 0);
    assert.deepEqual(await runtime.sdkSessionMessages("sdk-1", "/tmp/project"), []);

    // 进程活跃时文件检查点可用，回滚返回空改动。
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await waitUntil(() => runtime.isActive("s1"));
    assert.equal(runtime.canRewindFiles("s1"), true);
    assert.deepEqual(await runtime.rewindFiles("s1", "u1"), {
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });

    await runtime.stop("s1");
    assert.equal(runtime.canRewindFiles("s1"), false);
    await assert.rejects(runtime.rewindFiles("s1", "u1"), /没有运行中的进程/);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fake 运行会回显 user 消息并在 applySdkMessage 里写入 forkPoint", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const { store: runtimeStore, runtime } = makeRuntime(dataDir);
    store = runtimeStore;
    runtimeStore.create({ ...createInput("s1"), sdkUuid: "sdk-u1" });
    runtime.submit("s1", { text: "你好", images: [], uuid: "sdk-u1" });

    await waitUntil(() => store?.get("s1")?.messages[0]?.forkPoint !== undefined);
    assert.equal(store.get("s1")?.messages[0]?.forkPoint, ROOT_FORK_POINT);

    // 截断点只在 user 回显路径记录：Store 上不再有 onConsume 用的旧方法。
    assert.equal("markPromptConsumed" in Store.prototype, false);

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fake 运行：两条排队 prompt 都通过 user 回显记录 forkPoint", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const { store: runtimeStore, runtime } = makeRuntime(dataDir);
    store = runtimeStore;
    runtimeStore.create({ ...createInput("s1"), prompt: "第一问", sdkUuid: "sdk-u1" });
    runtimeStore.addUserMessage("s1", "第二问", [], "sdk-u2");

    runtime.submit("s1", { text: "第一问", images: [], uuid: "sdk-u1" });
    runtime.submit("s1", { text: "第二问", images: [], uuid: "sdk-u2" });

    await waitUntil(() => {
      const users = store?.get("s1")?.messages.filter((item) => item.role === "user") ?? [];
      return users.length >= 2 && users.every((item) => item.forkPoint !== undefined);
    });
    const users = store.get("s1")!.messages.filter((item) => item.role === "user");
    assert.equal(users[0]?.forkPoint, ROOT_FORK_POINT);
    // 第二条截断点已推进到第一条之后（fake 在两条 prompt 之间会插入 assistant，
    // 所以这里不要求恰好等于 sdk-u1；背靠背 echo 的精确断言见下一条测试）。
    assert.notEqual(users[1]?.forkPoint, ROOT_FORK_POINT);
    assert.notEqual(users[1]?.forkPoint, users[1]?.sdkUuid);

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("排队消息排在正在运行的那一轮之后，被 agent 取走后才让后续输出跟进", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const { store: runtimeStore, runtime } = makeRuntime(dataDir);
    store = runtimeStore;
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "慢慢来", images: [] });
    // 第一轮的正文还没到达时又排了一条：它固定在记录末尾等着。
    runtime.submit("s1", { text: "第二条", images: [] });

    // 第一轮的正文到达后，排队消息仍然排在它后面，而不是停在发送位置。
    await waitUntil(() => runtimeStore.get("s1")?.messages.some((item) => item.role === "assistant") === true);
    const during = runtimeStore.get("s1")!.messages;
    assert.equal(during.at(-1)?.text, "第二条");
    assert.equal(during.at(-1)?.queued, true);
    assert.ok(during.slice(0, -1).some((item) => item.role === "assistant"));

    // 轮末放行、agent 取走：标记清除，第二条自己的输出接在它后面。
    await waitUntil(() => {
      const messages = runtimeStore.get("s1")?.messages ?? [];
      const index = messages.findIndex((item) => item.text === "第二条");
      return index >= 0
        && messages.every((item) => item.queued !== true)
        && messages.slice(index + 1).some((item) => item.role === "assistant");
    }, 3000);
    const after = runtimeStore.get("s1")!.messages;
    assert.ok(after.findIndex((item) => item.text === "第二条") < after.length - 1);

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("首个成功轮次后用 agent 总结替换占位标题", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const calls: TitleSummaryInput[] = [];
    const { store: runtimeStore, runtime } = makeRuntime(dataDir, {
      titleSummarizer: async (input) => {
        calls.push(input);
        return "修复登录接口超时。";
      },
    });
    store = runtimeStore;
    runtimeStore.create({
      ...createInput("s1"),
      prompt: "修一下登录",
      title: PROVISIONAL_TITLE,
      titlePending: true,
    });
    runtime.submit("s1", { text: "修一下登录", images: [] });

    await waitUntil(() => store?.get("s1")?.title === "修复登录接口超时");
    assert.equal(store.get("s1")?.titlePending, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.request, "修一下登录");
    // result 消息的全文会作为最后一条助手正文落定，标题总结取的是它。
    assert.match(calls[0]?.reply ?? "", /本地假运行/);
    assert.equal(calls[0]?.providerId, "prov1");
    assert.equal(calls[0]?.model, "model-x");

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("失败的轮次不生成标题，占位标题保持原样", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    let calls = 0;
    const { store: runtimeStore, runtime } = makeRuntime(dataDir, {
      titleSummarizer: async () => {
        calls += 1;
        return "不该出现的标题";
      },
    });
    store = runtimeStore;
    runtimeStore.create({
      ...createInput("s1"),
      prompt: "一个会失败的任务",
      title: PROVISIONAL_TITLE,
      titlePending: true,
    });
    runtime.submit("s1", { text: "一个会失败的任务", images: [] });

    await waitUntil(() => store?.get("s1")?.phase === "failed");
    assert.equal(calls, 0);
    assert.equal(store.get("s1")?.title, PROVISIONAL_TITLE);
    assert.equal(store.get("s1")?.titlePending, true);

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("没有占位标记的旧会话不会触发标题总结", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    let calls = 0;
    const { store: runtimeStore, runtime } = makeRuntime(dataDir, {
      titleSummarizer: async () => {
        calls += 1;
        return "不该出现的标题";
      },
    });
    store = runtimeStore;
    // createInput 没有 titlePending，模拟升级前就存在的会话。
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "你好", images: [] });

    await waitUntil(() => store?.get("s1")?.phase === "completed");
    assert.equal(calls, 0);
    assert.equal(store.get("s1")?.title, "标题");

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("总结返回前用户手动改名，总结结果不会覆盖", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const { store: runtimeStore, runtime } = makeRuntime(dataDir, {
      titleSummarizer: async () => {
        started = true;
        await gate;
        return "agent 总结的标题";
      },
    });
    store = runtimeStore;
    runtimeStore.create({
      ...createInput("s1"),
      prompt: "修一下登录",
      title: PROVISIONAL_TITLE,
      titlePending: true,
    });
    runtime.submit("s1", { text: "修一下登录", images: [] });
    await waitUntil(() => started);

    runtimeStore.updateMeta("s1", { title: "我自己起的标题" });
    release();
    // 等后台总结跑完再断言；它应该因为 titlePending 已清除而放弃写入。
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(store.get("s1")?.title, "我自己起的标题");

    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("主轮结束后残留的 running 子任务不会把新消息永久挂住", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtime.submit("s1", { text: "第一轮", images: [] });
    await waitUntil(() => runtimeStore.get("s1")?.phase === "completed");
    // 模拟进程级残留：主轮已经 result，子任务却一直 running。它不会再补
    // result 来放行排队消息，所以新消息不能因为“看起来忙”而一直排队。
    runtimeStore.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "stale-task-start",
      task_id: "stale-task",
      task_type: "local_agent",
      description: "残留子任务",
    });
    assert.ok(runtimeStore.get("s1")?.subagents.some((item) => item.status === "running"));

    runtime.submit("s1", { text: "第二轮", images: [] });
    await waitUntil(
      () => (runtimeStore.get("s1")?.messages.filter((item) => item.role === "assistant").length ?? 0) >= 2,
      3000,
    );
    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("还没启动的会话里，promotePrompt 把消息挪到最前面", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    runtimeStore.create(createInput("s2"));
    // s1 占住唯一的并发槽，s2 的两条消息都留在 buffered 里。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await new Promise((resolve) => setImmediate(resolve));
    runtime.submit("s2", { text: "第一条", images: [] });
    runtime.submit("s2", { text: "第二条", images: [] });
    const before = runtime.queueSnapshot("s2");
    assert.deepEqual(before.map((item) => item.text), ["第一条", "第二条"]);
    assert.equal(runtime.promotePrompt("s2", before[1]!.id), true);
    assert.deepEqual(runtime.queueSnapshot("s2").map((item) => item.text), ["第二条", "第一条"]);
    assert.equal(runtime.promotePrompt("s2", "missing"), false);

    await runtime.stop("s1");
    await runtime.stop("s2");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("默认排队的消息在上一轮结束后自动开跑，不会被永久挂起", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const runtimeStore = new Store(dataDir);
    store = runtimeStore;
    const runtime = new Runtime(runtimeStore, {
      maxConcurrent: 1,
      fake: true,
      credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
      permission: () => "default",
      secrets: () => [],
    });
    runtimeStore.create(createInput("s1"));
    // 第一条是慢轮，第二条默认排队：要等 result 之后才被放行。
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await new Promise((resolve) => setImmediate(resolve));
    runtime.submit("s1", { text: "排队第二条", images: [] });
    assert.equal(runtime.queueSnapshot("s1")[0]?.interjecting, undefined);

    await waitUntil(() => {
      const session = runtimeStore.get("s1");
      return !!session
        && session.phase === "completed"
        && runtime.queueSnapshot("s1").length === 0;
    }, 5000);

    const session = runtimeStore.get("s1");
    assert.equal(session?.phase, "completed");
    // 两轮都真的跑了（每轮 fake 都会写一条助理消息）。
    assert.ok((session?.messages.filter((item) => item.role === "assistant").length ?? 0) >= 2);
    await runtime.stop("s1");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PromptQueue 背靠背取走两条 prompt 时，第二条 forkPoint 指向第一条 uuid", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create({ ...createInput("s1"), prompt: "第一问", sdkUuid: "sdk-u1" });
    store.addUserMessage("s1", "第二问", [], "sdk-u2");

    // 模拟真实 SDK 的 streaming input：两条 prompt 在一条 turn 内被连续取走。
    const queue = new PromptQueue(() => false);
    queue.push({ id: "p1", createdAt: new Date().toISOString(), text: "第一问", images: [], uuid: "sdk-u1" });
    queue.push({ id: "p2", createdAt: new Date().toISOString(), text: "第二问", images: [], uuid: "sdk-u2" });
    const iterator = queue.messages();
    for (let index = 0; index < 2; index += 1) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      const value = next.value;
      if (!value) continue;
      store.apply("s1", {
        type: "user",
        uuid: value.uuid,
        parent_tool_use_id: null,
        message: { role: "user", content: value.message.content },
      });
    }
    await iterator.return?.(undefined);

    const users = store.get("s1")!.messages.filter((item) => item.role === "user");
    assert.equal(users[0]?.forkPoint, ROOT_FORK_POINT);
    assert.equal(users[1]?.forkPoint, "sdk-u1");

    await store.flush();
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
