import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolDuration,
  summarizeTool,
  toolInputRecord,
} from "./tool-summary";

const CWD = "/repo";

function json(value: unknown): string {
  return JSON.stringify(value);
}

test("Bash：多行命令折叠成一行并压缩空白", () => {
  const input = json({ command: "grep -rn\t\"foo\"\n  src\n" });
  assert.equal(summarizeTool("Bash", input), `grep -rn "foo" src`);
});

test("Read：file_path，以及 offset/limit 行段", () => {
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repo/web/src/a.ts" }), CWD),
    "web/src/a.ts",
  );
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repo/web/src/a.ts", offset: 10, limit: 5 }), CWD),
    "web/src/a.ts:10-14",
  );
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repo/a.ts", offset: 3 }), CWD),
    "a.ts:3+",
  );
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repo/a.ts", limit: 20 }), CWD),
    "a.ts ×20",
  );
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repo/a.ts", offset: 0, limit: 0 }), CWD),
    "a.ts:0+",
  );
});

test("Edit / Write：file_path", () => {
  assert.equal(
    summarizeTool("Edit", json({ file_path: "/repo/web/src/a.ts", old_string: "x" }), CWD),
    "web/src/a.ts",
  );
  assert.equal(
    summarizeTool("Write", json({ file_path: "/repo/web/src/b.ts", content: "x" }), CWD),
    "web/src/b.ts",
  );
});

test("MultiEdit：file_path 加编辑条数", () => {
  assert.equal(
    summarizeTool("MultiEdit", json({ file_path: "/repo/a.ts", edits: [{}, {}, {}] }), CWD),
    "a.ts · 3 处",
  );
  assert.equal(
    summarizeTool("MultiEdit", json({ file_path: "/repo/a.ts" }), CWD),
    "a.ts",
  );
});

test("NotebookEdit：notebook_path", () => {
  assert.equal(
    summarizeTool("NotebookEdit", json({ notebook_path: "/repo/nb/t.ipynb", cell_id: "1" }), CWD),
    "nb/t.ipynb",
  );
});

test("Grep：pattern 于位置；有 glob 时用 glob", () => {
  assert.equal(
    summarizeTool("Grep", json({ pattern: "foo", path: "/repo/web/src" }), CWD),
    "foo 于 web/src",
  );
  assert.equal(
    summarizeTool("Grep", json({ pattern: "foo" }), CWD),
    "foo",
  );
  assert.equal(
    summarizeTool("Grep", json({ pattern: "foo", path: "/repo/web", glob: "*.ts" }), CWD),
    "foo 于 *.ts",
  );
});

test("Glob：pattern 于 path", () => {
  assert.equal(
    summarizeTool("Glob", json({ pattern: "**/*.ts", path: "/repo/web" }), CWD),
    "**/*.ts 于 web",
  );
  assert.equal(summarizeTool("Glob", json({ pattern: "**/*.ts" }), CWD), "**/*.ts");
});

test("WebFetch / WebSearch：url / query", () => {
  assert.equal(
    summarizeTool("WebFetch", json({ url: "https://example.com/a", prompt: "总结" })),
    "https://example.com/a",
  );
  assert.equal(
    summarizeTool("WebSearch", json({ query: "node test runner" })),
    "node test runner",
  );
});

test("Task / Agent：description，缺省回退 prompt", () => {
  assert.equal(
    summarizeTool("Task", json({ description: "检查测试", prompt: "很长的说明" })),
    "检查测试",
  );
  assert.equal(
    summarizeTool("Agent", json({ prompt: "实现功能" })),
    "实现功能",
  );
});

test("TodoWrite：N 项待办，最多附一个进行中项（content 截到 30 字）", () => {
  assert.equal(
    summarizeTool(
      "TodoWrite",
      json({ todos: [{ content: "a", status: "pending" }, { content: "b", status: "completed" }] }),
    ),
    "2 项待办",
  );
  assert.equal(
    summarizeTool(
      "TodoWrite",
      json({
        todos: [
          { content: "写测试", status: "in_progress" },
          { content: "写实现", status: "pending" },
        ],
      }),
    ),
    "2 项待办 · 写测试",
  );
  const longContent = "a".repeat(40);
  assert.equal(
    summarizeTool("TodoWrite", json({ todos: [{ content: longContent, status: "in_progress" }] })),
    `1 项待办 · ${"a".repeat(30)}…`,
  );
  assert.equal(
    summarizeTool(
      "TodoWrite",
      json({
        todos: [
          { content: "one", status: "in_progress" },
          { content: "two", status: "in_progress" },
        ],
      }),
    ),
    "2 项待办",
  );
});

