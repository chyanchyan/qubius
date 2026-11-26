import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PushError,
  PushService,
  type PushSender,
  type PushSessionEvent,
  type PushSubscriptionInput,
  vapidSubject,
} from "./push.js";
import type { Phase } from "./types.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-push-"));
}

function makeKeys(): PushSubscriptionInput["keys"] {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    p256dh: Buffer.from(der.subarray(der.length - 65)).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

function subscription(endpoint = "https://push.example.com/sub/one"): PushSubscriptionInput {
  return { endpoint, keys: makeKeys() };
}

interface RecordedSend {
  endpoint: string;
  payload: string;
}

function recorder(): { sent: RecordedSend[]; send: PushSender } {
  const sent: RecordedSend[] = [];
  const send: PushSender = async (item, payload) => {
    sent.push({ endpoint: item.endpoint, payload });
  };
  return { sent, send };
}

function sessionEvent(phase: Phase, overrides: Partial<PushSessionEvent> = {}): PushSessionEvent {
  return { id: "s1", projectId: "p1", title: "修复登录", phase, ...overrides };
}

function delay(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("等待推送发送超时");
    await delay(5);
  }
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

test("VAPID subject 默认是占位邮箱，可由 env 覆盖", () => {
  assert.equal(vapidSubject({}), "mailto:admin@example.com");
  assert.equal(vapidSubject({ QUBIUS_VAPID_SUBJECT: "   " }), "mailto:admin@example.com");
  assert.equal(vapidSubject({ QUBIUS_VAPID_SUBJECT: "mailto:ops@example.com" }), "mailto:ops@example.com");
  assert.equal(
    vapidSubject({ QUBIUS_VAPID_SUBJECT: "  https://example.com/push  " }),
    "https://example.com/push",
  );
});

test("VAPID subject 非法时抛错，构造 PushService 也会失败", () => {
  assert.throws(() => vapidSubject({ QUBIUS_VAPID_SUBJECT: "ops@example.com" }), PushError);
  assert.throws(() => vapidSubject({ QUBIUS_VAPID_SUBJECT: "ftp://example.com" }), PushError);
  assert.throws(() => vapidSubject({ QUBIUS_VAPID_SUBJECT: "https://" }), PushError);

  const previous = process.env.QUBIUS_VAPID_SUBJECT;
  process.env.QUBIUS_VAPID_SUBJECT = "not-a-subject";
  try {
    assert.throws(() => new PushService(tempDataDir()), PushError);
  } finally {
    if (previous === undefined) delete process.env.QUBIUS_VAPID_SUBJECT;
    else process.env.QUBIUS_VAPID_SUBJECT = previous;
  }
});

test("VAPID 密钥只生成一次，重启后复用", () => {
  const dir = tempDataDir();
  const first = new PushService(dir);
  const publicKey = first.status().publicKey;
  assert.match(publicKey, /^[A-Za-z0-9_-]+$/);

  const pushDir = path.join(dir, "push");
  const vapidFile = path.join(pushDir, "vapid.json");
  assert.equal(fs.statSync(pushDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(vapidFile).mode & 0o777, 0o600);
  const stored = readJson(vapidFile) as { publicKey: string; privateKey: string };
  assert.equal(stored.publicKey, publicKey);
  assert.ok(stored.privateKey.length > 0);

  const second = new PushService(dir);
  assert.equal(second.status().publicKey, publicKey);
});

test("订阅校验拒绝非法输入", () => {
  const dir = tempDataDir();
  const push = new PushService(dir);
  const good = subscription();
  push.subscribe(good);

  const invalid: unknown[] = [
    null,
    "nope",
    [],
    { endpoint: "http://push.example.com/x", keys: good.keys },
    { endpoint: "ftp://push.example.com/x", keys: good.keys },
    { endpoint: "https://user:pass@push.example.com/x", keys: good.keys },
    { endpoint: `https://push.example.com/${"a".repeat(2048)}`, keys: good.keys },
    { endpoint: good.endpoint, keys: { ...good.keys, p256dh: Buffer.alloc(64).toString("base64url") } },
    { endpoint: good.endpoint, keys: { ...good.keys, auth: Buffer.alloc(15).toString("base64url") } },
    { endpoint: good.endpoint, keys: { ...good.keys, auth: "not a base64url!" } },
    { endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh } },
    { endpoint: good.endpoint },
  ];
  for (const input of invalid) {
    assert.throws(() => push.subscribe(input), PushError);
  }
  assert.equal(push.status().count, 1);
});

test("同一 endpoint 重复订阅会替换密钥且保持幂等", () => {
  const dir = tempDataDir();
  const push = new PushService(dir);
  const first = subscription("https://push.example.com/same");
  push.subscribe(first);
  const replacement = { endpoint: first.endpoint, keys: makeKeys() };
  assert.equal(push.subscribe(replacement).count, 1);

  const stored = readJson(path.join(dir, "push", "subscriptions.json")) as PushSubscriptionInput[];
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.keys, replacement.keys);
  assert.equal(new PushService(dir).status().count, 1);
});

