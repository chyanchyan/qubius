import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ScheduleRunner,
  ScheduleStore,
  type CreateScheduleInput,
  type Schedule,
} from "./schedules.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-schedules-"));
}

interface Clock {
  now: () => Date;
  set: (iso: string) => void;
  advance: (ms: number) => void;
}

function clock(iso: string): Clock {
  let current = new Date(iso);
  return {
    now: () => current,
    set: (value) => {
      current = new Date(value);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function input(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    projectId: "p1",
    prompt: "检查依赖更新",
    providerId: "prov",
    model: "sonnet",
    effort: "high",
    intervalMinutes: 5,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await sleep(5);
  }
}

test("创建日程时校验输入并立即落盘", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);

  assert.throws(() => store.create(input({ prompt: "   " })), /prompt 不能为空/);
  assert.throws(() => store.create(input({ prompt: "x".repeat(5001) })), /prompt 太长/);
  assert.throws(() => store.create(input({ intervalMinutes: 4 })), /间隔/);
  assert.throws(() => store.create(input({ intervalMinutes: 10_081 })), /间隔/);
  assert.throws(() => store.create(input({ intervalMinutes: 5.5 })), /间隔/);
  assert.throws(() => store.create(input({ effort: "fatal" as CreateScheduleInput["effort"] })), /effort/);
  assert.throws(() => store.create(input({ providerId: "  " })), /providerId 不能为空/);
  assert.throws(() => store.create(input({ model: "" })), /model 不能为空/);
  assert.throws(() => store.create(input({ projectId: " " })), /projectId 不能为空/);
  assert.throws(() => store.create(input({ enabled: "yes" as unknown as boolean })), /enabled 必须是布尔值/);

  const created = store.create(input());
  assert.equal(created.enabled, true);
  assert.equal(created.prompt, "检查依赖更新");
  assert.equal(created.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(created.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(created.nextRunAt, "2026-01-01T00:05:00.000Z");
  assert.equal(created.lastRunAt, undefined);
  assert.equal(created.lastError, undefined);

  const reloaded = new ScheduleStore(dir, time.now);
  assert.deepEqual(reloaded.list(), [created]);
});

test("update 先校验后写入，被拒绝的补丁不会留下半截状态", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ prompt: "原始 prompt", intervalMinutes: 60 }));

  assert.throws(() => store.update(created.id, { prompt: "新的 prompt", intervalMinutes: 4 }), /间隔/);
  assert.throws(
    () => store.update(created.id, { prompt: "新的 prompt", enabled: "yes" as unknown as boolean }),
    /enabled 必须是布尔值/,
  );

  const inMemory = store.list()[0]!;
  assert.equal(inMemory.prompt, "原始 prompt");
  assert.equal(inMemory.intervalMinutes, 60);
  assert.equal(inMemory.enabled, true);
  assert.deepEqual(new ScheduleStore(dir, time.now).list(), [inMemory]);
});

test("写盘失败时回滚内存并重新抛出", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const existing = store.create(input());
  const mutableFs = fs as unknown as { renameSync: typeof fs.renameSync };
  const original = mutableFs.renameSync;
  mutableFs.renameSync = () => {
    throw new Error("模拟写盘失败");
  };
  try {
    assert.throws(() => store.create(input({ prompt: "新日程" })), /模拟写盘失败/);
    assert.throws(() => store.update(existing.id, { prompt: "改过的 prompt" }), /模拟写盘失败/);
    assert.throws(() => store.remove(existing.id), /模拟写盘失败/);
    assert.throws(
      () => store.markRun(existing.id, { lastRunAt: time.now(), nextRunAt: time.now() }),
      /模拟写盘失败/,
    );
  } finally {
    mutableFs.renameSync = original;
  }

  const inMemory = store.list();
  assert.equal(inMemory.length, 1);
  assert.equal(inMemory[0]!.prompt, existing.prompt);
  assert.equal(inMemory[0]!.lastRunAt, undefined);
  assert.deepEqual(new ScheduleStore(dir, time.now).list(), inMemory);
});

