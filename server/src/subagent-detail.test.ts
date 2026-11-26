import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSubagentTranscript, readSubagentTranscript } from "./subagent-detail.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

function assistant(...content: unknown[]): string {
  return line({ type: "assistant", message: { role: "assistant", content } });
}

function user(content: unknown): string {
  return line({ type: "user", message: { role: "user", content } });
}

test("解析提示、思考、正文和工具调用，并把结果回填到工具条目", () => {
  const raw = [
    user("先看一下入口"),
    assistant({ type: "thinking", thinking: "需要读文件" }),
    assistant({ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } }),
    user([{ type: "tool_result", tool_use_id: "tool-1", content: "文件内容" }]),
    assistant({ type: "text", text: "看完了" }),
  ].join("\n");

  const detail = parseSubagentTranscript(raw);
  assert.equal(detail.truncated, false);
  assert.deepEqual(
    detail.entries.map((item) => item.kind),
    ["prompt", "thinking", "tool", "text"],
  );
  assert.equal(detail.entries[0]?.text, "先看一下入口");
  assert.equal(detail.entries[1]?.text, "需要读文件");
  assert.equal(detail.entries[2]?.toolName, "Read");
  assert.equal(detail.entries[2]?.text, JSON.stringify({ file_path: "a.ts" }));
  assert.equal(detail.entries[2]?.result, "文件内容");
  assert.equal(detail.entries[2]?.toolStatus, "ok");
  assert.equal(detail.entries[3]?.text, "看完了");
});

test("工具结果按内容块拼接，错误状态和图片占位都可识别", () => {
  const raw = [
    assistant({ type: "tool_use", id: "t", name: "Bash", input: {} }),
    user([{
      type: "tool_result",
      tool_use_id: "t",
      is_error: true,
      content: [{ type: "text", text: "第一段" }, { type: "image" }, { type: "text", text: "第二段" }],
    }]),
  ].join("\n\n");
  const detail = parseSubagentTranscript(raw);
  const tool = detail.entries[0];
  assert.equal(tool?.result, "第一段\n[图片]\n第二段");
  assert.equal(tool?.toolStatus, "error");
});

test("跳过坏行和找不到调用的孤立结果", () => {
  const raw = [
    "{ 不是合法 JSON",
    user([{ type: "tool_result", tool_use_id: "missing", content: "孤立结果" }]),
    "",
    assistant({ type: "text", text: "仍然可解析" }),
  ].join("\n");
  const detail = parseSubagentTranscript(raw);
  assert.deepEqual(detail.entries.map((item) => item.kind), ["text"]);
});

test("正文超过上限时截断并标记", () => {
  const detail = parseSubagentTranscript(
    assistant({ type: "text", text: "x".repeat(30) }),
    { maxText: 10 },
  );
  assert.equal(detail.truncated, true);
  assert.match(detail.entries[0]?.text ?? "", /^x{10}\n…（已截断）$/);
});

test("条目过多时保留开头提示和最近的 maxEntries 条", () => {
  const raw = [
    user("原始任务"),
    ...Array.from({ length: 5 }, (_, index) =>
      assistant({ type: "text", text: `第 ${index} 条` })),
  ].join("\n");
  const detail = parseSubagentTranscript(raw, { maxEntries: 3 });
  assert.equal(detail.truncated, true);
  assert.equal(detail.entries[0]?.kind, "prompt");
  assert.equal(detail.entries[0]?.text, "原始任务");
  assert.deepEqual(detail.entries.slice(1).map((item) => item.text), ["第 3 条", "第 4 条"]);
});

test("没有提示时条目过多只保留最近的部分", () => {
  const raw = Array.from({ length: 5 }, (_, index) =>
    assistant({ type: "text", text: `第 ${index} 条` })).join("\n");
  const detail = parseSubagentTranscript(raw, { maxEntries: 2 });
  assert.equal(detail.truncated, true);
  assert.deepEqual(detail.entries.map((item) => item.text), ["第 3 条", "第 4 条"]);
});

test("从目录里读取 sidechain transcript；找不到或路径不合法时返回 undefined", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-subagent-detail-"));
  const id = randomUUID();
  const taskId = "abc123";
  const dir = path.join(base, "projects", "-tmp-project", id, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${taskId}.jsonl`);
  fs.writeFileSync(file, [user("任务"), assistant({ type: "text", text: "完成" })].join("\n"));
  try {
    const detail = await readSubagentTranscript(id, taskId, base);
    assert.equal(detail?.entries.length, 2);
    assert.equal(detail?.entries[1]?.text, "完成");
    assert.equal(await readSubagentTranscript(id, "missing", base), undefined);
    // 目录穿越和非法 id 都不应落到文件系统。
    assert.equal(await readSubagentTranscript(id, "../secret", base), undefined);
    assert.equal(await readSubagentTranscript("../" + id, taskId, base), undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
