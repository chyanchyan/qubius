import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewPrompt,
  commentAnchor,
  lineSides,
  lineSnippet,
  parseReviewDiff,
  type ReviewFile,
} from "./diff-review";
import type { DiffComment, DiffCommentSide } from "./api-diff-comments";

function lines(...items: string[]): string {
  return items.join("\n");
}

function comment(
  id: string,
  file: string,
  side: DiffCommentSide,
  line: number,
  text: string,
  resolved = false,
): DiffComment {
  return {
    id,
    file,
    side,
    line,
    text,
    resolved,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function findLine(files: ReviewFile[], fileIndex: number, content: string) {
  const found = files[fileIndex].lines.find((line) => line.content === content);
  assert.ok(found, `没有找到内容为 ${content} 的行`);
  return found;
}

test("hunk 内 + / - / context 分别计算 new 与 old 行号", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    " old",
    "-gone",
    "+new1",
    "+new2",
  ));

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "x.ts");
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);

  const context = findLine(files, 0, "old");
  assert.equal(context.kind, "context");
  assert.equal(context.oldLine, 1);
  assert.equal(context.newLine, 1);

  const del = findLine(files, 0, "gone");
  assert.equal(del.kind, "del");
  assert.equal(del.oldLine, 2);
  assert.equal(del.newLine, undefined);

  const add1 = findLine(files, 0, "new1");
  assert.equal(add1.kind, "add");
  assert.equal(add1.newLine, 2);
  assert.equal(add1.oldLine, undefined);

  const add2 = findLine(files, 0, "new2");
  assert.equal(add2.newLine, 3);
});

test("多个 hunk 各自按 @@ 起点重置行号", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,2 +10,2 @@",
    " a",
    "-b",
    "+B",
    "@@ -30,1 +30,2 @@",
    " c",
    "+d",
  ));

  const a = findLine(files, 0, "a");
  assert.deepEqual([a.oldLine, a.newLine], [10, 10]);
  const b = findLine(files, 0, "b");
  assert.deepEqual([b.oldLine, b.newLine], [11, undefined]);
  const bigB = findLine(files, 0, "B");
  assert.deepEqual([bigB.oldLine, bigB.newLine], [undefined, 11]);
  const c = findLine(files, 0, "c");
  assert.deepEqual([c.oldLine, c.newLine], [30, 30]);
  const d = findLine(files, 0, "d");
  assert.deepEqual([d.oldLine, d.newLine], [undefined, 31]);
});

test("已暂存 / 未暂存 分段归属到文件，标签本身不进入行列表", () => {
  const files = parseReviewDiff(lines(
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
  assert.equal(files[0].section, "已暂存");
  assert.equal(files[1].section, "未暂存");
  assert.deepEqual(files.map((file) => file.name), ["staged.ts", "working.ts"]);
  const texts = files.flatMap((file) => file.lines.map((line) => line.text));
  assert.ok(!texts.includes("已暂存"));
  assert.ok(!texts.includes("未暂存"));
});

test("服务端用 \\n\\n 拼接分段时，分隔空行不产生幻影 context 行", () => {
  /* server/src/worktree.ts 的真实格式：已暂存 + "\n\n" + 未暂存，两段之间
     多出一个空行，而 staged 段的最后一个 hunk 已经读完。 */
  const staged = lines(
    "diff --git a/staged.ts b/staged.ts",
    "--- a/staged.ts",
    "+++ b/staged.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  );
  const unstaged = lines(
    "diff --git a/working.ts b/working.ts",
    "--- a/working.ts",
    "+++ b/working.ts",
    "@@ -1 +1 @@",
    "+more",
  );
  const files = parseReviewDiff(`已暂存\n${staged}\n\n未暂存\n${unstaged}`);

  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.name), ["staged.ts", "working.ts"]);
  for (const file of files) {
    assert.ok(
      file.lines.every((line) => line.kind !== "context"),
      "分段空行不应变成 context",
    );
    assert.ok(
      file.lines.every((line) => line.text !== ""),
      "分段空行不应生成任何行",
    );
  }

  const stagedAdd = findLine(files, 0, "new");
  assert.deepEqual([stagedAdd.oldLine, stagedAdd.newLine], [undefined, 1]);
  const unstagedAdd = findLine(files, 1, "more");
  assert.deepEqual([unstagedAdd.oldLine, unstagedAdd.newLine], [undefined, 1]);
  assert.deepEqual([files[0].added, files[0].removed], [1, 1]);
  assert.deepEqual([files[1].added, files[1].removed], [1, 0]);
});

test("hunk 行数配额内、被裁掉前导空格的空行仍按 context 处理", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    " line1",
    "",
    "+added",
  ));

  const context = findLine(files, 0, "line1");
  assert.deepEqual([context.oldLine, context.newLine], [1, 1]);
  const empty = files[0].lines.filter((line) => line.kind === "context")[1];
  assert.ok(empty, "hunk 配额内的空行应保留为 context");
  assert.deepEqual([empty.oldLine, empty.newLine], [2, 2]);
  const add = findLine(files, 0, "added");
  assert.deepEqual([add.oldLine, add.newLine], [undefined, 3]);
});

