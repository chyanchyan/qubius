import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanGeneratedTitle,
  PROVISIONAL_TITLE,
  resultText,
  titleFromPrompt,
  titleInput,
  titlePrompt,
} from "./session-title.js";
import type { SessionCore } from "./types.js";

function session(overrides: Partial<SessionCore> = {}): SessionCore {
  return {
    id: "s1",
    projectId: "p1",
    projectPath: "/tmp/project",
    title: PROVISIONAL_TITLE,
    titlePending: true,
    providerId: "prov1",
    providerName: "服务商",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    summary: "",
    phase: "completed",
    turnActive: false,
    queued: false,
    subagents: [],
    messages: [],
    pending: null,
    seen: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("初始标题：取用户消息第一行，折叠空白，不截断", () => {
  assert.equal(titleFromPrompt("修一下登录超时"), "修一下登录超时");
  assert.equal(titleFromPrompt("  修一下   登录超时  "), "修一下 登录超时");
  assert.equal(titleFromPrompt("\n\n修一下登录超时\n顺便补测试"), "修一下登录超时");
  assert.equal(titleFromPrompt("修一下登录\r\n顺便补测试"), "修一下登录");
  // 不设长度上限：超长消息原样保留，由界面省略显示。
  assert.equal(titleFromPrompt("字".repeat(200)), "字".repeat(200));
  // 只发图片（没有文字）时退回占位词，等首轮总结。
  assert.equal(titleFromPrompt(""), PROVISIONAL_TITLE);
  assert.equal(titleFromPrompt("  \n\t "), PROVISIONAL_TITLE);
});

test("标题清洗：只取第一行，去掉 Markdown、前缀和引号", () => {
  assert.equal(cleanGeneratedTitle("修复登录接口超时"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("## 修复登录接口超时"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("标题：修复登录接口超时"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("Title: Fix login timeout"), "Fix login timeout");
  assert.equal(cleanGeneratedTitle("「修复登录接口超时」"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("`修复登录接口超时`"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("第一行标题\n第二行解释"), "第一行标题");
  assert.equal(cleanGeneratedTitle("  修复   登录  "), "修复 登录");
});

test("标题清洗：去掉句末标点，不截断超长标题", () => {
  assert.equal(cleanGeneratedTitle("修复登录接口超时。"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("修复登录接口超时？"), "修复登录接口超时");
  assert.equal(cleanGeneratedTitle("fix login timeout!"), "fix login timeout");
  // 不设长度上限，完整保留。
  assert.equal(cleanGeneratedTitle("字".repeat(200)), "字".repeat(200));
});

test("标题清洗：空内容、只有标点或退化成占位词时返回 undefined", () => {
  assert.equal(cleanGeneratedTitle(""), undefined);
  assert.equal(cleanGeneratedTitle("   \n  "), undefined);
  assert.equal(cleanGeneratedTitle("。"), undefined);
  assert.equal(cleanGeneratedTitle(PROVISIONAL_TITLE), undefined);
});

test("resultText：只接受成功且非接口错误的正文", () => {
  assert.equal(resultText({ subtype: "success", is_error: false, result: "修复登录超时" }), "修复登录超时");
  // 限流/过载等接口错误也会以 success + is_error 的形式带回错误正文。
  assert.equal(resultText({ subtype: "success", is_error: true, result: "API Error: 429 rate limited" }), undefined);
  assert.equal(resultText({ subtype: "error_during_execution", is_error: true, result: "失败" }), undefined);
  assert.equal(resultText({ subtype: "error_max_turns", is_error: false, result: "超出轮次" }), undefined);
  assert.equal(resultText({ subtype: "success", is_error: false }), undefined);
  assert.equal(resultText({ subtype: "success", is_error: false, result: 42 }), undefined);
});

test("标题材料：取首条用户消息和最后一条助手正文，跳过思考和流式残片", () => {
  const input = titleInput(session({
    messages: [
      { id: "u1", role: "user", text: "修一下登录超时\n顺便补测试" },
      { id: "a1", role: "assistant", kind: "thinking", text: "先看日志" },
      { id: "a2", role: "assistant", text: "已经定位到超时原因。" },
      { id: "t1", role: "tool", text: "grep ..." },
      { id: "u2", role: "user", text: "再加快一点" },
      { id: "a3", role: "assistant", text: "最终回复" },
      { id: "a4", role: "assistant", text: "流式残片", partial: true },
    ],
  }));
  assert.equal(input?.request, "修一下登录超时 顺便补测试");
  assert.equal(input?.reply, "最终回复");
  assert.equal(input?.providerId, "prov1");
  assert.equal(input?.model, "model-x");
  assert.equal(input?.cwd, "/tmp/project");
});

test("标题材料：只发图片也能总结（请求为空）", () => {
  const input = titleInput(session({
    messages: [
      { id: "u1", role: "user", text: "" },
      { id: "a1", role: "assistant", text: "这张截图显示登录页报错。" },
    ],
  }));
  assert.equal(input?.request, "");
  assert.equal(input?.reply, "这张截图显示登录页报错。");
});

test("标题材料：完全没有正文时返回 undefined", () => {
  assert.equal(titleInput(session()), undefined);
});

test("标题请求正文带上请求和回复；缺请求时说明是图片", () => {
  const prompt = titlePrompt({ request: "修复登录超时", reply: "已修复。" });
  assert.match(prompt, /用户请求：\n修复登录超时/);
  assert.match(prompt, /助手本轮最后的回复：\n已修复。/);
  assert.match(titlePrompt({ request: "", reply: "截图说明" }), /用户只发送了图片/);
  assert.match(titlePrompt({ request: "请求", reply: "" }), /没有文字回复/);
});
