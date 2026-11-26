import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  answerPrompt,
  decomposePrompt,
  finalPrompt,
  integrationTopic,
  parseAgreement,
  parseSubtasks,
  rebuttalPrompt,
  reviewPrompt,
  subtaskTopic,
  type DiscussionEntry,
  type Discussant,
} from "./discussion.js";
import { Runtime } from "./runtime.js";
import { Store, type CreateSessionInput } from "./store.js";
import type { DiscussionParticipant, Effort } from "./types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-discussion-"));
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
    workflow: "discuss",
  };
}

function participant(name: string, model: string, effort: Effort = "high"): DiscussionParticipant {
  return { name, providerId: "prov1", providerName: "服务商", model, effort };
}

function makeRuntime(store: Store, discussant: Discussant): Runtime {
  return new Runtime(store, {
    maxConcurrent: 2,
    fake: true,
    credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
    permission: () => "default",
    secrets: () => [],
    discussant,
  });
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

function entry(text: string, name = "甲", round = 1): DiscussionEntry {
  return { participant: participant(name, "m1"), kind: "answer", round, text };
}

test("parseAgreement：取最后一次裁定，缺失按不一致处理", () => {
  assert.equal(parseAgreement("……\n裁定：一致"), true);
  assert.equal(parseAgreement("……\n裁定: 一致。"), true);
  assert.equal(parseAgreement("裁定：不一致"), false);
  assert.equal(parseAgreement("先写裁定：一致，但后来又改成\n裁定：不一致"), false);
  assert.equal(parseAgreement("我觉得还行"), false);
  assert.equal(parseAgreement(""), false);
});

test("讨论提示词包含主题、发言身份和裁定格式", () => {
  const topic = "把登录接口改成 JWT";
  assert.match(answerPrompt(topic), /JWT/);
  const review = reviewPrompt(topic, [entry("旧答案")]);
  assert.match(review, /JWT/);
  assert.match(review, /甲 · 回答/);
  assert.match(review, /裁定：一致/);
  const rebuttal = rebuttalPrompt(topic, [entry("旧答案")]);
  assert.match(rebuttal, /逐条回应/);
  const final = finalPrompt(topic, [entry("旧答案")], false);
  assert.match(final, /仍有分歧|未解决/);
});

test("prepareDiscussion：会话进入待配置状态，不启动模型", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "讨论一下"));
    const prepared = store.prepareDiscussion("s1");
    assert.equal(prepared.discussion?.phase, "setup");
    assert.equal(prepared.phase, "setup");
    assert.equal(prepared.workflow?.skill, "discuss");
    assert.equal(prepared.turnActive, false);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("讨论：第一个回答、其余审阅，一致后由第一个给最终结论", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "给出一个缓存方案"));
    store.prepareDiscussion("s1");
    const calls: string[] = [];
    const runtime = makeRuntime(store, async (request) => {
      calls.push(`${request.participant.name}:${request.kind}:${request.round}`);
      if (request.kind === "review") return "没有阻塞性问题。\n裁定：一致";
      if (request.kind === "final") return "整合后的最终答复";
      return `${request.participant.name} 的正文`;
    });
    runtime.startDiscussion("s1", [participant("甲", "m1"), participant("乙", "m2", "low")]);
    await waitUntil(() => store!.require("s1").discussion?.phase === "completed");
    const session = store.require("s1");
    assert.deepEqual(calls, ["甲:answer:1", "乙:review:1", "甲:final:1"]);
    assert.equal(session.phase, "completed");
    assert.equal(session.discussion?.agreed, true);
    const messages = session.messages.filter((item) => item.discussion);
    assert.deepEqual(messages.map((item) => item.discussion?.kind), ["answer", "review", "final"]);
    assert.deepEqual(messages.map((item) => item.speaker), ["甲", "乙", "甲"]);
    assert.match(messages[messages.length - 1]?.text ?? "", /最终答复/);
    assert.ok(session.workflow?.endedAt);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("拆分提示词与解析：JSON、代码块和编号列表都能识别，单行散文退回不拆分", () => {
  assert.match(decomposePrompt("做个缓存"), /JSON 字符串数组/);
  assert.deepEqual(parseSubtasks('["读接口","写缓存"]'), ["读接口", "写缓存"]);
  assert.deepEqual(parseSubtasks('说明如下：\n```json\n["读接口","写缓存"]\n```'), ["读接口", "写缓存"]);
  assert.deepEqual(parseSubtasks("1. 读接口\n2. 写缓存"), ["读接口", "写缓存"]);
  assert.deepEqual(parseSubtasks("这只是对问题的回答，不适合拆分"), []);
  assert.deepEqual(parseSubtasks('["a","a","b","c","d","e"]').length, 4);
  assert.match(subtaskTopic("读接口", "做个缓存"), /只讨论其中一个子任务[\s\S]*读接口/);
  assert.match(integrationTopic("做个缓存", [{ title: "读接口", conclusion: "结论" }]), /子任务 1[\s\S]*结论/);
});

