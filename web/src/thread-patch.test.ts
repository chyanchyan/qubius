import assert from "node:assert/strict";
import test from "node:test";
import {
  diffFileName,
  groupChangeSummary,
  patchStats,
  splitPatch,
} from "./components/Thread";
import type { Transcript } from "./api";
import type { ActivityGroup } from "./transcript-groups";

function lines(...items: string[]): string {
  return items.join("\n");
}

test("多文件补丁按 diff --git 分组并统计各文件行数", () => {
  const files = splitPatch(lines(
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " context",
    "diff --git a/dir/b.ts b/dir/b.ts",
    "--- a/dir/b.ts",
    "+++ b/dir/b.ts",
    "@@ -1 +1,2 @@",
    " same",
    "+added1",
    "+added2",
  ));

  assert.equal(files.length, 2);
  assert.equal(files[0].name, "a.ts");
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.equal(files[1].name, "dir/b.ts");
  assert.equal(files[1].added, 2);
  assert.equal(files[1].removed, 0);

  const first = files[0].lines;
  const kindOf = (text: string) => first.find((line) => line.text === text)?.kind;
  assert.equal(kindOf("--- a/a.ts"), "");
  assert.equal(kindOf("+++ b/a.ts"), "");
  assert.equal(kindOf("-old"), "del");
  assert.equal(kindOf("+new"), "add");
  assert.equal(kindOf(" context"), "");
});

test("没有 diff --git 的补丁整段作为一条，文件头不计数", () => {
  const files = splitPatch(lines(
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ));

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "");
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.deepEqual(files[0].lines.map((line) => line.kind), ["", "", "", "del", "add"]);
});

test("hunk 内容行以 +++/--- 开头时仍按新增/删除处理", () => {
  const files = splitPatch(lines(
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1 +1 @@",
    "----",
    "++++",
  ));

  assert.equal(files.length, 1);
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.deepEqual(
    files[0].lines.map((line) => [line.text, line.kind]),
    [
      ["diff --git a/f.txt b/f.txt", ""],
      ["--- a/f.txt", ""],
      ["+++ b/f.txt", ""],
      ["@@ -1 +1 @@", ""],
      ["----", "del"],
      ["++++", "add"],
    ],
  );
});

test("多个 hunk 继续累计，且只统计 @@ 之后的行", () => {
  const files = splitPatch(lines(
    "diff --git a/multi.txt b/multi.txt",
    "--- a/multi.txt",
    "+++ b/multi.txt",
    "@@ -1 +1 @@",
    "-one",
    "+ONE",
    "@@ -10 +10 @@",
    "-two",
    "+TWO",
  ));

  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 2);
  assert.deepEqual(
    files[0].lines.filter((line) => line.kind).map((line) => line.text),
    ["-one", "+ONE", "-two", "+TWO"],
  );
});

test("diffFileName 支持普通、重命名和带空格的引号路径", () => {
  assert.equal(diffFileName("diff --git a/old.txt b/new.txt"), "new.txt");
  assert.equal(diffFileName('diff --git "a/old name.txt" "b/new name.txt"'), "new name.txt");
  assert.equal(diffFileName('diff --git "a/dir with space/f.txt" "b/dir with space/f.txt"'), "dir with space/f.txt");
});

test("diffFileName 无 b/ 前缀时退回整段剩余内容", () => {
  assert.equal(diffFileName("diff --git weird"), "weird");
});

test("服务端的已暂存/未暂存段标签不会生成空分组或挂到上一个文件", () => {
  const files = splitPatch(lines(
    "已暂存",
    "diff --git a/staged.ts b/staged.ts",
    "--- a/staged.ts",
    "+++ b/staged.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "未暂存",
    "diff --git a/working.ts b/working.ts",
    "--- a/working.ts",
    "+++ b/working.ts",
    "@@ -1 +1 @@",
    "+more",
  ));

  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.name), ["staged.ts", "working.ts"]);
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.equal(files[1].added, 1);
  const texts = files.flatMap((file) => file.lines.map((line) => line.text));
  assert.ok(!texts.includes("已暂存"));
  assert.ok(!texts.includes("未暂存"));
});

test("二进制分隔（无 hunk）不计新增/删除行", () => {
  const files = splitPatch(lines(
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
  ));

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "logo.png");
  assert.equal(files[0].added, 0);
  assert.equal(files[0].removed, 0);
});

test("patchStats：按文件累计 hunk 内的增删行数", () => {
  const stats = patchStats(lines(
    "已暂存",
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " context",
    "未暂存",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1,3 @@",
    " same",
    "+one",
    "+two",
  ));

  assert.deepEqual(stats, { files: 2, added: 3, removed: 1 });
});

test("patchStats：没有 diff --git 的单文件补丁在首个 hunk 处计一个文件", () => {
  const stats = patchStats(lines(
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ));

  assert.deepEqual(stats, { files: 1, added: 1, removed: 1 });
});

test("patchStats：二进制或读取失败文本没有增删行", () => {
  assert.deepEqual(
    patchStats(lines("diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ")),
    { files: 1, added: 0, removed: 0 },
  );
  assert.deepEqual(patchStats("这个目录不是 git 仓库，没有 diff。"), { files: 0, added: 0, removed: 0 });
});

test("groupChangeSummary 合并同组编辑并按文件统计", () => {
  const edit = (id: string, file: string, oldText: string, newText: string): Transcript => ({
    id,
    role: "tool",
    toolName: "Edit",
    text: JSON.stringify({ file_path: file, old_string: oldText, new_string: newText }),
  });
  const group: ActivityGroup = {
    kind: "activity",
    key: "g",
    items: [
      edit("1", "/repo/a.ts", "one\ntwo", "one\nTWO"),
      edit("2", "/repo/a.ts", "three", "three\nfour"),
      edit("3", "/repo/b.ts", "x", "y"),
    ],
    toolCount: 3,
    thinkingCount: 0,
    failed: false,
    active: false,
  };

  assert.deepEqual(groupChangeSummary(group, "/repo"), { files: 2, added: 3, removed: 2 });

  const noEdits: ActivityGroup = {
    ...group,
    items: [{ id: "4", role: "tool", toolName: "Bash", text: JSON.stringify({ command: "ls" }) }],
    toolCount: 1,
  };
  assert.equal(groupChangeSummary(noEdits, "/repo"), null);
});