test("最多保留 20 条订阅，满额时仍可更新已有订阅", () => {
  const dir = tempDataDir();
  const push = new PushService(dir);
  const subscriptions: PushSubscriptionInput[] = [];
  for (let index = 0; index < 20; index += 1) {
    const item = subscription(`https://push.example.com/s/${index}`);
    subscriptions.push(item);
    push.subscribe(item);
  }
  assert.equal(push.status().count, 20);
  assert.throws(() => push.subscribe(subscription("https://push.example.com/s/20")), PushError);
  assert.equal(push.subscribe({ endpoint: subscriptions[0]!.endpoint, keys: makeKeys() }).count, 20);
});

test("取消订阅删除匹配项，不存在也成功", () => {
  const dir = tempDataDir();
  const push = new PushService(dir);
  const first = subscription("https://push.example.com/a");
  const second = subscription("https://push.example.com/b");
  push.subscribe(first);
  push.subscribe(second);

  assert.equal(push.unsubscribe({ endpoint: first.endpoint }).count, 1);
  assert.equal(push.unsubscribe({ endpoint: first.endpoint }).count, 1);
  assert.equal(push.unsubscribe({ endpoint: "https://push.example.com/missing" }).count, 1);
  assert.throws(() => push.unsubscribe({}), PushError);
  assert.throws(() => push.unsubscribe({ endpoint: 42 }), PushError);
  assert.throws(() => push.unsubscribe(null), PushError);
  assert.equal(new PushService(dir).status().count, 1);
});

test("status 返回按需生成的公钥和订阅数量", () => {
  const dir = tempDataDir();
  const push = new PushService(dir);
  assert.equal(push.status().count, 0);
  assert.ok(push.status().publicKey.length > 0);
  push.subscribe(subscription());
  assert.equal(push.status().count, 1);
});

test("sendTest 向所有订阅发送测试通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription("https://push.example.com/a"));
  push.subscribe(subscription("https://push.example.com/b"));

  const result = await push.sendTest();
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.equal(sent.length, 2);
  const expected = {
    title: "测试通知",
    body: "qubius 推送已配置好。",
    url: "/",
    tag: "test",
  };
  for (const item of sent) assert.deepEqual(JSON.parse(item.payload), expected);
});

test("没有订阅时 sendTest 不发送任何请求", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  assert.deepEqual(await push.sendTest(), { sent: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

test("注入 sender 时不访问真实推送服务", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription("https://127.0.0.1:9/never"));
  const result = await push.sendTest();
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(sent.length, 1);
});

test("本轮结束时发送完成通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目甲");
  assert.equal(sent.length, 0);
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目甲");

  await waitFor(() => sent.length === 1);
  assert.deepEqual(JSON.parse(sent[0]!.payload), {
    title: "项目甲 · 完成",
    body: "修复登录",
    url: "/sessions/s1",
    tag: "session-s1",
  });
});

test("本轮结束时后台子 agent 还在跑也立即通知，子 agent 收尾不再重复", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目甲");
  // result 已到但后台子 agent 还没结束，Store 此时仍按 running 上报。
  push.onSessionEvent(sessionEvent("running", { turnEnd: 1, lastResult: "success" }), "项目甲");
  await waitFor(() => sent.length === 1);
  assert.equal(JSON.parse(sent[0]!.payload).title, "项目甲 · 完成");

  // 最后一个子 agent 结束，phase 才落到 completed：这不是新的一轮，不再推送。
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目甲");
  await delay();
  assert.equal(sent.length, 1);
});

test("只有子 agent 收尾、没有本轮结束时不通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 0, lastResult: "success" }), "项目");
  await delay();
  assert.equal(sent.length, 0);
});

test("从 running 进入 needs_input 时发送一次等待确认通知，重复上报不再发", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running"), "项目甲");
  assert.equal(sent.length, 0);

  const pending = {
    requestId: "r1",
    kind: "permission" as const,
    toolName: "Bash",
    inputPreview: "rm -rf /",
    blockedPath: "/etc/passwd",
  };
  push.onSessionEvent(sessionEvent("needs_input", { pending }), "项目甲");
  await waitFor(() => sent.length === 1);
  assert.deepEqual(JSON.parse(sent[0]!.payload), {
    title: "项目甲 · 等待确认",
    body: "Bash：/etc/passwd",
    url: "/sessions/s1",
    tag: "session-s1",
  });

  // 重复上报同一个 needs_input 状态不应再次通知。
  push.onSessionEvent(sessionEvent("needs_input", { pending }), "项目甲");
  await delay();
  assert.equal(sent.length, 1);
});

