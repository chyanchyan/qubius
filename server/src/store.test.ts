import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { ROOT_FORK_POINT } from "./session-rewind.js";
import { PROVISIONAL_TITLE } from "./session-title.js";
import { Store, type CreateSessionInput, type SessionEvent } from "./store.js";
import type { BackgroundTask, Effort, SessionCore } from "./types.js";

/**
 * 只测落盘的离散行为（flush / 删除 / 启动清理），不触碰 1 秒防抖和
 * 5 秒 max-wait 的真实等待，避免测试变慢和不稳定。
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-store-"));
}

function createInput(id: string, prompt: string): CreateSessionInput {
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
  };
}

function sessionsDir(dataDir: string): string {
  return path.join(dataDir, "sessions");
}

function sessionFile(dataDir: string, id: string): string {
  return path.join(sessionsDir(dataDir), `${id}.json`);
}

function readSession(dataDir: string, id: string): SessionCore {
  return JSON.parse(fs.readFileSync(sessionFile(dataDir, id), "utf8")) as SessionCore;
}

function tmpFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")) : [];
}

function minimalSession(id: string): SessionCore {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "旧会话",
    providerId: "prov1",
    providerName: "服务商",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    summary: "",
    phase: "queued",
    turnActive: false,
    queued: false,
    subagents: [],
    messages: [],
    pending: null,
    seen: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 直接把会话写进 sessions 目录，用来构造固定 createdAt 的旧数据。 */