test("列表按创建时间升序，并可按项目过滤", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const a = store.create(input({ projectId: "p1", prompt: "A" }));
  time.advance(60_000);
  const b = store.create(input({ projectId: "p2", prompt: "B" }));
  time.advance(60_000);
  const c = store.create(input({ projectId: "p1", prompt: "C" }));

  assert.deepEqual(store.list().map((item) => item.id), [a.id, b.id, c.id]);
  assert.deepEqual(store.list("p1").map((item) => item.id), [a.id, c.id]);
  assert.deepEqual(store.list("nope"), []);

  // 返回的是副本，改它不会影响存储。
  const first = store.list()[0]!;
  first.prompt = "被改了";
  assert.equal(store.list()[0]!.prompt, "A");
});

test("整份文件损坏会报错", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "schedules.json"), "{不是 JSON");
  assert.throws(() => new ScheduleStore(dir), /无法读取日程文件/);

  const other = tempDir();
  fs.writeFileSync(path.join(other, "schedules.json"), JSON.stringify({ schedule: [] }));
  assert.throws(() => new ScheduleStore(other), /无法读取日程文件/);
});

test("单条坏数据跳过并告警，全部坏掉则为空", () => {
  const dir = tempDir();
  const now = "2026-01-01T00:00:00.000Z";
  const valid = {
    id: "good",
    projectId: "p1",
    prompt: "正常的",
    providerId: "prov",
    model: "sonnet",
    effort: "high",
    intervalMinutes: 5,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
  };
  fs.writeFileSync(path.join(dir, "schedules.json"), JSON.stringify([valid, { id: "bad" }, 42]));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((item) => String(item)).join(" "));
  };
  try {
    assert.deepEqual(new ScheduleStore(dir).list().map((item) => item.id), ["good"]);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);

  fs.writeFileSync(path.join(dir, "schedules.json"), JSON.stringify([{ id: "bad" }, 42]));
  const silent = console.warn;
  console.warn = () => undefined;
  try {
    assert.deepEqual(new ScheduleStore(dir).list(), []);
  } finally {
    console.warn = silent;
  }
});

test("due 只返回启用且到点的日程，markRun 推进并落盘", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const active = store.create(input({ intervalMinutes: 5 }));
  const paused = store.create(input({ prompt: "暂停的", intervalMinutes: 5 }));
  store.update(paused.id, { enabled: false });

  assert.deepEqual(store.due(new Date("2026-01-01T00:04:59.000Z")), []);
  const due = store.due(new Date("2026-01-01T00:05:00.000Z"));
  assert.deepEqual(due.map((item) => item.id), [active.id]);

  store.markRun(active.id, {
    lastRunAt: new Date("2026-01-01T00:05:00.000Z"),
    nextRunAt: new Date("2026-01-01T00:10:00.000Z"),
    lastError: "boom",
  });
  assert.deepEqual(store.due(new Date("2026-01-01T00:09:59.000Z")), []);
  assert.deepEqual(store.due(new Date("2026-01-01T00:10:00.000Z")).map((item) => item.id), [active.id]);

  const reloaded = new ScheduleStore(dir, time.now);
  const stored = reloaded.list().find((item) => item.id === active.id)!;
  assert.equal(stored.lastRunAt, "2026-01-01T00:05:00.000Z");
  assert.equal(stored.nextRunAt, "2026-01-01T00:10:00.000Z");
  assert.equal(stored.lastError, "boom");

  reloaded.markRun(active.id, {
    lastRunAt: new Date("2026-01-01T00:10:00.000Z"),
    nextRunAt: new Date("2026-01-01T00:15:00.000Z"),
  });
  const after = new ScheduleStore(dir, time.now).list().find((item) => item.id === active.id)!;
  assert.equal("lastError" in after, false);
});