test("needs_input 回到 running 后再次进入会重新发送等待确认通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());
  const pending = {
    requestId: "r1",
    kind: "permission" as const,
    toolName: "Write",
    inputPreview: "{}",
  };

  push.onSessionEvent(sessionEvent("running"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", { pending }), "项目");
  await waitFor(() => sent.length === 1);

  push.onSessionEvent(sessionEvent("running"), "项目");
  await delay();
  assert.equal(sent.length, 1);

  // 新的确认请求（不同 requestId）进入 needs_input 时应再次通知。
  push.onSessionEvent(sessionEvent("needs_input", { pending: { ...pending, requestId: "r2" } }), "项目");
  await waitFor(() => sent.length === 2);
  assert.equal(JSON.parse(sent[1]!.payload).title, "项目 · 等待确认");
});

test("同一 requestId 即使经历 running 也不重复通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());
  const pending = { requestId: "same", kind: "permission" as const, toolName: "Bash", inputPreview: "" };

  push.onSessionEvent(sessionEvent("running"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", { pending }), "项目");
  await waitFor(() => sent.length === 1);
  // 事件重复上报同一个 pending（即使中间穿插了 running）也不应再发。
  push.onSessionEvent(sessionEvent("running"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", { pending }), "项目");
  await delay();
  assert.equal(sent.length, 1);
});

test("pending 为空时进入 needs_input 不发送通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running"), "项目");
  push.onSessionEvent(sessionEvent("needs_input"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", { pending: null }), "项目");
  await delay();
  assert.equal(sent.length, 0);
});

test("queued 直接进入 needs_input 也会发送", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("queued"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", {
    pending: { requestId: "q1", kind: "permission", toolName: "Bash", inputPreview: "" },
  }), "项目");
  await waitFor(() => sent.length === 1);
  assert.equal(JSON.parse(sent[0]!.payload).title, "项目 · 等待确认");
});

test("completed 后再次进入 needs_input 也会发送", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目");
  await waitFor(() => sent.length === 1);

  push.onSessionEvent(sessionEvent("needs_input", {
    turnEnd: 1,
    pending: { requestId: "q2", kind: "permission", toolName: "Write", inputPreview: "" },
  }), "项目");
  await waitFor(() => sent.length === 2);
  assert.equal(JSON.parse(sent[1]!.payload).title, "项目 · 等待确认");
});

test("needs_input 直接落到本轮结束仍发送完成通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("needs_input", {
    turnEnd: 0,
    pending: { requestId: "r1", kind: "permission", toolName: "Bash", inputPreview: "" },
  }), "项目");
  await waitFor(() => sent.length === 1);

  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目");
  await waitFor(() => sent.length === 2);
  assert.equal(JSON.parse(sent[1]!.payload).title, "项目 · 完成");
});

test("问题型确认的正文取第一个问题，没有问题时退回 header", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", {
    pending: {
      requestId: "q1",
      kind: "question",
      toolName: "AskUserQuestion",
      inputPreview: "{}",
      questions: [{ question: "用哪个方案？", header: "方案", options: [], multiSelect: false }],
    },
  }), "项目");
  await waitFor(() => sent.length === 1);
  assert.equal(JSON.parse(sent[0]!.payload).body, "用哪个方案？");

  const second = new PushService(tempDataDir(), { send });
  second.subscribe(subscription());
  const before = sent.length;
  second.onSessionEvent(sessionEvent("running", { id: "s2" }), "项目");
  second.onSessionEvent(sessionEvent("needs_input", {
    id: "s2",
    pending: {
      requestId: "q2",
      kind: "question",
      toolName: "AskUserQuestion",
      inputPreview: "{}",
      questions: [{ question: "", header: "请选择", options: [], multiSelect: false }],
    },
  }), "项目");
  await waitFor(() => sent.length === before + 1);
  assert.equal(JSON.parse(sent[before]!.payload).body, "请选择");
});

test("等待确认正文超过 200 字符时截断", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running"), "项目");
  push.onSessionEvent(sessionEvent("needs_input", {
    pending: {
      requestId: "q1",
      kind: "question",
      toolName: "AskUserQuestion",
      inputPreview: "{}",
      questions: [{ question: "问".repeat(500), options: [], multiSelect: false }],
    },
  }), "项目");
  await waitFor(() => sent.length === 1);
  assert.equal(JSON.parse(sent[0]!.payload).body.length, 200);
});

