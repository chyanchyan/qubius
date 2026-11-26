import assert from "node:assert/strict";
import test from "node:test";
import { buildEditDiff, isEditTool, mergeChanges, type EditDiff } from "./edit-diff";

const CWD = "/repo";

function json(value: unknown): string {
  return JSON.stringify(value);
}

test("isEditTool 只认 Edit / Write / MultiEdit", () => {
  assert.equal(isEditTool("Edit"), true);
  assert.equal(isEditTool("Write"), true);
  assert.equal(isEditTool("MultiEdit"), true);
  assert.equal(isEditTool("Read"), false);
});

test("Edit：计算新增/删除行，并把绝对路径换成相对路径", () => {
  const diff = buildEditDiff(
    "Edit",
    json({
      file_path: "/repo/keyring.py",
      old_string: "a\nb\nc",
      new_string: "a\nB\nc\nd",
    }),
    CWD,
  );
  assert.ok(diff);
  assert.equal(diff.path, "keyring.py");
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.truncated, false);
  assert.deepEqual(
    diff.lines.filter((line) => line.kind !== "context").map((line) => [line.kind, line.text]),
    [["del", "b"], ["add", "B"], ["add", "d"]],
  );
});

test("Edit：未改动的内容压缩成 hunk 行", () => {
  const oldText = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const newText = oldText.replace("line 10", "changed 10");
  const diff = buildEditDiff(
    "Edit",
    json({ file_path: "/repo/a.ts", old_string: oldText, new_string: newText }),
    CWD,
  );
  assert.ok(diff);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.ok(diff.lines.some((line) => line.kind === "hunk" && line.text.includes("行未改动")));
  // 变更前只保留 2 行上下文，中间折叠。
  const firstHunk = diff.lines.findIndex((line) => line.kind === "hunk");
  assert.equal(
    diff.lines.slice(0, firstHunk).filter((line) => line.kind === "context").length,
    2,
  );
});

test("Write：整段内容按新增行展示", () => {
  const diff = buildEditDiff(
    "Write",
    json({ file_path: "/repo/new.ts", content: "one\ntwo\n" }),
    CWD,
  );
  assert.ok(diff);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  assert.deepEqual(diff.lines.map((line) => line.text), ["one", "two"]);
});

test("MultiEdit：每处编辑之间插入分隔行", () => {
  const diff = buildEditDiff(
    "MultiEdit",
    json({
      file_path: "/repo/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    }),
    CWD,
  );
  assert.ok(diff);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  assert.ok(diff.lines.some((line) => line.kind === "hunk" && line.text === "第 2 处编辑"));
});

test("输入不是合法 JSON（例如被截断）时返回 null", () => {
  assert.equal(buildEditDiff("Edit", '{"file_path":"/repo/a.ts"', CWD), null);
  assert.equal(buildEditDiff("Edit", json({ file_path: "/repo/a.ts" }), CWD), null);
  assert.equal(buildEditDiff("Read", json({ file_path: "/repo/a.ts" }), CWD), null);
});

function diff(path: string, added: number, removed: number, lines: EditDiff["lines"]): EditDiff {
  return { path, added, removed, lines, truncated: false };
}

test("mergeChanges：不同文件按首次出现顺序各成一块", () => {
  const files = mergeChanges([
    diff("a.ts", 1, 0, [{ kind: "add", text: "a" }]),
    diff("b.ts", 2, 1, [{ kind: "add", text: "b" }, { kind: "del", text: "c" }]),
  ]);
  assert.deepEqual(files.map((file) => [file.path, file.added, file.removed, file.edits]), [
    ["a.ts", 1, 0, 1],
    ["b.ts", 2, 1, 1],
  ]);
  assert.deepEqual(files[0].lines, [{ kind: "add", text: "a" }]);
});

test("mergeChanges：同一文件多次编辑合并，补分隔行并累加行数", () => {
  const files = mergeChanges([
    diff("a.ts", 1, 0, [{ kind: "add", text: "first" }]),
    diff("a.ts", 2, 1, [{ kind: "del", text: "old" }, { kind: "add", text: "new" }]),
    diff("a.ts", 0, 1, [{ kind: "del", text: "gone" }]),
  ]);
  assert.equal(files.length, 1);
  const [file] = files;
  assert.equal(file.added, 3);
  assert.equal(file.removed, 2);
  assert.equal(file.edits, 3);
  assert.deepEqual(
    file.lines.filter((line) => line.kind === "hunk").map((line) => line.text),
    ["第 2 处编辑", "第 3 处编辑"],
  );
  assert.deepEqual(
    file.lines.filter((line) => line.kind !== "hunk").map((line) => line.text),
    ["first", "old", "new", "gone"],
  );
});

test("mergeChanges：路径解析不出来的改动不互相合并", () => {
  const files = mergeChanges([
    diff("", 1, 0, [{ kind: "add", text: "x" }]),
    diff("", 1, 0, [{ kind: "add", text: "y" }]),
  ]);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.edits), [1, 1]);
});

test("mergeChanges：截断状态沿用到合并后的文件", () => {
  const clipped: EditDiff = { ...diff("a.ts", 1, 0, [{ kind: "add", text: "a" }]), truncated: true };
  const files = mergeChanges([diff("a.ts", 1, 0, [{ kind: "add", text: "b" }]), clipped]);
  assert.equal(files.length, 1);
  assert.equal(files[0].truncated, true);
});