test("update 从关到开、改间隔都会重算 nextRunAt", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ intervalMinutes: 60 }));
  assert.equal(created.nextRunAt, "2026-01-01T01:00:00.000Z");

  time.set("2026-01-01T00:10:00.000Z");
  const off = store.update(created.id, { enabled: false, prompt: "  新 prompt  " });
  assert.equal(off.enabled, false);
  assert.equal(off.prompt, "新 prompt");
  assert.equal(off.nextRunAt, "2026-01-01T01:00:00.000Z");

  const on = store.update(created.id, { enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.nextRunAt, "2026-01-01T01:10:00.000Z");

  time.set("2026-01-01T00:20:00.000Z");
  const shorter = store.update(created.id, { intervalMinutes: 30 });
  assert.equal(shorter.intervalMinutes, 30);
  assert.equal(shorter.nextRunAt, "2026-01-01T00:50:00.000Z");

  assert.throws(() => store.update(created.id, { intervalMinutes: 2 }), /间隔/);
  assert.throws(() => store.update(created.id, { prompt: " " }), /prompt/);
  assert.throws(() => store.update("missing", { enabled: true }), /找不到定时任务/);
});

test("remove 删除并落盘", () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input());
  assert.equal(store.remove(created.id), true);
  assert.equal(store.remove(created.id), false);
  assert.deepEqual(new ScheduleStore(dir, time.now).list(), []);
});

test("runner 到点调用 createSession 并推进 nextRunAt", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ intervalMinutes: 5 }));
  time.set("2026-01-01T00:06:00.000Z");

  const seen: Schedule[] = [];
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async (schedule) => {
      seen.push(schedule);
      return { id: "sess-1" };
    },
  });

  const results = await runner.runDue();
  assert.deepEqual(results, [{ scheduleId: created.id, ok: true, sessionId: "sess-1" }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.prompt, created.prompt);
  assert.equal(seen[0]!.effort, "high");

  const stored = store.list().find((item) => item.id === created.id)!;
  assert.equal(stored.lastRunAt, "2026-01-01T00:06:00.000Z");
  assert.equal(stored.nextRunAt, "2026-01-01T00:11:00.000Z");
  assert.equal(stored.lastError, undefined);
});

test("runner 失败时写 lastError、nextRunAt 仍前进，且不影响其他日程", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const bad = store.create(input({ prompt: "bad", intervalMinutes: 5 }));
  time.advance(1_000);
  const good = store.create(input({ prompt: "good", intervalMinutes: 5 }));
  time.set("2026-01-01T00:06:00.000Z");

  const longMessage = "x".repeat(800);
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async (schedule) => {
      if (schedule.prompt === "bad") throw new Error(longMessage);
      return { id: "ok-sess" };
    },
  });

  const results = await runner.runDue();
  assert.deepEqual(results.map((item) => item.scheduleId), [bad.id, good.id]);
  assert.equal(results[0]!.ok, false);
  assert.equal(results[0]!.error?.length, 500);
  assert.equal(results[1]!.ok, true);
  assert.equal(results[1]!.sessionId, "ok-sess");

  const storedBad = store.list().find((item) => item.id === bad.id)!;
  assert.equal(storedBad.lastError?.length, 500);
  assert.equal(storedBad.lastRunAt, "2026-01-01T00:06:00.000Z");
  assert.equal(storedBad.nextRunAt, "2026-01-01T00:11:00.000Z");

  // 下次成功后清掉之前的错误。
  time.set("2026-01-01T00:11:00.000Z");
  const retry = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => ({ id: "recovered" }),
  });
  const recovered = await retry.runDue();
  assert.equal(recovered.length, 2);
  const recoveredBad = store.list().find((item) => item.id === bad.id)!;
  assert.equal(recoveredBad.lastError, undefined);
});