test("side：新增行仅 new，删除行仅 old，上下文行两侧都有", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    " same",
    "-old",
    "+new",
  ));

  const context = findLine(files, 0, "same");
  assert.deepEqual(lineSides(context), ["old", "new"]);
  assert.deepEqual(commentAnchor(context), { side: "new", line: 1 });

  const del = findLine(files, 0, "old");
  assert.deepEqual(lineSides(del), ["old"]);
  assert.deepEqual(commentAnchor(del), { side: "old", line: 2 });

  const add = findLine(files, 0, "new");
  assert.deepEqual(lineSides(add), ["new"]);
  assert.deepEqual(commentAnchor(add), { side: "new", line: 2 });
});

test("\\ No newline at end of file 作为提示行，不影响行号与计数", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.txt b/x.txt",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
  ));

  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  const note = files[0].lines[files[0].lines.length - 1];
  assert.equal(note.kind, "nonewline");
  assert.equal(note.oldLine, undefined);
  assert.equal(note.newLine, undefined);
  const add = findLine(files, 0, "new");
  assert.equal(add.newLine, 1);
});

test("没有 diff --git 时从 ---/+++ 头推导文件名", () => {
  const files = parseReviewDiff(lines(
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ));

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "x.txt");
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
});

test("buildReviewPrompt 过滤已解决评论，并按文件顺序、行号排序", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const old = 1;",
    "+const value = 1;",
    " context line",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5,1 +5,1 @@",
    "-old b",
    "+new b",
  ));

  const prompt = buildReviewPrompt([
    comment("c1", "b.ts", "new", 5, "B 意见"),
    comment("c2", "a.ts", "new", 2, "上下文意见"),
    comment("c3", "a.ts", "new", 1, "A 意见"),
    comment("c4", "a.ts", "new", 1, "这条已解决", true),
  ], files);

  assert.ok(prompt.startsWith("请根据以下 diff 行级评论修改代码："));
  assert.ok(prompt.includes("文件：a.ts"));
  assert.ok(prompt.includes("位置：新行 1"));
  assert.ok(prompt.includes("代码：const value = 1;"));
  assert.ok(prompt.includes("意见：A 意见"));
  assert.ok(prompt.includes("位置：新行 2"));
  assert.ok(prompt.includes("代码：context line"));
  assert.ok(prompt.includes("文件：b.ts"));
  assert.ok(!prompt.includes("这条已解决"));

  const order = [
    prompt.indexOf("意见：A 意见"),
    prompt.indexOf("意见：上下文意见"),
    prompt.indexOf("意见：B 意见"),
  ];
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("代码片段按 maxSnippet 截断且不超过上限", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/long.ts b/long.ts",
    "--- a/long.ts",
    "+++ b/long.ts",
    "@@ -1 +1 @@",
    `+${"x".repeat(250)}`,
  ));

  assert.equal(lineSnippet(files, "long.ts", "new", 1, 10), `${"x".repeat(9)}…`);
  const prompt = buildReviewPrompt(
    [comment("c1", "long.ts", "new", 1, "太长")],
    files,
    { maxSnippet: 10 },
  );
  assert.ok(prompt.includes(`代码：${"x".repeat(9)}…`));
  assert.ok(!prompt.includes("x".repeat(250)));
});

test("没有未解决评论时 prompt 是空串", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1 @@",
    "+new",
  ));
  assert.equal(buildReviewPrompt([], files), "");
  assert.equal(
    buildReviewPrompt([comment("c1", "x.ts", "new", 1, "已解决", true)], files),
    "",
  );
});

test("文件不在本次 diff 中时仍生成条目，只是没有代码片段", () => {
  const files = parseReviewDiff(lines(
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1 @@",
    "+new",
  ));
  const prompt = buildReviewPrompt([comment("c1", "gone.ts", "old", 7, "找不到")], files);
  assert.ok(prompt.includes("文件：gone.ts"));
  assert.ok(prompt.includes("位置：旧行 7"));
  assert.ok(!prompt.includes("\n代码："));
  assert.ok(prompt.includes("意见：找不到"));
});
