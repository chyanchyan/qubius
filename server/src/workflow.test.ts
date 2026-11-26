import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "./runtime.js";
import { detectWorkflowSkill, nextWorkflow } from "./status.js";
import { Store, type CreateSessionInput } from "./store.js";
import type { WorkflowSkill } from "./types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-workflow-"));
}

function createInput(id: string, prompt: string, workflow?: WorkflowSkill): CreateSessionInput {
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
    prompt,
    ...(workflow ? { workflow } : {}),
  };
}

function waitUntil(condition: () => boolean, timeout = 3000): Promise<void> {
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
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makeRuntime(store: Store): Runtime {
  return new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
    permission: () => "default",
    secrets: () => [],
  });
}

test("detectWorkflowSkill：末尾 token、标点、斜杠命令和词内子串", () => {
  assert.equal(detectWorkflowSkill("帮我实现 prl"), "prl");
  assert.equal(detectWorkflowSkill("帮我实现 prl。"), "prl");
  assert.equal(detectWorkflowSkill("帮我实现 PRL"), "prl");
  assert.equal(detectWorkflowSkill("实现prl"), "prl");
  assert.equal(detectWorkflowSkill("/ser 做这个"), "ser");
  assert.equal(detectWorkflowSkill("做这个 /plan"), "plan");
  assert.equal(detectWorkflowSkill("prl ser"), "ser");
  assert.equal(detectWorkflowSkill("parser"), null);
  assert.equal(detectWorkflowSkill("super"), null);
  assert.equal(detectWorkflowSkill("用 plan 模式"), null);
  assert.equal(detectWorkflowSkill("the plan"), null);
  assert.equal(detectWorkflowSkill("review the plan"), null);
  assert.equal(detectWorkflowSkill("做这个 plan"), "plan");
  assert.equal(detectWorkflowSkill("（plan）"), "plan");
  assert.equal(detectWorkflowSkill("大家讨论一下 discuss"), "discuss");
  assert.equal(detectWorkflowSkill("/discuss 这个方案"), "discuss");
  assert.equal(detectWorkflowSkill("拆开并行讨论 dis-prl"), "dis-prl");
  assert.equal(detectWorkflowSkill("拆开并行讨论 DIS-PRL"), "dis-prl");
  assert.equal(detectWorkflowSkill("/dis-prl 这个方案"), "dis-prl");
  assert.equal(detectWorkflowSkill(""), null);
});

test("nextWorkflow：显式选择优先于正文 token，两者都没有则不启用工作流", () => {
  assert.deepEqual(nextWorkflow("ser", "做这个 prl", "2026-01-01T00:02:00.000Z"), {
    skill: "ser",
    startedAt: "2026-01-01T00:02:00.000Z",
  });
  assert.deepEqual(nextWorkflow(undefined, "做这个 plan", "2026-01-01T00:02:00.000Z"), {
    skill: "plan",
    startedAt: "2026-01-01T00:02:00.000Z",
  });
  assert.deepEqual(nextWorkflow("discuss", "随便聊聊", "2026-01-01T00:02:00.000Z"), {
    skill: "discuss",
    startedAt: "2026-01-01T00:02:00.000Z",
  });
  assert.equal(nextWorkflow(undefined, "普通消息", "2026-01-01T00:02:00.000Z"), undefined);
});