test("AskUserQuestion：header，缺省回退 question", () => {
  assert.equal(
    summarizeTool(
      "AskUserQuestion",
      json({ questions: [{ header: "选择方案", question: "选哪个？" }] }),
    ),
    "选择方案",
  );
  assert.equal(
    summarizeTool(
      "AskUserQuestion",
      json({ questions: [{ header: "", question: "选哪个？" }] }),
    ),
    "选哪个？",
  );
});

test("BashOutput / KillShell：shell_id", () => {
  assert.equal(summarizeTool("BashOutput", json({ shell_id: "shell-1" })), "shell-1");
  assert.equal(summarizeTool("KillShell", json({ shell_id: "shell-2" })), "shell-2");
});

test("ExitPlanMode：固定文案", () => {
  assert.equal(summarizeTool("ExitPlanMode", "{}"), "提交计划");
});

test("未知工具：按 command/file_path/path/... 顺序取首个非空字符串", () => {
  assert.equal(
    summarizeTool("Mystery", json({ path: "/repo/web/x", pattern: "p" }), CWD),
    "web/x",
  );
  assert.equal(
    summarizeTool("Mystery", json({ description: "d", prompt: "p" })),
    "d",
  );
  assert.equal(
    summarizeTool("Mystery", json({ subagent_type: "Explore" })),
    "Explore",
  );
});

test("cwd 相对化：仅去掉 cwd + / 前缀，其他绝对路径保持原样", () => {
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repo/a/b.ts" }), "/repo/"),
    "a/b.ts",
  );
  assert.equal(
    summarizeTool("Read", json({ file_path: "/elsewhere/a.ts" }), CWD),
    "/elsewhere/a.ts",
  );
  assert.equal(
    summarizeTool("Read", json({ file_path: "/repository/a.ts" }), CWD),
    "/repository/a.ts",
  );
});

test("摘要不超过 80 字符，超出加省略号", () => {
  const result = summarizeTool("Bash", json({ command: "a".repeat(120) }), CWD);
  assert.equal(Array.from(result).length, 80);
  assert.equal(result, `${"a".repeat(79)}…`);
});

test("坏 JSON：正则提取第一个关键字段并处理转义", () => {
  assert.equal(
    summarizeTool("Bash", '{"command":"echo \\"hi\\"","descr'),
    'echo "hi"',
  );
  assert.equal(
    summarizeTool("Read", '{"file_path":"/repo/a\\\\b.ts"', CWD),
    "a\\b.ts",
  );
  assert.equal(
    summarizeTool("Task", '{"description":"检查\\n测试"'),
    "检查 测试",
  );
});

test("坏 JSON 且无关键字段：回退首个非空行并截断", () => {
  assert.equal(summarizeTool("Bash", "\n  not json here  \nsecond line"), "not json here");
  const longLine = summarizeTool("Bash", "x".repeat(100));
  assert.equal(Array.from(longLine).length, 80);
  assert.ok(longLine.endsWith("…"));
});

test("空输入返回空串", () => {
  assert.equal(summarizeTool("Bash", ""), "");
  assert.equal(summarizeTool("Read", "   \n\t "), "");
});

test("toolInputRecord：只接受合法 JSON 对象", () => {
  assert.deepEqual(toolInputRecord('{"a":1}'), { a: 1 });
  assert.deepEqual(toolInputRecord("  {}  "), {});
  assert.equal(toolInputRecord("[1,2]"), null);
  assert.equal(toolInputRecord("null"), null);
  assert.equal(toolInputRecord('{"a":'), null);
  assert.equal(toolInputRecord("plain text"), null);
});

test("formatToolDuration：四档", () => {
  assert.equal(formatToolDuration(undefined), "");
  assert.equal(formatToolDuration(-1), "");
  assert.equal(formatToolDuration(Number.NaN), "");
  assert.equal(formatToolDuration(250), "250ms");
  assert.equal(formatToolDuration(999), "999ms");
  assert.equal(formatToolDuration(1200), "1.2s");
  assert.equal(formatToolDuration(65_000), "1分5秒");
  assert.equal(formatToolDuration(60_000), "1分0秒");
});