test("runDue 中标记失败也不影响后面的日程", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const first = store.create(input({ prompt: "first" }));
  time.advance(1_000);
  const second = store.create(input({ prompt: "second" }));
  time.set("2026-01-01T00:06:00.000Z");

  const mutableStore = store as unknown as { markRun: typeof store.markRun };
  const originalMarkRun = store.markRun.bind(store);
  mutableStore.markRun = (id, result) => {
    if (id === first.id) throw new Error("写入失败");
    return originalMarkRun(id, result);
  };

  const created: string[] = [];
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async (schedule) => {
      created.push(schedule.id);
      return { id: `sess-${schedule.id}` };
    },
  });
  try {
    const results = await runner.runDue();
    assert.deepEqual(created, [first.id, second.id]);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.error ?? "", /写入失败/);
    assert.equal(results[1]!.ok, true);
    assert.equal(results[1]!.sessionId, `sess-${second.id}`);
  } finally {
    mutableStore.markRun = originalMarkRun;
  }

  const storedSecond = store.list().find((item) => item.id === second.id)!;
  assert.equal(storedSecond.lastRunAt, "2026-01-01T00:06:00.000Z");
});

test("运行期间被删除或停用的日程不会创建会话", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const first = store.create(input({ prompt: "first" }));
  time.advance(1_000);
  const removed = store.create(input({ prompt: "removed" }));
  time.advance(1_000);
  const paused = store.create(input({ prompt: "paused" }));
  time.set("2026-01-01T00:06:00.000Z");

  const created: string[] = [];
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async (schedule) => {
      created.push(schedule.id);
      if (schedule.id === first.id) {
        store.remove(removed.id);
        store.update(paused.id, { enabled: false });
      }
      return { id: `sess-${schedule.id}` };
    },
  });

  const results = await runner.runDue();
  assert.deepEqual(created, [first.id]);
  assert.deepEqual(results.map((item) => item.scheduleId), [first.id]);
  assert.equal(store.list().some((item) => item.id === removed.id), false);
  assert.equal(store.list().find((item) => item.id === paused.id)?.enabled, false);
});

test("慢任务运行期间 X 被 runNow 跑掉后，旧快照不会重复执行", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const slow = store.create(input({ prompt: "slow" }));
  time.advance(1_000);
  const x = store.create(input({ prompt: "x" }));
  time.set("2026-01-01T00:06:00.000Z");

  let releaseSlow = (): void => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const created: string[] = [];
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async (schedule) => {
      created.push(schedule.id);
      if (schedule.id === slow.id) await slowGate;
      return { id: `sess-${schedule.id}` };
    },
  });

  const dueRun = runner.runDue();
  await waitFor(() => created.includes(slow.id));
  assert.deepEqual(await runner.runNow(x.id), { ok: true, sessionId: `sess-${x.id}` });
  releaseSlow();

  const results = await dueRun;
  assert.deepEqual(results.map((item) => item.scheduleId), [slow.id]);
  assert.equal(created.filter((id) => id === x.id).length, 1);
  const storedX = store.list().find((item) => item.id === x.id)!;
  assert.equal(storedX.nextRunAt, "2026-01-01T00:11:00.000Z");
});

test("停用后重新启用的日程，旧快照不会提前跑", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const slow = store.create(input({ prompt: "slow" }));
  time.advance(1_000);
  const revived = store.create(input({ prompt: "revived" }));
  time.set("2026-01-01T00:06:00.000Z");

  let releaseSlow = (): void => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const created: string[] = [];
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async (schedule) => {
      created.push(schedule.id);
      if (schedule.id === slow.id) {
        // 模拟运行期间有人先停用再启用；重新启用会把 nextRunAt 推到未来。
        store.update(revived.id, { enabled: false });
        store.update(revived.id, { enabled: true });
        await slowGate;
      }
      return { id: `sess-${schedule.id}` };
    },
  });

  const dueRun = runner.runDue();
  await waitFor(() => created.includes(slow.id));
  const revivedNow = store.list().find((item) => item.id === revived.id)!;
  assert.equal(revivedNow.nextRunAt, "2026-01-01T00:11:00.000Z");
  releaseSlow();

  const results = await dueRun;
  assert.deepEqual(results.map((item) => item.scheduleId), [slow.id]);
  assert.equal(created.filter((id) => id === revived.id).length, 0);
});

