import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRef, Session, Transcript } from "./api";
import {
  buildRewindBody,
  canOfferMessageActions,
  canSubmitMessageEdit,
  hasRunningBackgroundTasks,
  rewindCheckboxState,
  rewindComposerRefill,
} from "./message-actions";

function item(overrides: Partial<Transcript> = {}): Transcript {
  return { id: "m1", role: "user", text: "你好", rewindable: true, ...overrides };
}

function session(overrides: Partial<Pick<Session, "phase">> = {}): Pick<Session, "phase"> {
  return { phase: "completed", ...overrides };
}

const image: ImageRef = { id: "img-1", mediaType: "image/png", name: "a.png" };

test("空闲会话里的可回滚用户消息显示操作菜单", () => {
  assert.equal(canOfferMessageActions(session(), item()), true);
  assert.equal(canOfferMessageActions(session({ phase: "failed" }), item()), true);
  assert.equal(canOfferMessageActions(session({ phase: "stopped" }), item()), true);
});

test("会话进行中（排队/运行/等待确认）不显示操作菜单", () => {
  for (const phase of ["queued", "running", "needs_input"] as const) {
    assert.equal(canOfferMessageActions(session({ phase }), item()), false, phase);
  }
});

test("只有用户消息、且不是本地发送中才显示菜单", () => {
  assert.equal(canOfferMessageActions(session(), item({ role: "assistant" })), false);
  assert.equal(canOfferMessageActions(session(), item({ role: "tool", toolName: "Bash" })), false);
  assert.equal(canOfferMessageActions(session(), item({ status: "sending" })), false);
});

test("服务端标记 rewindable 才显示菜单（旧服务端/太旧的消息没有该字段）", () => {
  assert.equal(canOfferMessageActions(session(), item({ rewindable: false })), false);
  assert.equal(canOfferMessageActions(session(), item({ rewindable: undefined })), false);
  assert.equal(canOfferMessageActions(session(), item({ rewindable: true })), true);
});

test("发送请求或另一个消息操作在途时隐藏菜单", () => {
  // busy 覆盖 Composer 发送、messageBusy 和「继续上次」三种情况，避免并发回滚。
  assert.equal(canOfferMessageActions(session(), item(), { busy: true }), false);
  assert.equal(canOfferMessageActions(session(), item(), { busy: false }), true);
});

test("有正在运行的后台任务时不显示菜单（phase 仍可能 completed）", () => {
  assert.equal(canOfferMessageActions(session(), item(), { backgroundBusy: true }), false);
  assert.equal(canOfferMessageActions(session(), item(), { backgroundBusy: false }), true);
});

test("只有 running 状态的后台任务算忙碌", () => {
  assert.equal(hasRunningBackgroundTasks(undefined), false);
  assert.equal(hasRunningBackgroundTasks([]), false);
  assert.equal(hasRunningBackgroundTasks([{ status: "completed" }, { status: "failed" }]), false);
  assert.equal(hasRunningBackgroundTasks([{ status: "completed" }, { status: "running" }]), true);
});

test("能回滚代码时勾选项可用并说明恢复文件", () => {
  const state = rewindCheckboxState(true);
  assert.equal(state.disabled, false);
  assert.equal(state.description, "把 agent 改过的文件恢复到这条消息之前。");
});

test("不能回滚代码时（含旧服务端缺字段）勾选项禁用并说明原因", () => {
  const message = "当前无法回滚代码：对话进程已结束或这条消息没有文件检查点。";
  for (const value of [false, undefined]) {
    const state = rewindCheckboxState(value);
    assert.equal(state.disabled, true);
    assert.equal(state.description, message);
  }
});

test("回滚请求体只带消息 id 和显式指定的文件开关", () => {
  assert.deepEqual(buildRewindBody("m1"), { messageId: "m1" });
  assert.deepEqual(buildRewindBody("m1", true), { messageId: "m1", files: true });
  assert.deepEqual(buildRewindBody("m1", false), { messageId: "m1", files: false });
});

test("回滚请求体带编辑内容：空 keepImages 不上送，workflow 仅在指定时带上", () => {
  assert.deepEqual(
    buildRewindBody("m1", false, {
      prompt: "改过的内容",
      keepImages: [],
      workflow: undefined,
    }),
    { messageId: "m1", files: false, prompt: "改过的内容" },
  );
  assert.deepEqual(
    buildRewindBody("m1", true, {
      prompt: "改过的内容",
      keepImages: [image],
      workflow: "ser",
    }),
    {
      messageId: "m1",
      files: true,
      prompt: "改过的内容",
      keepImages: [image],
      workflow: "ser",
    },
  );
});

test("纯图片消息的编辑重发保留空 prompt", () => {
  assert.deepEqual(
    buildRewindBody("m1", false, { prompt: "", keepImages: [image] }),
    { messageId: "m1", files: false, prompt: "", keepImages: [image] },
  );
});

test("纯回滚只在输入框为空时回填文本", () => {
  assert.equal(rewindComposerRefill("", "原问题"), "原问题");
  assert.equal(rewindComposerRefill("   \n", "原问题"), "原问题");
  assert.equal(rewindComposerRefill("我正在写的新草稿", "原问题"), null);
});

test("编辑重发：纯文本不能为空，带原消息图片时允许只有图片", () => {
  assert.equal(canSubmitMessageEdit("", 0), false);
  assert.equal(canSubmitMessageEdit("   ", 0), false);
  assert.equal(canSubmitMessageEdit("", 1), true);
  assert.equal(canSubmitMessageEdit("   ", 2), true);
  assert.equal(canSubmitMessageEdit("文字", 0), true);
});