test("dis-prl：第一个模型拆分，子任务并行讨论，最后集成", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create({ ...createInput("s1", "把缓存方案拆开讨论"), workflow: "dis-prl" });
    store.prepareDiscussion("s1", undefined, "dis-prl");
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = makeRuntime(store, async (request) => {
      const isSubtask = request.prompt.includes("本次只讨论其中一个子任务");
      const topic = request.prompt.includes("整合成一个完整答复")
        ? "集成"
        : isSubtask && request.prompt.includes("子任务一")
          ? "子任务一"
          : isSubtask && request.prompt.includes("子任务二")
            ? "子任务二"
            : "拆分";
      calls.push(`${request.participant.name}:${request.kind}:${topic}`);
      if (request.kind === "decompose") return '["子任务一","子任务二"]';
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      if (request.kind === "review") return "没有阻塞性问题。\n裁定：一致";
      if (request.kind === "final") return `${request.participant.name} 的结论`;
      return `${request.participant.name} 的正文`;
    });
    runtime.startDiscussion("s1", [participant("甲", "m1"), participant("乙", "m2")], "parallel");
    await waitUntil(() => store!.require("s1").discussion?.phase === "completed");
    const session = store.require("s1");
    const discussion = session.discussion!;
    assert.equal(discussion.strategy, "parallel");
    assert.equal(discussion.agreed, true);
    assert.deepEqual(discussion.subtasks?.map((item) => item.phase), ["completed", "completed"]);
    assert.ok(maxInFlight >= 2, "两个子任务的模型调用应该同时在飞");

    assert.equal(calls.filter((call) => call === "甲:decompose:拆分").length, 1);
    for (const topic of ["子任务一", "子任务二"]) {
      assert.ok(calls.includes(`甲:answer:${topic}`));
      assert.ok(calls.includes(`乙:review:${topic}`));
      assert.ok(calls.includes(`甲:final:${topic}`));
    }
    assert.ok(calls.includes("甲:answer:集成"));
    assert.ok(calls.includes("乙:review:集成"));
    assert.ok(calls.includes("甲:final:集成"));

    const messages = session.messages.filter((item) => item.discussion);
    assert.equal(messages[0]?.discussion?.kind, "decompose");
    // 两个子任务并行，全局顺序不定；按子任务分组，组内必须保持原流程顺序。
    const bySubtask = new Map<number, Array<string | undefined>>();
    for (const item of messages) {
      const subtask = item.discussion?.subtask;
      if (!subtask) continue;
      const list = bySubtask.get(subtask.index) ?? [];
      list.push(item.discussion?.kind);
      bySubtask.set(subtask.index, list);
    }
    assert.deepEqual(bySubtask.get(1), ["answer", "review", "final"]);
    assert.deepEqual(bySubtask.get(2), ["answer", "review", "final"]);
    assert.deepEqual(
      messages.filter((item) => item.discussion?.integration).map((item) => item.discussion?.kind),
      ["answer", "review", "final"],
    );
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("dis-prl：拆分不可靠时退回普通讨论", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create({ ...createInput("s1", "只讨论一个问题"), workflow: "dis-prl" });
    store.prepareDiscussion("s1", undefined, "dis-prl");
    const kinds: string[] = [];
    const runtime = makeRuntime(store, async (request) => {
      kinds.push(request.kind);
      if (request.kind === "decompose") return "这是一个单一问题，不需要拆分。";
      if (request.kind === "review") return "裁定：一致";
      return `${request.participant.name} 的正文`;
    });
    runtime.startDiscussion("s1", [participant("甲", "m1"), participant("乙", "m2")], "parallel");
    await waitUntil(() => store!.require("s1").discussion?.phase === "completed");
    const discussion = store.require("s1").discussion!;
    assert.equal(discussion.agreed, true);
    assert.equal(discussion.subtasks, undefined);
    assert.deepEqual(kinds, ["decompose", "answer", "review", "final"]);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("讨论：审阅不一致时进入答辩轮，复审一致后收尾", async () => {
  const dataDir = tempDir();
  let store: Store | undefined;
  try {
    store = new Store(dataDir);
    store.create(createInput("s1", "给出一个缓存方案"));
    store.prepareDiscussion("s1");
    const calls: string[] = [];
    const runtime = makeRuntime(store, async (request) => {
      calls.push(`${request.participant.name}:${request.kind}:${request.round}`);
      if (request.kind !== "review") return `${request.participant.name} 的正文`;
      return request.round === 1 ? "还有遗漏。\n裁定：不一致" : "这次可以了。\n裁定：一致";
    });
    runtime.startDiscussion("s1", [participant("甲", "m1"), participant("乙", "m2")]);
    await waitUntil(() => store!.require("s1").discussion?.phase === "completed");
    const session = store.require("s1");
    assert.deepEqual(calls, [
      "甲:answer:1",
      "乙:review:1",
      "甲:rebuttal:2",
      "乙:review:2",
      "甲:final:2",
    ]);
    assert.equal(session.discussion?.round, 2);
    assert.equal(session.discussion?.agreed, true);
    const kinds = session.messages.filter((item) => item.discussion).map((item) => item.discussion?.kind);
    assert.deepEqual(kinds, ["answer", "review", "rebuttal", "review", "final"]);
  } finally {
    await store?.flush().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
