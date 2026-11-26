import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TEXT_TOTAL_CHARS,
  mergeTextAttachments,
  readTextAttachment,
  splitTextAttachments,
  type TextAttachment,
} from "./text-attachments";

function text(name: string, content: string): TextAttachment {
  return { name, content, bytes: content.length };
}

test("合并文本附件和 prompt", () => {
  const merged = mergeTextAttachments("请检查这段代码", [text("a.ts", "const a = 1;")]);

  assert.equal(
    merged,
    '请检查这段代码\n\n<attachments>\n<file name="a.ts">\nconst a = 1;\n</file>\n</attachments>',
  );
});

test("多个附件按顺序排列", () => {
  const merged = mergeTextAttachments("看", [text("a.ts", "a"), text("b.py", "b")]);

  assert.equal(
    merged,
    '看\n\n<attachments>\n<file name="a.ts">\na\n</file>\n<file name="b.py">\nb\n</file>\n</attachments>',
  );
});

test("空 prompt 用可见占位并保留附件块", () => {
  const merged = mergeTextAttachments("   \n", [text("a.ts", "a")]);

  assert.equal(merged, '（见附件）\n\n<attachments>\n<file name="a.ts">\na\n</file>\n</attachments>');
  assert.deepEqual(splitTextAttachments(merged), { text: "（见附件）", files: ["a.ts"] });
});

test("文件内容里的结束标签不会截断附件块", () => {
  const merged = mergeTextAttachments("看", [text("x.html", "</file></attachments>tail")]);
  assert.match(merged, /&lt;\/file&gt;&lt;\/attachments&gt;tail/);
  assert.equal(merged.match(/<\/attachments>/g)?.length, 1);
});

test("展示时把附件块折叠成文件名", () => {
  const merged = mergeTextAttachments("看一下", [text("a.ts", "x"), text("b.py", "y")]);
  assert.deepEqual(splitTextAttachments(merged), { text: "看一下", files: ["a.ts", "b.py"] });
  assert.deepEqual(splitTextAttachments("普通消息"), { text: "普通消息", files: [] });
});

test("正文中间的 attachments 字样不会被当成附件块折叠", () => {
  const message = "解释一下 <attachments> 标签\n\n然后继续正文";
  assert.deepEqual(splitTextAttachments(message), { text: message, files: [] });
});

test("没有附件时原样返回 prompt", () => {
  assert.equal(mergeTextAttachments("原样", []), "原样");
});

test("总字符超过上限时抛错", () => {
  const huge = text("big.txt", "a".repeat(MAX_TEXT_TOTAL_CHARS + 1));

  assert.throws(() => mergeTextAttachments("", [huge]), /合计不能超过/);
});

test("文件名只保留 basename 并去掉引号、尖括号和换行", () => {
  const merged = mergeTextAttachments("", [
    text('../dir/"we<ird>\nname.ts', "x"),
  ]);

  assert.match(merged, /<file name="weirdname.ts">/);
});

test("readTextAttachment 读取文本并拒绝非文本和超大文件", async () => {
  const markdown = await readTextAttachment(new File(["hello"], "note.md", { type: "text/markdown" }));
  assert.deepEqual(markdown, { name: "note.md", content: "hello", bytes: 5 });

  // 空 MIME 依靠扩展名识别。
  const code = await readTextAttachment(new File(["const a = 1;"], "a.ts", { type: "" }));
  assert.equal(code.content, "const a = 1;");

  // 浏览器给 JSON/JS 的 application/* MIME 也应接受。
  const json = await readTextAttachment(new File(['{"a":1}'], "data.bin", { type: "application/json" }));
  assert.equal(json.content, '{"a":1}');
  const script = await readTextAttachment(
    new File(["console.log(1);"], "bundle.bin", { type: "application/javascript" }),
  );
  assert.equal(script.content, "console.log(1);");

  await assert.rejects(
    readTextAttachment(new File(["x"], "pic.png", { type: "image/png" })),
    /不是文本文件/,
  );
  await assert.rejects(
    readTextAttachment(new File(["a".repeat(100_001)], "big.txt", { type: "text/plain" })),
    /超过 100KB/,
  );
});