test("失败通知附带 lastError 并截断到 200 字符", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目乙");
  push.onSessionEvent(sessionEvent("failed", {
    turnEnd: 1,
    lastResult: "error",
    lastError: "x".repeat(500),
  }), "项目乙");
  await waitFor(() => sent.length === 1);

  const notice = JSON.parse(sent[0]!.payload) as { title: string; body: string };
  assert.equal(notice.title, "项目乙 · 失败");
  assert.equal(notice.body.length, 200);
  assert.ok(notice.body.startsWith("修复登录："));
});

test("同一轮重复上报不会重复通知，用户停止不通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目");
  await waitFor(() => sent.length === 1);
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目");
  push.onSessionEvent(sessionEvent("stopped", { turnEnd: 2, lastResult: "stopped" }), "项目");
  await delay();
  assert.equal(sent.length, 1);
});

test("每一轮结束都会通知，不限于第一轮", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目");
  await waitFor(() => sent.length === 1);

  push.onSessionEvent(sessionEvent("running", { turnEnd: 1 }), "项目");
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 2, lastResult: "success" }), "项目");
  await waitFor(() => sent.length === 2);
  assert.equal(JSON.parse(sent[1]!.payload).title, "项目 · 完成");
});

test("没有轮次结束（turnEnd 未增加）时不通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("completed", { lastResult: "success" }), "项目");
  push.onSessionEvent(sessionEvent("stopped", { lastResult: "stopped" }), "项目");
  await delay();
  assert.equal(sent.length, 0);
});

test("没有订阅时不发送通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("completed", { turnEnd: 1, lastResult: "success" }), "项目");
  await delay();
  assert.equal(sent.length, 0);
});

test("removed 事件本身不通知", async () => {
  const { sent, send } = recorder();
  const push = new PushService(tempDataDir(), { send });
  push.subscribe(subscription());

  push.onSessionEvent(sessionEvent("running", { turnEnd: 0 }), "项目");
  push.onSessionEvent(sessionEvent("stopped", {
    turnEnd: 1,
    lastResult: "stopped",
    removed: true,
  }), "项目");
  await delay();
  assert.equal(sent.length, 0);
});

test("404/410 的订阅会被移除，其他订阅继续发送", async () => {
  const dir = tempDataDir();
  const gone404 = subscription("https://push.example.com/gone-404");
  const gone410 = subscription("https://push.example.com/gone-410");
  const alive = subscription("https://push.example.com/alive");
  const send: PushSender = async (item) => {
    if (item.endpoint === gone404.endpoint) throw Object.assign(new Error("gone"), { statusCode: 404 });
    if (item.endpoint === gone410.endpoint) throw Object.assign(new Error("gone"), { statusCode: 410 });
  };
  const push = new PushService(dir, { send });
  push.subscribe(gone404);
  push.subscribe(gone410);
  push.subscribe(alive);

  const result = await push.sendTest();
  assert.deepEqual(result, { sent: 1, failed: 2 });
  assert.equal(push.status().count, 1);
  const stored = readJson(path.join(dir, "push", "subscriptions.json")) as PushSubscriptionInput[];
  assert.deepEqual(stored.map((item) => item.endpoint), [alive.endpoint]);
  assert.equal(new PushService(dir).status().count, 1);
});

test("其他发送错误不会移除订阅", async () => {
  const dir = tempDataDir();
  const item = subscription();
  const push = new PushService(dir, {
    send: async () => {
      throw Object.assign(new Error("server error"), { statusCode: 500 });
    },
  });
  push.subscribe(item);
  assert.deepEqual(await push.sendTest(), { sent: 0, failed: 1 });
  assert.equal(push.status().count, 1);
});

test("订阅文件损坏时构造抛出 PushError 且不改写原文件", () => {
  const dir = tempDataDir();
  const pushDir = path.join(dir, "push");
  fs.mkdirSync(pushDir, { recursive: true });
  const file = path.join(pushDir, "subscriptions.json");
  fs.writeFileSync(file, "{not-json");
  assert.throws(() => new PushService(dir), PushError);
  assert.equal(fs.readFileSync(file, "utf8"), "{not-json");

  const otherDir = tempDataDir();
  fs.mkdirSync(path.join(otherDir, "push"), { recursive: true });
  fs.writeFileSync(path.join(otherDir, "push", "subscriptions.json"), JSON.stringify({ endpoint: "x" }));
  assert.throws(() => new PushService(otherDir), PushError);
});
