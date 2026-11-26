import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Transcript } from "./api";
import { safeFileName, sessionToMarkdown } from "./session-export";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    projectId: "demo",
    title: "示例对话",
    providerId: "provider-1",
    providerName: "测试供应商",
    model: "model-x",
    effort: "high",
    phase: "completed",
    summary: "",
    git: true,
    branch: "main",
    cwd: "/tmp/demo",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: new Date(2026, 0, 2, 3, 4, 5).toISOString(),
    updatedAt: new Date(2026, 0, 2, 4, 5, 6).toISOString(),
    messages: [],
    ...overrides,
  };
}

function message(role: Transcript["role"], text: string, extra: Partial<Transcript> = {}): Transcript {
  return { id: `m-${role}-${text.length}`, role, text, ...extra };
}

test("导出包含标题、元信息和三种角色正文", () => {
  const markdown = sessionToMarkdown(makeSession({
    messages: [
      message("user", "看看这个 bug"),
      message("assistant", "我找到了原因"),
      message("tool", "文件内容", { toolName: "Read" }),
    ],
  }));

  assert.match(markdown, /^# 示例对话/);
  assert.match(markdown, /- 项目：`demo`/);
  assert.match(markdown, /- 分支：`main`/);
  assert.match(markdown, /- 模型：测试供应商 \/ model-x/);
  assert.match(markdown, /- 推理强度：high/);
  assert.match(markdown, /- 状态：本轮完成/);

  assert.match(markdown, /## 用户/);
  assert.match(markdown, /看看这个 bug/);
  assert.match(markdown, /## 助手/);
  assert.match(markdown, /我找到了原因/);
  assert.match(markdown, /## 工具 `Read`/);
  assert.match(markdown, /文件内容/);
});

test("thinking 用 details 包裹，不另起助手标题", () => {
  const markdown = sessionToMarkdown(makeSession({
    messages: [
      message("assistant", "先分析一下调用链", { kind: "thinking" }),
      message("assistant", "结论是缓存失效"),
    ],
  }));

  assert.match(markdown, /<details>/);
  assert.match(markdown, /<summary>思考过程/);
  assert.match(markdown, /先分析一下调用链/);
  assert.match(markdown, /<\/details>/);
  assert.equal((markdown.match(/## 助手/g) ?? []).length, 1);
});

test("图片输出为 /api/sessions/<id>/images/<imageId> 的 Markdown 链接", () => {
  const markdown = sessionToMarkdown(makeSession({
    messages: [
      message("user", "看这张图", {
        images: [{ id: "img-1", mediaType: "image/png", name: "截图" }],
      }),
    ],
  }));

  assert.match(markdown, /!\[截图\]\(\/api\/sessions\/11111111-1111-1111-1111-111111111111\/images\/img-1\)/);
});

test("空消息列表输出明确的空状态", () => {
  const markdown = sessionToMarkdown(makeSession({ messages: [] }));
  assert.match(markdown, /这个对话还没有消息/);

  const missing = sessionToMarkdown(makeSession({ messages: undefined }));
  assert.match(missing, /这个对话还没有消息/);
});

test("工具缺少名称和正文时仍然可读", () => {
  const markdown = sessionToMarkdown(makeSession({
    messages: [message("tool", "", {})],
  }));
  assert.match(markdown, /## 工具/);
  assert.match(markdown, /（无输出）/);
});

test("下载文件名清洗非法字符并以标题为基础", () => {
  assert.equal(safeFileName("a/b:c*d?e\"f<g>h|i"), "a b c d e f g h i");
  assert.equal(safeFileName("   .hidden  "), "hidden");
  assert.equal(safeFileName(""), "对话");
  assert.equal(safeFileName("长".repeat(120)).length, 80);
});