function writeSessionFile(dataDir: string, session: SessionCore): void {
  const dir = sessionsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("create 后 flush，会话文件存在且是最新快照", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "第一问"));
    await store.flush();

    const file = sessionFile(dataDir, "s1");
    assert.equal(fs.existsSync(file), true);

    const saved = readSession(dataDir, "s1");
    assert.equal(saved.id, "s1");
    assert.equal(saved.summary, "第一问");
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0]?.text, "第一问");
    // 内存与磁盘一致（undefined 字段经 JSON 往返后同样被丢弃）。
    assert.deepEqual(saved, JSON.parse(JSON.stringify(store.get("s1"))) as SessionCore);
    assert.deepEqual(tmpFiles(sessionsDir(dataDir)), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("summary 用 cwd 是否落在项目目录外标记 isolated", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create({ ...createInput("s1", "普通对话"), cwd: "/tmp/project/s1" });
    store.create(createInput("s2", "项目对话"));
    store.create({ ...createInput("s3", "worktree"), cwd: "/tmp/project/s3", git: true });
    await store.flush();

    assert.equal(store.summary("s1").isolated, true);
    assert.equal(store.summary("s2").isolated, false);
    assert.equal(store.summary("s3").isolated, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("连续 commit 在防抖窗口内只落最新快照，flush 后无残留 tmp", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "起点"));
    await store.flush();

    const file = sessionFile(dataDir, "s1");
    assert.equal(readSession(dataDir, "s1").messages.length, 1);

    store.addUserMessage("s1", "二");
    store.addUserMessage("s1", "三");
    store.addUserMessage("s1", "四");

    // 防抖窗口是 1 秒；同步代码执行期间计时器不可能触发，磁盘上仍是旧快照。
    assert.equal(readSession(dataDir, "s1").messages.length, 1);

    await store.flush();
    const saved = readSession(dataDir, "s1");
    assert.deepEqual(saved.messages.map((item) => item.text), ["起点", "二", "三", "四"]);
    assert.equal(saved.summary, "四");
    assert.equal(saved.updatedAt, store.get("s1")?.updatedAt);
    assert.deepEqual(tmpFiles(sessionsDir(dataDir)), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("remove 后内存与磁盘上的会话都消失", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "待删除"));
    await store.flush();

    const file = sessionFile(dataDir, "s1");
    assert.equal(fs.existsSync(file), true);

    assert.equal(store.remove("s1")?.id, "s1");
    assert.equal(store.get("s1"), undefined);
    assert.equal(fs.existsSync(file), false);
    // 不存在的会话删除是幂等的。
    assert.equal(store.remove("s1"), undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("load 时清掉崩溃残留的 *.tmp，同时正常加载 json", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const dir = sessionsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "orphan.json.42.1.tmp"), "{}");
    fs.writeFileSync(path.join(dir, "stray.tmp"), "{}");
    fs.writeFileSync(path.join(dir, "s1.json"), JSON.stringify(minimalSession("s1")));
    if (process.platform !== "win32") fs.chmodSync(dir, 0o755);

    store = new Store(dataDir);
    assert.deepEqual(tmpFiles(dir), []);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
    assert.equal(store.get("s1")?.title, "旧会话");
    assert.equal(store.list().length, 1);
  } finally {
    // load 可能因 recover 排了防抖写；等它完成后再删临时目录，避免定时器把目录重建。
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emit 只广播 summary，messages 要显式取 detail", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    const events: SessionEvent[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    const session = store.create(createInput("s1", "第一问"));
    unsubscribe();

    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, "s1");
    // 事件不带 messages（全量复制很贵），Board 订阅直接用这份 summary。
    assert.equal(events[0]?.messages, undefined);
    // Detail 订阅才显式取完整 detail。
    assert.deepEqual(store.summary(session.id, true).messages?.map((item) => item.text), ["第一问"]);
    assert.equal(store.summary(session.id, false).messages, undefined);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("turnEnd 只在本轮落定时增加，后台子 agent 收尾不算新的一轮", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    const events: SessionEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "task-start",
      task_id: "a1",
      task_type: "local_agent",
      description: "后台子任务",
    });
    await delay(120);
    assert.equal(events.at(-1)?.turnEnd, 0);

    // result 先到，后台子 agent 还没结束：本轮计数 +1，phase 仍是 running。
    store.apply("s1", { type: "result", subtype: "success", uuid: "result-1" });
    await delay(120);
    const ended = events.at(-1);
    assert.equal(ended?.turnEnd, 1);
    assert.equal(ended?.lastResult, "success");
    assert.equal(ended?.phase, "running");

    // 子 agent 结束只让 phase 落到 completed，轮次计数不变。
    store.apply("s1", {
      type: "system",
      subtype: "task_notification",
      uuid: "task-end",
      task_id: "a1",
      status: "completed",
    });
    await delay(120);
    const settled = events.at(-1);
    assert.equal(settled?.turnEnd, 1);
    assert.equal(settled?.phase, "completed");
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：beginTurn 记录开始，落定后记录结束", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    assert.equal(store.summary("s1", false).runStartedAt, undefined);
    assert.equal(store.summary("s1", false).runEndedAt, undefined);

    store.beginTurn("s1");
    const started = store.summary("s1", false).runStartedAt;
    assert.ok(started);
    assert.equal(store.summary("s1", false).runEndedAt, undefined);

    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });
    const summary = store.summary("s1", false);
    assert.equal(summary.phase, "completed");
    assert.ok(summary.runEndedAt);
    assert.ok(summary.runEndedAt >= (started as string));
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：主轮结束后子 agent 还在收尾时继续计时，完全落定才写结束时间", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "task-start",
      task_id: "a1",
      task_type: "local_agent",
      description: "后台子任务",
    });
    store.apply("s1", { type: "result", subtype: "success", uuid: "result-1" });
    // 主轮已结束，但子 agent 还没收尾：phase 仍是 running，不能写结束时间。
    assert.equal(store.summary("s1", false).phase, "running");
    assert.equal(store.summary("s1", false).runEndedAt, undefined);

    store.apply("s1", {
      type: "system",
      subtype: "task_notification",
      uuid: "task-end",
      task_id: "a1",
      status: "completed",
    });
    const settled = store.summary("s1", false);
    assert.equal(settled.phase, "completed");
    assert.ok(settled.runEndedAt);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：新一轮重置开始时间并清空结束时间", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    const first = store.summary("s1", false).runStartedAt;
    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });
    assert.ok(store.summary("s1", false).runEndedAt);

    await delay(5);
    store.beginTurn("s1");
    const next = store.summary("s1", false);
    assert.ok(next.runStartedAt);
    assert.notEqual(next.runStartedAt, first);
    assert.equal(next.runEndedAt, undefined);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：SDK 仍在跑时不写结束时间，收到 idle 才落定", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "session_state_changed",
      uuid: "state-1",
      state: "running",
    });
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "task-start",
      task_id: "a1",
      task_type: "local_agent",
      description: "后台子任务",
    });
    store.apply("s1", { type: "result", subtype: "success", uuid: "result-1" });
    store.apply("s1", {
      type: "system",
      subtype: "task_notification",
      uuid: "task-end",
      task_id: "a1",
      status: "completed",
    });
    // 子任务和主轮 result 都结束了，但 SDK 还在继续跑（例如整体集成验证）：
    // 不能因为“没有子 agent 在跑”就写结束时间。
    assert.equal(store.summary("s1", false).phase, "running");
    assert.equal(store.summary("s1", false).runEndedAt, undefined);

    store.apply("s1", {
      type: "system",
      subtype: "session_state_changed",
      uuid: "state-2",
      state: "idle",
    });
    const settled = store.summary("s1", false);
    assert.equal(settled.phase, "completed");
    assert.ok(settled.runEndedAt);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：落定后 SDK 继续跑会清掉旧的结束时间", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    store.apply("s1", { type: "result", subtype: "success", uuid: "r1" });
    assert.ok(store.summary("s1", false).runEndedAt);

    // 后台子 agent 的通知让主 agent 接着跑：phase 回到运行中，旧的结束时间必须作废，
    // 否则列表会一直显示“结束”。
    store.apply("s1", {
      type: "system",
      subtype: "session_state_changed",
      uuid: "state-1",
      state: "running",
    });
    const resumed = store.summary("s1", false);
    assert.equal(resumed.phase, "running");
    assert.equal(resumed.runEndedAt, undefined);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("停止会清掉 SDK 状态，会话立即落定为已停止", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "session_state_changed",
      uuid: "state-1",
      state: "running",
    });
    store.stop("s1", "已停止");
    const stopped = store.summary("s1", false);
    assert.equal(stopped.phase, "stopped");
    assert.ok(stopped.runEndedAt);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("启动恢复时丢弃进程级的 SDK 状态", async () => {
  const dataDir = tempDir();
  try {
    // 磁盘上残留 running 的 agentState，但会话其实已经落定；重启后不能继续撑成运行中。
    const settled = minimalSession("settled");
    settled.phase = "completed";
    settled.lastResult = "success";
    settled.turnActive = false;
    settled.agentState = "running";
    settled.updatedAt = "2026-01-01T00:01:00.000Z";
    writeSessionFile(dataDir, settled);

    const store = new Store(dataDir);
    try {
      assert.equal(store.summary("settled", false).phase, "completed");
    } finally {
      await store.flush().catch(() => undefined);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：运行中追加消息不重置本轮起点", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "跑任务"));
    store.beginTurn("s1");
    const started = store.summary("s1", false).runStartedAt;
    // 运行中再追加一条消息时 runtime 也会调用 beginTurn；起点必须保持不变。
    store.beginTurn("s1");
    assert.equal(store.summary("s1", false).runStartedAt, started);
    assert.equal(store.summary("s1", false).runEndedAt, undefined);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("activeCount 只统计仍在推进的会话", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("running", "跑任务"));
    store.beginTurn("running");
    store.create(createInput("stopped", "另一个"));
    store.stop("stopped", "已停止");

    assert.equal(store.activeCount(), 1);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时间：启动恢复时补结束时间，运行中的会话收成失败", async () => {
  const dataDir = tempDir();
  try {
    // 旧数据没有 runEndedAt：落定后按最后一次更新时间补一个近似值。
    const finished = minimalSession("done");
    finished.phase = "completed";
    finished.lastResult = "success";
    finished.updatedAt = "2026-01-01T00:01:00.000Z";
    writeSessionFile(dataDir, finished);

    // 重启时还在跑：收成失败，并保留开始时间、补上结束时间。
    const running = minimalSession("run");
    running.phase = "running";
    running.turnActive = true;
    running.runStartedAt = "2026-01-01T00:01:30.000Z";
    running.updatedAt = "2026-01-01T00:02:00.000Z";
    writeSessionFile(dataDir, running);

    const store = new Store(dataDir);
    try {
      assert.equal(store.summary("done", false).runEndedAt, "2026-01-01T00:01:00.000Z");
      const recovered = store.summary("run", false);
      assert.equal(recovered.phase, "failed");
      assert.equal(recovered.runStartedAt, "2026-01-01T00:01:30.000Z");
      assert.equal(recovered.runEndedAt, "2026-01-01T00:02:00.000Z");
    } finally {
      await store.flush().catch(() => undefined);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("启动恢复：上一轮结束后才被记成停止的会话恢复为完成", async () => {
  const dataDir = tempDir();
  try {
    // 旧版本重启时把已经完成的会话改写成停止：runEndedAt 比 updatedAt 早 9 分钟。
    const finished = minimalSession("done");
    finished.phase = "stopped";
    finished.lastResult = "stopped";
    finished.lastError = "已停止";
    finished.summary = "已停止";
    finished.runStartedAt = "2026-01-01T00:00:00.000Z";
    finished.runEndedAt = "2026-01-01T00:01:00.000Z";
    finished.updatedAt = "2026-01-01T00:10:00.000Z";
    finished.workflow = {
      skill: "prl",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:30.000Z",
    };
    finished.messages = [{
      id: "m1",
      role: "assistant",
      text: "全部完成。",
      at: "2026-01-01T00:02:00.000Z",
    }];
    writeSessionFile(dataDir, finished);

    // 完成两秒后进程就重启了：同样说明停的是空闲进程，不是这一轮。
    const recent = minimalSession("recent");
    recent.phase = "stopped";
    recent.lastResult = "stopped";
    recent.lastError = "已停止";
    recent.summary = "已停止";
    recent.runEndedAt = "2026-01-01T00:30:00.000Z";
    recent.updatedAt = "2026-01-01T00:30:02.000Z";
    recent.messages = [{ id: "m2", role: "assistant", text: "做完了。", at: "2026-01-01T00:30:00.000Z" }];
    writeSessionFile(dataDir, recent);

    // 同一时刻停止的会话是真的中断了这一轮，保持已停止。
    const stopped = minimalSession("stopped");
    stopped.phase = "stopped";
    stopped.lastResult = "stopped";
    stopped.lastError = "已停止";
    stopped.summary = "已停止";
    stopped.runStartedAt = "2026-01-01T00:20:00.000Z";
    stopped.runEndedAt = "2026-01-01T00:21:00.000Z";
    stopped.updatedAt = "2026-01-01T00:21:00.000Z";
    writeSessionFile(dataDir, stopped);

    const store = new Store(dataDir);
    try {
      const recovered = store.summary("done", false);
      assert.equal(recovered.phase, "completed");
      assert.equal(recovered.lastError, undefined);
      assert.equal(recovered.summary, "全部完成。");
      assert.equal(recovered.runEndedAt, "2026-01-01T00:02:00.000Z");
      assert.equal(recovered.workflow?.endedAt, "2026-01-01T00:02:00.000Z");
      assert.equal(store.summary("recent", false).phase, "completed");
      assert.equal(store.summary("recent", false).summary, "做完了。");

      const interrupted = store.summary("stopped", false);
      assert.equal(interrupted.phase, "stopped");
      assert.equal(interrupted.lastError, "已停止");
      assert.equal(interrupted.summary, "已停止");
    } finally {
      await store.flush().catch(() => undefined);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("会话目录 0700、会话文件 0600", async () => {
  if (process.platform === "win32") return;
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "权限"));
    await store.flush();

    assert.equal(fs.statSync(sessionsDir(dataDir)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sessionFile(dataDir, "s1")).mode & 0o777, 0o600);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("load 会尽力把已有会话文件权限收紧到 0600", async () => {
  if (process.platform === "win32") return;
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    const dir = sessionsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "s1.json");
    fs.writeFileSync(file, JSON.stringify(minimalSession("s1")), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);

    store = new Store(dataDir);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(store.get("s1")?.title, "旧会话");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("损坏的会话文件被跳过，只提示文件名", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  const warnings: string[] = [];
  const original = console.warn;
  try {
    const dir = sessionsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
    fs.writeFileSync(path.join(dir, "s1.json"), JSON.stringify(minimalSession("s1")));

    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    store = new Store(dataDir);

    assert.equal(store.get("s1")?.title, "旧会话");
    assert.equal(warnings.some((line) => line.includes("broken.json")), true);
    // 不把文件内容打进日志。
    assert.equal(warnings.some((line) => line.includes("not json")), false);
    // 坏文件原样保留，便于人工排查。
    assert.equal(fs.existsSync(path.join(dir, "broken.json")), true);
  } finally {
    console.warn = original;
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stop 把运行中的会话记为已停止并清空活动状态", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做点事"));
    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "task",
      task_id: "t1",
      task_type: "local_agent",
      description: "子任务",
    });
    store.apply("s1", {
      type: "stream_event",
      uuid: "delta",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "没写完" } },
    });
    store.setPending("s1", {
      requestId: "r1",
      kind: "permission",
      toolName: "Bash",
      inputPreview: "rm -rf /",
    });

    store.stop("s1", "已停止");

    const session = store.require("s1");
    assert.equal(session.phase, "stopped");
    assert.equal(session.lastResult, "stopped");
    assert.equal(session.lastError, "已停止");
    assert.equal(session.summary, "已停止");
    assert.equal(session.turnActive, false);
    assert.equal(session.queued, false);
    assert.equal(session.pending, null);
    assert.equal(session.subagents[0]?.status, "stopped");
    assert.equal(session.messages.some((item) => item.partial || item.streaming), false);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("停止后再次排队并停止仍会清空排队/确认状态", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做点事"));
    store.beginTurn("s1");
    store.stop("s1", "已停止");

    // 模拟并发槽已满：新消息只排队，没有进入 beginTurn，lastError 仍是上次的停止原因。
    store.markQueued("s1");
    store.setPending("s1", {
      requestId: "r1",
      kind: "permission",
      toolName: "Bash",
      inputPreview: "rm -rf /",
    });
    assert.equal(store.require("s1").queued, true);

    store.stop("s1", "已停止");

    const session = store.require("s1");
    assert.equal(session.phase, "stopped");
    assert.equal(session.lastResult, "stopped");
    assert.equal(session.queued, false);
    assert.equal(session.pending, null);
    assert.equal(session.turnActive, false);
    assert.equal(session.lastError, "已停止");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fail 仍把运行中的会话记为失败", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做点事"));
    store.beginTurn("s1");

    store.fail("s1", "出错了");

    const session = store.require("s1");
    assert.equal(session.phase, "failed");
    assert.equal(session.lastResult, "error");
    assert.equal(session.lastError, "出错了");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("summary detail 保留 assistant 消息的 at 和 usage（strip 路径）", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "记录用量"));
    const at = "2026-02-03T04:05:06.789Z";
    store.apply("s1", {
      type: "assistant",
      uuid: "a1",
      timestamp: at,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "回答" }],
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
      },
    });

    const item = store.summary("s1", true).messages?.at(-1);
    assert.equal(item?.text, "回答");
    assert.equal(item?.at, at);
    assert.deepEqual(item?.usage, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });

    // 落盘并重新载入后字段仍然完整。
    await store.flush();
    const reloaded = new Store(dataDir);
    const persisted = reloaded.summary("s1", true).messages?.at(-1);
    assert.equal(persisted?.at, at);
    assert.deepEqual(persisted?.usage, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
    await reloaded.flush();
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("seen 超过 2000 条时只保留最近 2000 条并落盘", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "去重"));

    for (let index = 0; index < 2_005; index += 1) {
      store.apply("s1", { type: "system", uuid: `u${index}` });
    }

    assert.equal(store.get("s1")?.seen.length, 2_000);

    await store.flush();
    const saved = readSession(dataDir, "s1");
    assert.equal(saved.seen.length, 2_000);
    assert.equal(saved.seen[0], "u5");
    assert.equal(saved.seen.at(-1), "u2004");
    assert.deepEqual(tmpFiles(sessionsDir(dataDir)), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("listAll 置顶优先、其余 createdAt 降序，重启后保持", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    writeSessionFile(dataDir, { ...minimalSession("a"), createdAt: "2026-01-01T00:00:01.000Z" });
    writeSessionFile(dataDir, { ...minimalSession("b"), createdAt: "2026-01-01T00:00:02.000Z" });
    writeSessionFile(dataDir, { ...minimalSession("c"), createdAt: "2026-01-01T00:00:03.000Z" });

    store = new Store(dataDir);
    assert.deepEqual(store.listAll().map((item) => item.id), ["c", "b", "a"]);
    // 非置顶会话始终给布尔值，而不是 undefined。
    assert.deepEqual(store.listAll().map((item) => item.pinned), [false, false, false]);
    // 按项目列表复用同一套排序。
    assert.deepEqual(store.list("p1").map((item) => item.id), ["c", "b", "a"]);

    store.updateMeta("b", { pinned: true });
    const all = store.listAll();
    assert.deepEqual(all.map((item) => item.id), ["b", "c", "a"]);
    assert.equal(all[0]?.pinned, true);
    assert.equal(all[0]?.messages, undefined);
    assert.deepEqual(store.list("p1").map((item) => item.id), ["b", "c", "a"]);
    assert.deepEqual(store.list().map((item) => item.id), ["b", "c", "a"]);
    await store.flush();

    const reloaded = new Store(dataDir);
    assert.deepEqual(reloaded.listAll().map((item) => item.id), ["b", "c", "a"]);
    assert.equal(reloaded.summary("b").pinned, true);
    assert.equal(readSession(dataDir, "b").pinned, true);
    await reloaded.flush();
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("search 命中标题、摘要、消息正文且不区分大小写", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create({ ...createInput("s1", "hello world"), title: "Alpha Project" });
    store.create({ ...createInput("s2", "UNIQUE Needle here"), title: "Beta" });
    store.create({ ...createInput("s3", "start"), title: "Gamma" });
    store.apply("s3", {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "SecretAssistantBody" }] },
    });

    assert.deepEqual(store.search("alpha").map((item) => item.id), ["s1"]);
    assert.deepEqual(store.search("needle").map((item) => item.id), ["s2"]);
    // 正文命中（assistant 消息不在 summary 里）。
    assert.deepEqual(store.search("SECRETassistantbody").map((item) => item.id), ["s3"]);
    // 列表不带 messages。
    assert.equal(store.search("alpha")[0]?.messages, undefined);

    const allIds = store.listAll().map((item) => item.id);
    assert.deepEqual(store.search("").map((item) => item.id), allIds);
    assert.deepEqual(store.search("   ").map((item) => item.id), allIds);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateMeta 改名/置顶会广播 summary 并落盘", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    const events: SessionEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.create({ ...createInput("s1", "第一问"), title: "原标题" });
    events.length = 0;

    store.updateMeta("s1", { title: "  新标题  ", pinned: true });
    // 内存立即生效；落盘要等 flush。
    assert.equal(store.require("s1").title, "新标题");
    assert.equal(store.require("s1").pinned, true);

    // emit 有 50ms 合并窗口，等它把最新 summary 广播出来。
    await delay(120);
    const last = events.at(-1);
    assert.equal(last?.id, "s1");
    assert.equal(last?.title, "新标题");
    assert.equal(last?.pinned, true);
    assert.equal(last?.messages, undefined);

    await store.flush();
    const saved = readSession(dataDir, "s1");
    assert.equal(saved.title, "新标题");
    assert.equal(saved.pinned, true);

    assert.throws(() => store?.updateMeta("s1", { title: "   " }), /标题不能为空/);
    assert.throws(
      () => store?.updateMeta("s1", { pinned: 1 as unknown as boolean }),
      /pinned 必须是布尔值/,
    );
    // 失败调用不改动会话。
    assert.equal(store.require("s1").title, "新标题");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateRunConfig 改 provider/model/effort 后 summary 与落盘都更新", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "跑起来"));

    const updated = store.updateRunConfig("s1", {
      providerId: "prov2",
      providerName: "新服务商",
      model: "model-y",
      effort: "max",
    });
    assert.equal(updated.providerId, "prov2");
    assert.equal(updated.model, "model-y");
    assert.equal(updated.effort, "max");

    const summary = store.summary("s1");
    assert.equal(summary.providerId, "prov2");
    assert.equal(summary.providerName, "新服务商");
    assert.equal(summary.model, "model-y");
    assert.equal(summary.effort, "max");

    await store.flush();
    const saved = readSession(dataDir, "s1");
    assert.equal(saved.providerId, "prov2");
    assert.equal(saved.providerName, "新服务商");
    assert.equal(saved.model, "model-y");
    assert.equal(saved.effort, "max");

    assert.throws(
      () => store?.updateRunConfig("s1", {
        providerId: "prov2",
        providerName: "新服务商",
        model: "  ",
        effort: "max",
      }),
      /模型不能为空/,
    );
    assert.throws(
      () => store?.updateRunConfig("s1", {
        providerId: "prov2",
        providerName: "新服务商",
        model: "model-z",
        effort: "ultra" as unknown as Effort,
      }),
      /无效的 effort/,
    );
    // 校验失败不落半截改动。
    assert.equal(store.require("s1").model, "model-y");
    assert.equal(store.require("s1").providerId, "prov2");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateMeta 标题 80 字通过、81 字报错", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "边界"));

    const ok = "字".repeat(80);
    assert.equal(store.updateMeta("s1", { title: ok }).title, ok);
    assert.throws(() => store?.updateMeta("s1", { title: "字".repeat(81) }), /标题最多 80 字/);
    // 失败调用不改动已有标题。
    assert.equal(store.require("s1").title, ok);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("setGeneratedTitle 只替换待生成的占位标题，之后不再覆盖", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create({ ...createInput("s1", "修一下登录"), title: PROVISIONAL_TITLE, titlePending: true });

    const updated = store.setGeneratedTitle("s1", " 修复登录接口超时 ");
    assert.equal(updated?.title, "修复登录接口超时");
    // 标记清除后，后续总结不能改标题；空标题也不接受。
    assert.equal(store.require("s1").titlePending, undefined);
    assert.equal(store.setGeneratedTitle("s1", "别的标题"), undefined);
    assert.equal(store.setGeneratedTitle("s1", "   "), undefined);
    assert.equal(store.require("s1").title, "修复登录接口超时");

    await store.flush();
    const saved = readSession(dataDir, "s1");
    assert.equal(saved.title, "修复登录接口超时");
    assert.equal(saved.titlePending, undefined);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("用户手动改名后，后台总结不能覆盖", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create({ ...createInput("s1", "修一下登录"), title: PROVISIONAL_TITLE, titlePending: true });

    store.updateMeta("s1", { title: "我自己起的标题" });
    assert.equal(store.require("s1").titlePending, undefined);
    assert.equal(store.setGeneratedTitle("s1", "agent 总结的标题"), undefined);
    assert.equal(store.require("s1").title, "我自己起的标题");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("没有占位标记的旧会话不会被自动总结覆盖", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    writeSessionFile(dataDir, { ...minimalSession("s1"), title: "旧标题" });
    store = new Store(dataDir);

    assert.equal(store.setGeneratedTitle("s1", "agent 总结的标题"), undefined);
    assert.equal(store.require("s1").title, "旧标题");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("search 能命中 user 与 tool 角色的消息正文", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    // 标题/摘要都不含关键字，只能靠 messages 命中。
    writeSessionFile(dataDir, {
      ...minimalSession("s1"),
      title: "旧标题",
      summary: "无关摘要",
      messages: [
        { id: "m1", role: "user", text: "HiddenUserBody" },
        { id: "m2", role: "tool", text: "HiddenToolBody" },
        { id: "m3", role: "assistant", text: "AssistantOnly" },
      ],
    });

    store = new Store(dataDir);
    assert.deepEqual(store.search("hiddenuserbody").map((item) => item.id), ["s1"]);
    assert.deepEqual(store.search("HIDDENtoolbody").map((item) => item.id), ["s1"]);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cancelQueued 清掉撤回后的排队状态，按历史结果回到对应阶段", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);

    // 新建会话撤回排队：没有历史结果，显示已停止。
    store.create(createInput("new", "起点"));
    store.markQueued("new");
    assert.equal(store.require("new").queued, true);
    store.cancelQueued("new");
    assert.equal(store.require("new").queued, false);
    assert.equal(store.require("new").phase, "stopped");
    assert.equal(store.require("new").lastResult, "stopped");
    assert.equal(store.require("new").lastError, "已停止");

    // 已完成会话再次排队后撤回：保留成功结果，回到 completed。
    store.create(createInput("done", "做完"));
    store.beginTurn("done");
    store.apply("done", { type: "result", subtype: "success", uuid: "r1" });
    assert.equal(store.require("done").phase, "completed");
    store.markQueued("done");
    assert.equal(store.require("done").phase, "queued");
    store.cancelQueued("done");
    assert.equal(store.require("done").queued, false);
    assert.equal(store.require("done").phase, "completed");
    assert.equal(store.require("done").lastResult, "success");

    // 正在跑的轮次不处理撤回。
    store.create(createInput("running", "跑着"));
    store.beginTurn("running");
    store.cancelQueued("running");
    assert.equal(store.require("running").turnActive, true);
    assert.equal(store.require("running").phase, "running");
    assert.equal(store.require("running").queued, false);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("search 缓存不受流式消息替换影响，能搜到最新正文", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "start"));
    store.apply("s1", {
      type: "stream_event",
      uuid: "d1",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Alpha" } },
    });
    // 第一次搜索会把小写正文缓存到消息对象上。
    assert.deepEqual(store.search("alpha").map((item) => item.id), ["s1"]);

    // 追加增量后消息对象被替换，缓存必须跟着失效。
    store.apply("s1", {
      type: "stream_event",
      uuid: "d2",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Beta" } },
    });
    assert.deepEqual(store.search("beta").map((item) => item.id), ["s1"]);
    assert.deepEqual(store.search("alphabeta").map((item) => item.id), ["s1"]);

    // 完整消息替换流式片段后，旧正文搜不到、新正文能搜到。
    store.apply("s1", {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "OmegaFinal" }] },
    });
    assert.deepEqual(store.search("omegafinal").map((item) => item.id), ["s1"]);
    assert.deepEqual(store.search("alphabeta"), []);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("usageReport 缓存按会话更新，报告对象互不共享且新用量生效", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "统计用量"));
    store.apply("s1", {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第一轮" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    });

    const providers = [{ id: "prov1", name: "服务商", pricing: { input: 1, output: 1 } }];
    const first = store.usageReport(providers);
    assert.deepEqual(first.totals, { calls: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(first.cost - (10 + 20) / 1_000_000) < 1e-12);

    // 改写上一次报告的每会话 totals，不应污染缓存或下一次报告（必须返回独立副本）。
    const firstSession = first.bySession[0];
    assert.ok(firstSession);
    firstSession.totals.input = 9_999;
    first.totals.output = 9_999;
    const second = store.usageReport(providers);
    assert.deepEqual(second.totals, { calls: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(second.bySession[0]?.totals, {
      calls: 1,
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.notEqual(second.totals, first.totals);
    assert.notEqual(second.bySession[0]?.totals, first.bySession[0]?.totals);

    // 新助手消息带来新用量：updatedAt/条数变化后缓存失效并重新汇总。
    store.apply("s1", {
      type: "assistant",
      uuid: "a2",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第二轮" }],
        usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 3 },
      },
    });
    const third = store.usageReport(providers);
    assert.deepEqual(third.totals, {
      calls: 2,
      input: 15,
      output: 20,
      cacheRead: 3,
      cacheWrite: 0,
    });

    // 改价格后成本重新计算，但 token 汇总仍正确。
    const repriced = store.usageReport([{ id: "prov1", name: "服务商", pricing: { input: 2, output: 0.5 } }]);
    assert.deepEqual(repriced.totals, third.totals);
    assert.ok(Math.abs(repriced.cost - (15 * 2 + 20 * 0.5) / 1_000_000) < 1e-12);

    // 删除会话后缓存随之清理，重新报告不再包含它。
    store.remove("s1");
    const afterRemove = store.usageReport(providers);
    assert.equal(afterRemove.bySession.length, 0);
    assert.deepEqual(afterRemove.totals, { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("同一毫秒内流式条目被带 usage 的完整消息接管时用量缓存失效", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    // 固定时间：流式条目替换前后 updatedAt 完全相同，只能靠消息集合变化失效。
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-03-01T00:00:00.000Z") });
    store = new Store(dataDir);
    store.create(createInput("s1", "统计"));
    store.apply("s1", {
      type: "stream_event",
      uuid: "d1",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "草稿" } },
    });
    const providers = [{ id: "prov1", name: "服务商" }];
    const before = store.usageReport(providers);
    assert.equal(before.totals.calls, 0);
    assert.equal(store.require("s1").messages.length, 2);

    // 完整消息接管流式片段：条数仍是 2，updatedAt 仍是同一毫秒。
    store.apply("s1", {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "最终" }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    });
    const session = store.require("s1");
    assert.equal(session.messages.length, 2);
    assert.equal(session.updatedAt, "2026-03-01T00:00:00.000Z");

    const after = store.usageReport(providers);
    assert.deepEqual(after.totals, { calls: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
  } finally {
    mock.timers.reset();
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("旧 JSON 缺少 pinned 或为非法值时，summary 统一为 false 并落盘清洗", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    writeSessionFile(dataDir, minimalSession("s1"));
    writeSessionFile(dataDir, {
      ...minimalSession("s2"),
      pinned: "yes",
    } as unknown as SessionCore);

    store = new Store(dataDir);
    assert.equal(store.summary("s1").pinned, false);
    assert.equal(store.summary("s2").pinned, false);
    assert.deepEqual(store.listAll().map((item) => item.pinned), [false, false]);

    await store.flush();
    assert.equal(readSession(dataDir, "s1").pinned, false);
    assert.equal(readSession(dataDir, "s2").pinned, false);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("summary 稳定暴露 backgroundTasks，运行中的后台任务不影响 phase", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    store.create(createInput("s1", "下载模型"));
    // 没有后台任务时也给 []，而不是省略字段。
    assert.deepEqual(store.summary("s1", false).backgroundTasks, []);
    assert.deepEqual(store.list()[0]?.backgroundTasks, []);

    store.beginTurn("s1");
    store.apply("s1", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-start",
      task_id: "shell-1",
      task_type: "local_bash",
      description: "下载模型权重",
    });
    const running = store.summary("s1", false);
    assert.equal(running.backgroundTasks?.length, 1);
    assert.equal(running.backgroundTasks?.[0]?.status, "running");
    assert.equal(running.backgroundTasks?.[0]?.taskType, "local_bash");

    // 主轮结束、后台下载还在跑：会话应显示已完成，而不是一直“进行中”。
    store.apply("s1", { type: "result", subtype: "success", uuid: "result-1" });
    const settled = store.summary("s1", false);
    assert.equal(settled.phase, "completed");
    assert.equal(settled.mainAgentRunning, false);
    assert.equal(settled.backgroundTasks?.[0]?.status, "running");
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("启动恢复把 running 的后台任务收敛成 stopped，缺字段归一化为 []", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    // 已落定的会话里残留一个 running 的后台任务：重启后不可能还在跑。
    const settled = minimalSession("bg");
    settled.phase = "completed";
    settled.lastResult = "success";
    settled.backgroundTasks = [{
      taskId: "shell-1",
      taskType: "local_bash",
      description: "下载",
      status: "running",
      isBackgrounded: true,
      startedAt: "2026-01-01T00:00:00.000Z",
    }];
    writeSessionFile(dataDir, settled);
    // 旧数据没有 backgroundTasks 字段。
    const legacy = minimalSession("old");
    legacy.phase = "completed";
    legacy.lastResult = "success";
    writeSessionFile(dataDir, legacy);
    // 已结束的旧任务条目缺 taskType/description/isBackgrounded：启动时补默认值并回写。
    const oldTask = minimalSession("old-task");
    oldTask.phase = "completed";
    oldTask.lastResult = "success";
    oldTask.backgroundTasks = [{
      taskId: "shell-old",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as BackgroundTask];
    writeSessionFile(dataDir, oldTask);

    store = new Store(dataDir);
    const tasks = store.summary("bg", false).backgroundTasks;
    assert.equal(tasks?.length, 1);
    assert.equal(tasks?.[0]?.status, "stopped");
    assert.equal(tasks?.[0]?.summary, "服务已重启");
    // 恢复时也要补结束时间，否则任务栏会把用时一直累加。
    assert.equal(tasks?.[0]?.endedAt, settled.updatedAt);
    assert.deepEqual(store.summary("old", false).backgroundTasks, []);
    const normalized = store.summary("old-task", false).backgroundTasks?.[0];
    assert.equal(normalized?.taskType, "local_bash");
    // 缺失说明归一化为空字符串，不用占位文本。
    assert.equal(normalized?.description, "");
    assert.equal(normalized?.isBackgrounded, true);

    // 收敛/归一化后的状态会回写磁盘。
    await store.flush();
    const saved = readSession(dataDir, "bg");
    assert.equal(saved.backgroundTasks?.[0]?.status, "stopped");
    const savedTask = readSession(dataDir, "old-task").backgroundTasks?.[0];
    assert.equal(savedTask?.taskType, "local_bash");
    assert.equal(savedTask?.description, "");
    assert.equal(savedTask?.isBackgrounded, true);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("remove 的 tombstone 带 backgroundTasks: []", async () => {
  const dataDir = tempDir();
  const store = new Store(dataDir);
  try {
    const events: SessionEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.create(createInput("s1", "待删除"));
    events.length = 0;

    store.remove("s1");
    // remove 同步广播 tombstone；前端据此清理列表和后台任务区域。
    const tombstone = events.find((event) => event.removed === true);
    assert.ok(tombstone);
    assert.deepEqual(tombstone?.backgroundTasks, []);
  } finally {
    await store.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stop/fail 把 running 的后台任务收敛成 stopped 并保留摘要", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);

    store.create(createInput("stopped", "下载"));
    store.beginTurn("stopped");
    store.apply("stopped", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-1",
      task_id: "shell-1",
      task_type: "local_bash",
      description: "下载",
    });
    store.apply("stopped", {
      type: "system",
      subtype: "task_updated",
      uuid: "bg-2",
      task_id: "shell-1",
      patch: { status: "running", error: "失败原因 A" },
    });
    assert.equal(store.require("stopped").backgroundTasks?.[0]?.status, "running");
    store.stop("stopped", "已停止");
    const stoppedTask = store.require("stopped").backgroundTasks?.[0];
    assert.equal(stoppedTask?.status, "stopped");
    // 停止时补结束时间，前端用时不再继续累加。
    assert.ok(Number.isFinite(Date.parse(stoppedTask?.endedAt ?? "")));
    // 已有的摘要不会被停止原因覆盖。
    assert.equal(stoppedTask?.summary, "失败原因 A");

    store.create(createInput("failed", "下载"));
    store.beginTurn("failed");
    store.apply("failed", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-3",
      task_id: "shell-2",
      task_type: "local_bash",
      description: "下载",
    });
    store.fail("failed", "出错了");
    assert.equal(store.require("failed").backgroundTasks?.[0]?.status, "stopped");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stopBackgroundTasks 把 running 收敛成 stopped，保留已有摘要和结束时间", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("bg-stop", "下载"));
    store.beginTurn("bg-stop");
    store.apply("bg-stop", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-1",
      task_id: "shell-1",
      task_type: "local_bash",
      description: "下载",
    });
    store.apply("bg-stop", {
      type: "system",
      subtype: "task_updated",
      uuid: "bg-2",
      task_id: "shell-1",
      patch: { status: "running", error: "进度 50%" },
    });
    store.apply("bg-stop", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-3",
      task_id: "shell-done",
      task_type: "local_bash",
      description: "已完成",
    });
    store.apply("bg-stop", {
      type: "system",
      subtype: "task_notification",
      uuid: "bg-4",
      task_id: "shell-done",
      status: "completed",
      summary: "完成",
    });

    const before = store.require("bg-stop").updatedAt;
    await delay(2);
    store.stopBackgroundTasks("bg-stop", "对话进程已结束");

    const tasks = store.require("bg-stop").backgroundTasks ?? [];
    assert.equal(tasks[0]?.status, "stopped");
    // 已有摘要优先，不被进程结束说明覆盖。
    assert.equal(tasks[0]?.summary, "进度 50%");
    assert.ok(tasks[0]?.endedAt);
    // 已完成的任务不受影响。
    assert.equal(tasks[1]?.status, "completed");
    assert.ok(tasks[1]?.endedAt);
    assert.notEqual(store.require("bg-stop").updatedAt, before);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stopBackgroundTasks 只补空摘要，没有 running 任务时不改 updatedAt", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("bg-idle", "下载"));
    store.beginTurn("bg-idle");
    store.apply("bg-idle", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-1",
      task_id: "shell-done",
      task_type: "local_bash",
      description: "已完成",
    });
    store.apply("bg-idle", {
      type: "system",
      subtype: "task_notification",
      uuid: "bg-2",
      task_id: "shell-done",
      status: "completed",
      summary: "完成",
    });

    const before = store.require("bg-idle").updatedAt;
    await delay(2);
    store.stopBackgroundTasks("bg-idle", "对话进程已结束");
    assert.equal(store.require("bg-idle").updatedAt, before);

    // running 且没有摘要：补传入说明；已有 endedAt 保留。
    store.create(createInput("bg-empty-summary", "下载"));
    store.beginTurn("bg-empty-summary");
    store.apply("bg-empty-summary", {
      type: "system",
      subtype: "task_started",
      uuid: "bg-3",
      task_id: "shell-2",
      task_type: "local_bash",
      description: "下载",
    });
    const runningTask = store.require("bg-empty-summary").backgroundTasks?.[0];
    assert.ok(runningTask);
    runningTask.endedAt = "2026-01-01T00:05:00.000Z";
    store.stopBackgroundTasks("bg-empty-summary", "对话进程已结束");
    const task = store.require("bg-empty-summary").backgroundTasks?.[0];
    assert.equal(task?.status, "stopped");
    assert.equal(task?.summary, "对话进程已结束");
    assert.equal(task?.endedAt, "2026-01-01T00:05:00.000Z");
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("流式增量计入实时输出速度：子 agent 增量同样计入，重放帧不重复", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "做点事"));
    store.apply("s1", {
      type: "stream_event",
      uuid: "d1",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好世界" } },
    });
    // 4 个 CJK 字符 / 2 秒窗口 = 2 tokens/s。
    assert.equal(store.summary("s1").tokensPerSecond, 2);

    // 子 agent 的输出不写 transcript，但同样消耗输出 token，要计入顶栏速度。
    const subagent = {
      type: "stream_event" as const,
      uuid: "d2",
      parent_tool_use_id: "tool-1",
      event: { type: "content_block_delta" as const, delta: { type: "thinking_delta" as const, thinking: "分析" } },
    };
    store.apply("s1", subagent);
    assert.equal(store.summary("s1").tokensPerSecond, 3);
    // 同一 uuid 的重放帧已被去重，不能重复计数。
    store.apply("s1", subagent);
    assert.equal(store.summary("s1").tokensPerSecond, 3);
    // 已经收到子 agent 的流式增量后，同一块的完整消息不能再算一遍。
    store.apply("s1", {
      type: "assistant",
      uuid: "d3",
      parent_tool_use_id: "tool-1",
      agent_id: "task-1",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "分析" }] },
    });
    assert.equal(store.summary("s1").tokensPerSecond, 3);

    // 速度只是内存里的显示数据，不落盘。
    await store.flush();
    const saved = readSession(dataDir, "s1") as SessionCore & { tokensPerSecond?: number };
    assert.equal(saved.tokensPerSecond, undefined);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("子 agent 的完整输出按生成区间计入速度，主线程完整消息不重复计数", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s2", "做点事"));
    store.apply("s2", {
      type: "system",
      subtype: "task_started",
      uuid: "t1",
      task_id: "task-1",
      task_type: "local_agent",
      description: "开发",
      timestamp: new Date(Date.now() - 4_000).toISOString(),
    });
    const output = {
      type: "assistant" as const,
      uuid: "a1",
      parent_tool_use_id: "tool-1",
      agent_id: "task-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "你好世界" },
          { type: "tool_use", id: "tool-2", name: "Edit", input: { file: "a.ts" } },
        ],
      },
    };
    store.apply("s2", output);
    // 约 8 个 token 在最近 4 秒内生成，2 秒窗口只摊到一半：约 2 tokens/s。
    const rate = store.summary("s2").tokensPerSecond ?? 0;
    assert.ok(rate === 1 || rate === 2, `unexpected rate ${rate}`);

    // 重放的完整消息已被 uuid 去重；主线程的完整消息和流式增量重复，也不能计数。
    store.apply("s2", output);
    store.apply("s2", {
      type: "assistant",
      uuid: "a2",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "你好世界" }] },
    });
    assert.equal(store.summary("s2").tokensPerSecond, rate);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reconcileProjects 按当前配置修正会话路径，派生的 cwd 一起平移", async () => {
  const dataDir = tempDir();
  try {
    const oldRoot = path.join(dataDir, "old-project");
    const newRoot = path.join(dataDir, "new-project");
    const store = new Store(dataDir);
    // git 会话的 cwd 在 dataDir/worktrees 下，不随项目目录变化。
    store.create({
      ...createInput("git-1", "x"),
      projectPath: oldRoot,
      git: true,
      cwd: path.join(dataDir, "worktrees", "p1", "git-1"),
    });
    // 隔离的非 git 会话：cwd 是 <项目目录>/<会话 id>。
    store.create({
      ...createInput("iso-1", "x"),
      projectPath: oldRoot,
      cwd: path.join(oldRoot, "iso-1"),
    });
    // 非隔离的非 git 会话：cwd 就是项目目录。
    store.create({
      ...createInput("plain-1", "x"),
      projectPath: oldRoot,
      cwd: oldRoot,
    });
    // 配置里已没有的项目、路径没变的项目都不动。
    store.create({ ...createInput("gone-1", "x"), projectId: "gone", projectPath: "/gone" });
    store.create({ ...createInput("same-1", "x"), projectId: "p2", projectPath: "/same" });

    const changed = store.reconcileProjects([
      { id: "p1", path: newRoot },
      { id: "p2", path: "/same" },
    ]);
    assert.equal(changed, 3);
    assert.equal(store.require("git-1").projectPath, newRoot);
    assert.equal(store.require("git-1").cwd, path.join(dataDir, "worktrees", "p1", "git-1"));
    assert.equal(store.require("iso-1").projectPath, newRoot);
    assert.equal(store.require("iso-1").cwd, path.join(newRoot, "iso-1"));
    assert.equal(store.require("plain-1").cwd, newRoot);
    assert.equal(store.require("gone-1").projectPath, "/gone");

    // 修正后的路径要落盘，重启后继续生效。
    await store.flush();
    const reloaded = new Store(dataDir);
    assert.equal(reloaded.require("git-1").projectPath, newRoot);
    assert.equal(reloaded.require("iso-1").cwd, path.join(newRoot, "iso-1"));
    assert.equal(reloaded.require("plain-1").cwd, newRoot);
    assert.equal(reloaded.require("gone-1").projectPath, "/gone");
    await reloaded.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("create/addUserMessage 保存 sdkUuid，并给用户消息写入 at", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create({ ...createInput("s1", "第一问"), sdkUuid: "sdk-1" });
    const first = store.get("s1")?.messages[0];
    assert.equal(first?.sdkUuid, "sdk-1");
    assert.equal(typeof first?.at, "string");
    assert.equal(Number.isFinite(Date.parse(first!.at!)), true);

    store.addUserMessage("s1", "第二问", [], "sdk-2");
    const second = store.get("s1")?.messages.at(-1);
    assert.equal(second?.sdkUuid, "sdk-2");
    assert.equal(typeof second?.at, "string");
    assert.equal(Number.isFinite(Date.parse(second!.at!)), true);

    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("applyRewind 在 newSdkSession 且没有新 SDK 会话 id 时抛错", () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "问题"));
    // 不能悄悄回退到 session.id：那通常正是旧 transcript 的 id。
    assert.throws(
      () => store.applyRewind("s1", { messages: [], newSdkSession: true }),
      /新的 SDK 会话 id/,
    );
    // 抛错时不能改动会话。
    assert.equal(store.get("s1")?.messages.length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("applyRewind 收敛运行状态、按 cutAt 过滤子 agent/后台任务并重写指针", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "第一问"));
    const session = store.get("s1")!;
    session.messages = [
      { id: "u1", role: "user", text: "第一问", at: "2026-01-01T00:00:00.000Z" },
      { id: "a1", role: "assistant", text: "回答", at: "2026-01-01T00:00:05.000Z" },
      { id: "u2", role: "user", text: "第二问", at: "2026-01-01T00:00:10.000Z" },
    ];
    session.subagents = [
      { taskId: "s-old", description: "旧", status: "completed", startedAt: "2026-01-01T00:00:01.000Z" },
      { taskId: "s-new", description: "新", status: "running", startedAt: "2026-01-01T00:00:20.000Z" },
    ];
    session.backgroundTasks = [
      {
        taskId: "b-old",
        taskType: "local_bash",
        description: "旧命令",
        status: "completed",
        isBackgrounded: true,
        startedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        taskId: "b-new",
        taskType: "local_bash",
        description: "新命令",
        status: "running",
        isBackgrounded: true,
        startedAt: "2026-01-01T00:00:21.000Z",
      },
    ];
    session.pending = { requestId: "r1", kind: "permission", toolName: "Bash", inputPreview: "rm" };
    session.queued = true;
    session.turnActive = true;
    session.agentState = "running";
    session.workflow = { skill: "prl", startedAt: "2026-01-01T00:00:00.000Z" };
    session.lastResult = "error";
    session.lastError = "旧错误";
    session.seen = ["seen-1", "seen-2"];
    session.forkedSdkIds = ["fork-1"];

    const rewound = store.applyRewind("s1", {
      messages: session.messages.slice(0, 2),
      claudeSessionId: "new-sdk",
      newSdkSession: true,
      forkedSdkId: "fork-2",
      lastSdkUuid: "a1",
      cutAt: "2026-01-01T00:00:10.000Z",
    });

    assert.deepEqual(rewound.messages.map((item) => item.id), ["u1", "a1"]);
    assert.equal(rewound.pending, null);
    assert.equal(rewound.queued, false);
    assert.equal(rewound.turnActive, false);
    assert.equal(rewound.agentState, undefined);
    assert.equal(rewound.workflow, undefined);
    assert.equal(rewound.lastResult, "success");
    assert.equal(rewound.lastError, undefined);
    assert.equal(rewound.summary, "已回滚，可以继续");
    // 回滚不是一次真实运行：旧的起点/终点都作废，列表不再按旧起点算用时。
    assert.equal(rewound.runStartedAt, undefined);
    assert.equal(rewound.runEndedAt, undefined);
    assert.equal(rewound.claudeSessionId, "new-sdk");
    assert.equal(rewound.newSdkSession, true);
    assert.equal(rewound.lastSdkUuid, "a1");
    assert.deepEqual(rewound.forkedSdkIds, ["fork-1", "fork-2"]);
    assert.deepEqual(rewound.seen, ["seen-1", "seen-2"]);
    assert.deepEqual(rewound.subagents.map((item) => item.taskId), ["s-old"]);
    assert.deepEqual(rewound.backgroundTasks?.map((item) => item.taskId), ["b-old"]);
    assert.equal(rewound.phase, "completed");

    // 去重：再次追加同一个 fork id 不会重复；同时把被清掉的旧 SDK id 记入
    // forkedSdkIds，供后续 DELETE/归档/retention 兜底清理。
    const again = store.applyRewind("s1", {
      messages: rewound.messages,
      forkedSdkId: "fork-2",
      summary: "自定义摘要",
    });
    assert.deepEqual(again.forkedSdkIds, ["fork-1", "fork-2", "new-sdk"]);
    // 未传 cutAt：子 agent/后台任务全部丢弃。
    assert.deepEqual(again.subagents, []);
    assert.deepEqual(again.backgroundTasks, []);
    // 未传的字段被清空。
    assert.equal(again.claudeSessionId, undefined);
    assert.equal(again.newSdkSession, undefined);
    assert.equal(again.lastSdkUuid, undefined);
    assert.equal(again.summary, "自定义摘要");

    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("createBranch 建立不排队的分叉会话并立即落盘广播", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    const events: SessionEvent[] = [];
    store.subscribe((event) => events.push(event));
    const messages = [
      { id: "u1", role: "user" as const, text: "第一问", sdkUuid: "u1", forkPoint: ROOT_FORK_POINT },
      { id: "a1", role: "assistant" as const, text: "回答" },
    ];
    const branch = store.createBranch({
      id: "f1",
      projectId: "p1",
      projectPath: "/tmp/project",
      title: "分叉对话",
      providerId: "prov1",
      providerName: "服务商",
      model: "model-x",
      effort: "high",
      cwd: "/tmp/project",
      git: false,
      messages,
      claudeSessionId: "forked-sdk",
      lastSdkUuid: "u1",
      summary: "分叉对话",
    });

    assert.equal(store.get("f1"), branch);
    assert.equal(branch.queued, false);
    assert.equal(branch.turnActive, false);
    assert.equal(branch.pending, null);
    assert.deepEqual(branch.seen, []);
    assert.deepEqual(branch.subagents, []);
    assert.deepEqual(branch.backgroundTasks, []);
    assert.equal(branch.workflow, undefined);
    assert.equal(branch.lastResult, "success");
    assert.equal(branch.phase, "completed");
    assert.equal(branch.claudeSessionId, "forked-sdk");
    assert.equal(branch.lastSdkUuid, "u1");
    assert.equal(branch.createdAt, branch.updatedAt);
    assert.equal(branch.runStartedAt, undefined);
    assert.equal(branch.runEndedAt, undefined);
    assert.deepEqual(branch.messages, messages);
    assert.equal(branch.summary, "分叉对话");
    assert.equal(events.some((event) => event.id === "f1"), true);

    await store.flush();
    assert.equal(readSession(dataDir, "f1").messages.length, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("createBranch 继承父会话的标题待生成标记", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    const branch = store.createBranch({
      id: "f1",
      projectId: "p1",
      projectPath: "/tmp/project",
      title: `${PROVISIONAL_TITLE}（分叉）`,
      titlePending: true,
      providerId: "prov1",
      providerName: "服务商",
      model: "model-x",
      effort: "high",
      cwd: "/tmp/project",
      git: false,
      messages: [{ id: "u1", role: "user", text: "第一问", sdkUuid: "u1", forkPoint: ROOT_FORK_POINT }],
      claudeSessionId: "forked-sdk",
      summary: "第一问",
    });

    assert.equal(branch.titlePending, true);
    await store.flush();
    assert.equal(readSession(dataDir, "f1").titlePending, true);
    assert.equal(store.setGeneratedTitle("f1", "总结后的标题")?.title, "总结后的标题");
    assert.equal(store.get("f1")?.titlePending, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("applyRewind 把被替换或清掉的旧 claudeSessionId 记入 forkedSdkIds", () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create(createInput("s1", "问题"));
    const session = store.get("s1")!;
    session.claudeSessionId = "old-sdk";
    session.forkedSdkIds = ["existing"];

    // 换成新 id：旧 id 追加到 forkedSdkIds。
    const rewound = store.applyRewind("s1", {
      messages: session.messages,
      claudeSessionId: "new-sdk",
    });
    assert.equal(rewound.claudeSessionId, "new-sdk");
    assert.deepEqual(rewound.forkedSdkIds, ["existing", "old-sdk"]);

    // 新旧 id 相同：不重复记录。
    const same = store.applyRewind("s1", {
      messages: rewound.messages,
      claudeSessionId: "new-sdk",
    });
    assert.deepEqual(same.forkedSdkIds, ["existing", "old-sdk"]);

    // 新值为 undefined：旧 id 也要记下来，交给后续清理兜底。
    const cleared = store.applyRewind("s1", { messages: same.messages });
    assert.equal(cleared.claudeSessionId, undefined);
    assert.deepEqual(cleared.forkedSdkIds, ["existing", "old-sdk", "new-sdk"]);

    // 已经清空后不再追加。
    const final = store.applyRewind("s1", { messages: cleared.messages });
    assert.deepEqual(final.forkedSdkIds, ["existing", "old-sdk", "new-sdk"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recover 归一化损坏的回滚字段并回写", async () => {
  const dataDir = tempDir();
  try {
    const mixed = minimalSession("mixed") as SessionCore & Record<string, unknown>;
    mixed.forkedSdkIds = ["keep", 42, "", "keep", null] as unknown as string[];
    mixed.lastSdkUuid = 1234 as unknown as string;
    mixed.newSdkSession = "yes" as unknown as boolean;
    writeSessionFile(dataDir, mixed);

    const notArray = minimalSession("not-array") as SessionCore & Record<string, unknown>;
    notArray.forkedSdkIds = "oops" as unknown as string[];
    notArray.lastSdkUuid = "" as string;
    notArray.newSdkSession = true;
    writeSessionFile(dataDir, notArray);

    const store = new Store(dataDir);
    const loaded = store.get("mixed")!;
    assert.deepEqual(loaded.forkedSdkIds, ["keep"]);
    assert.equal(loaded.lastSdkUuid, undefined);
    assert.equal(loaded.newSdkSession, undefined);

    const cleaned = store.get("not-array")!;
    assert.equal(cleaned.forkedSdkIds, undefined);
    assert.equal(cleaned.lastSdkUuid, undefined);
    // 只接受 true：合法的 true 保留。
    assert.equal(cleaned.newSdkSession, true);

    // 收敛后的结果要落盘，避免下次启动重复处理。
    await store.flush();
    const reloaded = new Store(dataDir);
    assert.deepEqual(reloaded.get("mixed")?.forkedSdkIds, ["keep"]);
    assert.equal(reloaded.get("not-array")?.forkedSdkIds, undefined);
    await reloaded.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("编辑/删除排队中的用户消息会同步列表摘要", async () => {
  const dataDir = tempDir();
  try {
    const store = new Store(dataDir);
    store.create({ ...createInput("s1", "第一条"), sdkUuid: "uuid-1" });
    store.addUserMessage("s1", "第二条", [], "uuid-2");
    assert.equal(store.get("s1")?.summary, "第二条");

    // 编辑最后一条用户消息：摘要跟着改。
    store.editUserMessage("s1", "uuid-2", "改过的第二条");
    assert.equal(store.get("s1")?.summary, "改过的第二条");

    // 删除最后一条用户消息：摘要回退到上一条。
    store.removeUserMessage("s1", "uuid-2");
    assert.equal(store.get("s1")?.summary, "第一条");

    // 删除中间的消息不动摘要。
    store.addUserMessage("s1", "第三条", [], "uuid-3");
    assert.equal(store.get("s1")?.summary, "第三条");
    store.removeUserMessage("s1", "uuid-1");
    assert.equal(store.get("s1")?.summary, "第三条");
    assert.ok(!store.get("s1")?.messages.some((item) => item.text === "第一条"));

    await store.flush();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