test("create 支持显式 workflow 字段和正文末尾 token", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做这个 prl"));
    store.create(createInput("s2", "做这个", "ser"));
    store.create(createInput("s3", "普通对话"));
    assert.equal(store.require("s1").workflow?.skill, "prl");
    assert.equal(store.require("s2").workflow?.skill, "ser");
    assert.equal(store.require("s3").workflow, undefined);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("排队 prompt 的工作流要等上一轮 result 后才生效", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "第一轮"));
    store.beginTurn("s1");

    // 第一条 prompt 开始执行：没有工作流，进入 awaitingResult。
    store.setWorkflow("s1");
    assert.equal(store.require("s1").workflow, undefined);

    // SDK 在第一条还没 result 时提前拉走第二条和第三条：只排队，不能提前切换。
    store.setWorkflow("s1", "ser");
    store.setWorkflow("s1");
    assert.equal(store.require("s1").workflow, undefined);

    // 第一条 result：当前轮落定后才轮到第二条的 ser。
    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });
    assert.equal(store.require("s1").workflow?.skill, "ser");
    assert.equal(store.require("s1").workflow?.endedAt, undefined);

    // 第二条 result 后轮到第三条的普通对话：清空工作流。
    store.apply("s1", { type: "result", subtype: "success", uuid: "r2" });
    assert.equal(store.require("s1").workflow, undefined);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("排队 prompt 被折进同一轮时，result 之后不能再把会话标成运行中", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "第一轮"));
    store.beginTurn("s1");
    // 第一轮开始执行，进入 awaitingResult。
    store.setWorkflow("s1");
    // 用户趁 agent 干活时补发一条；SDK 提前把它拉走，随后折进这一轮，
    // 这一轮不会再为它补一条 result。
    store.setWorkflow("s1", "ser");
    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });

    // 这一轮已经落定：排队的 ser 只切换工作流，不能重新打开本轮。
    const settled = store.require("s1");
    assert.equal(settled.turnActive, false);
    assert.equal(settled.lastResult, "success");
    assert.equal(settled.phase, "completed");
    assert.equal(settled.workflow?.skill, "ser");

    // SDK 随后上报 idle：仍然保持完成态。
    store.apply("s1", {
      type: "system",
      subtype: "session_state_changed",
      uuid: "state-1",
      state: "idle",
    });
    const idle = store.require("s1");
    assert.equal(idle.turnActive, false);
    assert.equal(idle.phase, "completed");
    assert.equal(idle.workflow?.endedAt !== undefined, true);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("排队切换工作流不会清掉等待中的确认", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "第一轮"));
    store.beginTurn("s1");
    store.setWorkflow("s1");
    store.setPending("s1", {
      requestId: "r1",
      kind: "permission",
      toolName: "Bash",
      inputPreview: "rm -rf /",
    });
    // 等待确认期间 SDK 提前拉走下一条：workflow 只排队，pending 必须保留。
    store.setWorkflow("s1", "prl");
    assert.equal(store.require("s1").workflow, undefined);
    assert.equal(store.require("s1").pending?.requestId, "r1");
    assert.equal(store.require("s1").phase, "needs_input");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("子任务记录 workflowAt 和续跑次数；本轮结束后补 endedAt", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做这个", "prl"));
    const startedAt = store.require("s1").workflow?.startedAt;
    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "t1",
      task_id: "task-1",
      task_type: "local_agent",
      run_id: "run-1",
      description: "[wf:prl:1/1:dev] 登录接口",
    });
    store.apply("s1", {
      type: "system",
      subtype: "task_progress",
      uuid: "t2",
      task_id: "task-1",
      run_id: "run-1",
      summary: "正在改",
      last_tool_name: "Edit",
    });
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "t3",
      task_id: "task-1",
      task_type: "local_agent",
      run_id: "run-2",
      description: "[wf:prl:1/1:dev] 登录接口",
    });
    const agent = store.require("s1").subagents[0];
    assert.equal(agent?.workflowAt, startedAt);
    assert.equal(agent?.runs, 2);
    assert.equal(agent?.lastToolName, "Edit");

    store.apply("s1", {
      type: "system",
      subtype: "task_notification",
      uuid: "t4",
      task_id: "task-1",
      run_id: "run-2",
      status: "completed",
      summary: "完成",
    });
    store.apply("s1", { type: "result", subtype: "success", uuid: "result" });
    assert.ok(store.require("s1").workflow?.endedAt);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("排队消息的工作流在真正开始执行时才生效", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    const runtime = makeRuntime(store);
    store.create(createInput("s1", "慢慢来"));
    runtime.submit("s1", { text: "慢慢来", images: [] });
    await waitUntil(() => store!.require("s1").phase === "running");

    store.addUserMessage("s1", "第二条");
    runtime.submit("s1", { text: "第二条", images: [], workflow: "prl" });
    // 第一条还在跑，新工作流不能提前出现。
    assert.equal(store.require("s1").workflow, undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(store.require("s1").workflow, undefined);

    await waitUntil(() => store!.require("s1").workflow?.skill === "prl");
    const workflow = store.require("s1").workflow;
    assert.ok(workflow?.startedAt);
    // 第二轮刚开始时不能把上一轮的 completed 当成结束。
    assert.equal(workflow.endedAt, undefined);
    assert.equal(store.require("s1").phase, "running");
    await runtime.stop("s1");
    assert.ok(store.require("s1").workflow?.endedAt);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fake 的 prl 运行产生多个带标签的子任务并落到当前工作流", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    const runtime = makeRuntime(store);
    store.create(createInput("s1", "做这个", "prl"));
    runtime.submit("s1", { text: "做这个", images: [], workflow: "prl" });
    await waitUntil(() => store!.require("s1").phase === "completed", 5000);

    const session = store.require("s1");
    assert.equal(session.workflow?.skill, "prl");
    assert.ok(session.workflow?.endedAt);
    assert.equal(session.subagents.length, 4);
    assert.ok(session.subagents.every((agent) => agent.description.startsWith("[wf:prl:")));
    assert.ok(session.subagents.every((agent) => agent.workflowAt === session.workflow?.startedAt));
    assert.ok(session.subagents.every((agent) => agent.status === "completed"));
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("只在正文末尾写 token 也能触发 fake 多单元工作流", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    const runtime = makeRuntime(store);
    store.create(createInput("s1", "做这个 prl"));
    // 不带显式 workflow 字段，只靠正文末尾 token。
    runtime.submit("s1", { text: "做这个 prl", images: [] });
    await waitUntil(() => store!.require("s1").phase === "completed", 5000);

    const session = store.require("s1");
    assert.equal(session.workflow?.skill, "prl");
    assert.ok(session.workflow?.endedAt);
    assert.equal(session.subagents.length, 4);
    assert.ok(session.subagents.every((agent) => agent.description.startsWith("[wf:prl:")));
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fake 的 plan 运行产生计划和评审两个子任务", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    const runtime = makeRuntime(store);
    store.create(createInput("s1", "做个计划", "plan"));
    runtime.submit("s1", { text: "做个计划", images: [], workflow: "plan" });
    await waitUntil(() => store!.require("s1").phase === "completed", 5000);

    const session = store.require("s1");
    assert.equal(session.workflow?.skill, "plan");
    assert.ok(session.workflow?.endedAt);
    assert.equal(session.subagents.length, 2);
    assert.equal(session.subagents[0]?.description, "[wf:plan:1/1:dev] 开发计划");
    assert.equal(session.subagents[1]?.description, "[wf:plan:1/1:review] 开发计划");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("撤回还没执行的排队消息时给工作流补 endedAt", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做这个", "prl"));
    assert.equal(store.require("s1").queued, true);
    assert.equal(store.require("s1").workflow?.endedAt, undefined);
    store.cancelQueued("s1");
    const session = store.require("s1");
    assert.equal(session.phase, "stopped");
    assert.ok(session.workflow?.endedAt);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("轮次进行中 submit 再次 beginTurn 不会清掉 deferred 状态", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "第一轮"));
    store.beginTurn("s1");
    // 第一条 prompt 被消费，等待它的 result。
    store.setWorkflow("s1");

    // Runtime.submit 在轮次进行中会再次 beginTurn（把会话标成 running）。
    store.beginTurn("s1");
    // SDK 随后提前拉走第二条：必须仍然只排队，不能立刻切换。
    store.setWorkflow("s1", "prl");
    assert.equal(store.require("s1").workflow, undefined);

    // 第一条 result 之后，第二条的工作流才生效。
    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });
    assert.equal(store.require("s1").workflow?.skill, "prl");
    assert.equal(store.require("s1").workflow?.endedAt, undefined);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fake 的 ser 运行按单元串行产生开发和评审", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    const runtime = makeRuntime(store);
    store.create(createInput("s1", "做个串行任务", "ser"));
    runtime.submit("s1", { text: "做个串行任务", images: [], workflow: "ser" });
    await waitUntil(() => store!.require("s1").phase === "completed", 5000);

    const session = store.require("s1");
    assert.equal(session.workflow?.skill, "ser");
    assert.deepEqual(
      session.subagents.map((agent) => agent.description),
      [
        "[wf:ser:1/2:dev] 登录接口",
        "[wf:ser:1/2:review] 登录接口",
        "[wf:ser:2/2:dev] 会话存储",
        "[wf:ser:2/2:review] 会话存储",
      ],
    );
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("previewWorkflow：空闲发送立即生效，忙时保持当前轮", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "第一轮"));
    store.beginTurn("s1");
    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });

    // 空闲：立即写入 workflow，POST/summary 马上能读到；还没开始所以显示排队。
    store.previewWorkflow("s1", "prl", "做这个");
    assert.equal(store.require("s1").workflow?.skill, "prl");
    assert.equal(store.require("s1").phase, "queued");
    assert.equal(store.summary("s1", true).workflow?.skill, "prl");

    // 模拟 runtime 真正开始这一轮，再落定。
    store.beginTurn("s1");
    store.apply("s1", { type: "result", subtype: "success", uuid: "r2" });
    assert.ok(store.require("s1").workflow?.endedAt);
    store.previewWorkflow("s1", undefined, "普通消息");
    assert.equal(store.require("s1").workflow, undefined);

    // 忙时 preview 不动当前轮。
    store.beginTurn("s1");
    store.previewWorkflow("s1", "ser", "做这个");
    assert.equal(store.require("s1").workflow, undefined);

    // 空闲后正文末尾 token 也能立即生效。
    store.apply("s1", { type: "result", subtype: "success", uuid: "r3" });
    store.previewWorkflow("s1", undefined, "做这个 ser");
    assert.equal(store.require("s1").workflow?.skill, "ser");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