test("runNow 运行期间日程被删除时返回错误而不抛异常", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input());

  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => {
      store.remove(created.id);
      return { id: "sess" };
    },
  });

  assert.deepEqual(await runner.runNow(created.id), { ok: false, error: "定时任务已被删除" });
});

test("runNow 对停用的日程返回提示", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ enabled: false }));
  let calls = 0;
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => {
      calls += 1;
      return { id: "sess" };
    },
  });
  assert.deepEqual(await runner.runNow(created.id), { ok: false, error: "定时任务已停用" });
  assert.equal(calls, 0);
});

test("now 返回 Invalid Date 时不忙循环", async () => {
  const dir = tempDir();
  const store = new ScheduleStore(dir, () => new Date("2026-01-01T00:00:00.000Z"));
  store.create(input({ intervalMinutes: 5 }));

  let dueCalls = 0;
  const mutableStore = store as unknown as { due: typeof store.due };
  const originalDue = store.due.bind(store);
  mutableStore.due = (now: Date) => {
    dueCalls += 1;
    return originalDue(now);
  };

  let calls = 0;
  const runner = new ScheduleRunner({
    store,
    now: () => new Date(Number.NaN),
    tickMs: 20,
    createSession: async () => {
      calls += 1;
      return { id: "sess" };
    },
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    runner.start();
    await sleep(120);
    runner.stop();
  } finally {
    mutableStore.due = originalDue;
    console.error = originalError;
  }

  assert.equal(calls, 0);
  // 20ms 上限下 120ms 最多 ~6 次；若 NaN 被 setTimeout 当成 1ms 会远大于此。
  assert.ok(dueCalls <= 12, `dueCalls=${dueCalls}`);
});

test("now 抛错时调度不中断，恢复后继续触发", async () => {
  const dir = tempDir();
  const store = new ScheduleStore(dir, () => new Date());
  const created = store.create(input({ intervalMinutes: 5 }));
  store.markRun(created.id, {
    lastRunAt: new Date(),
    nextRunAt: new Date(Date.now() + 10),
  });

  let throws = 2;
  const now = (): Date => {
    if (throws > 0) {
      throws -= 1;
      throw new Error("clock boom");
    }
    return new Date();
  };

  let calls = 0;
  const runner = new ScheduleRunner({
    store,
    now,
    tickMs: 20,
    createSession: async () => {
      calls += 1;
      return { id: "sess" };
    },
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    runner.start();
    await waitFor(() => calls >= 1, 2_000);
  } finally {
    runner.stop();
    console.error = originalError;
  }
  assert.equal(calls, 1);
});

test("start 按最近 nextRunAt 触发，而不是等满 tickMs", async () => {
  const dir = tempDir();
  const store = new ScheduleStore(dir, () => new Date());
  const created = store.create(input({ intervalMinutes: 5 }));
  // 手动把 nextRunAt 提前到 ~40ms 后；tickMs 是 5s。
  store.markRun(created.id, {
    lastRunAt: new Date(),
    nextRunAt: new Date(Date.now() + 40),
  });

  let calls = 0;
  const runner = new ScheduleRunner({
    store,
    now: () => new Date(),
    tickMs: 5_000,
    createSession: async () => {
      calls += 1;
      return { id: "sess-early" };
    },
  });
  try {
    runner.start();
    // 若仍按固定 tickMs 轮询，这里要 5s 才会触发。
    await waitFor(() => calls >= 1, 2_000);
  } finally {
    runner.stop();
  }
  assert.equal(calls, 1);
});

test("失败的日程不会在同一时刻重试：nextRunAt 已后推", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ intervalMinutes: 5 }));
  time.set("2026-01-01T00:06:00.000Z");

  let calls = 0;
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => {
      calls += 1;
      throw new Error("boom");
    },
  });

  const first = await runner.runDue();
  assert.equal(first[0]!.ok, false);
  assert.equal(store.getById(created.id)!.nextRunAt, "2026-01-01T00:11:00.000Z");
  // 同一时刻再跑不会立刻重试失败任务。
  assert.deepEqual(await runner.runDue(), []);
  assert.equal(calls, 1);
});

test("start 按 tick 运行，stop 后不再执行", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  store.create(input({ intervalMinutes: 5 }));
  time.set("2026-01-01T00:06:00.000Z");

  // 不推进 nextRunAt，让日程一直处于到点状态，便于观察 tick 是否还在跑。
  const mutableStore = store as unknown as { markRun: typeof store.markRun };
  const originalMarkRun = store.markRun.bind(store);
  mutableStore.markRun = () => true;

  let calls = 0;
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    tickMs: 5,
    createSession: async () => {
      calls += 1;
      return { id: "sess" };
    },
  });
  try {
    runner.start();
    await waitFor(() => calls >= 2);
    runner.stop();
    const stoppedAt = calls;
    await sleep(40);
    assert.equal(calls, stoppedAt);
  } finally {
    runner.stop();
    mutableStore.markRun = originalMarkRun;
  }
});

test("同一条日程不会重入", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  store.create(input({ intervalMinutes: 5 }));
  time.set("2026-01-01T00:06:00.000Z");

  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => {
      calls += 1;
      await gate;
      return { id: "sess" };
    },
  });

  const first = runner.runDue();
  const second = await runner.runDue();
  assert.deepEqual(second, []);
  release();
  const firstResults = await first;
  assert.equal(calls, 1);
  assert.equal(firstResults[0]!.ok, true);
});

test("runNow 立刻运行未到点的日程并从现在重新计时", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ intervalMinutes: 60 }));
  time.set("2026-01-01T00:10:00.000Z");

  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => ({ id: "now-sess" }),
  });

  const result = await runner.runNow(created.id);
  assert.deepEqual(result, { ok: true, sessionId: "now-sess" });
  const stored = store.list()[0]!;
  assert.equal(stored.lastRunAt, "2026-01-01T00:10:00.000Z");
  assert.equal(stored.nextRunAt, "2026-01-01T01:10:00.000Z");
});

test("runNow 找不到日程或执行失败时返回错误", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ intervalMinutes: 5 }));

  const missing = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => ({ id: "unused" }),
  });
  assert.deepEqual(await missing.runNow("missing"), { ok: false, error: "找不到定时任务" });

  const failing = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => {
      throw new Error("创建失败");
    },
  });
  assert.deepEqual(await failing.runNow(created.id), { ok: false, error: "创建失败" });
  const stored = store.list()[0]!;
  assert.equal(stored.lastError, "创建失败");
  assert.equal(stored.lastRunAt, "2026-01-01T00:00:00.000Z");
  assert.equal(stored.nextRunAt, "2026-01-01T00:05:00.000Z");
});

test("runNow 与到点运行共用防重入，正在跑时返回错误", async () => {
  const dir = tempDir();
  const time = clock("2026-01-01T00:00:00.000Z");
  const store = new ScheduleStore(dir, time.now);
  const created = store.create(input({ intervalMinutes: 5 }));
  time.set("2026-01-01T00:06:00.000Z");

  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new ScheduleRunner({
    store,
    now: time.now,
    createSession: async () => {
      await gate;
      return { id: "sess" };
    },
  });

  const running = runner.runDue();
  const duplicate = await runner.runNow(created.id);
  assert.deepEqual(duplicate, { ok: false, error: "定时任务正在运行" });
  release();
  const results = await running;
  assert.equal(results[0]!.ok, true);
});
