import assert from "node:assert/strict";
import test from "node:test";
import { fenceKind, isMarkdownFenceLanguage, looksLikeMarkdownDocument } from "./markdown-fences";

test("isMarkdownFenceLanguage：markdown/md，大小写与空白不敏感", () => {
  assert.equal(isMarkdownFenceLanguage("markdown"), true);
  assert.equal(isMarkdownFenceLanguage("md"), true);
  assert.equal(isMarkdownFenceLanguage(" Markdown "), true);
  assert.equal(isMarkdownFenceLanguage("MD"), true);
  assert.equal(isMarkdownFenceLanguage(""), false);
  assert.equal(isMarkdownFenceLanguage("mermaid"), false);
  assert.equal(isMarkdownFenceLanguage("typescript"), false);
});

test("无语言围栏：明显的 Markdown 文档按 Markdown 渲染", () => {
  /* 截图里那种结构：围栏错位后剩下的文档后半段。 */
  const block = [
    "---",
    "",
    "## 第二部分：分阶段 kickoff 提示词",
    "",
    "> 用法：新 repo 建好后，按段逐条发给执行 agent。",
    "",
    "### Stage 0 业务与口径盘点",
    "",
    "先不写业务代码，产出可评审的规格与指标注册表初稿。",
  ].join("\n");
  assert.equal(looksLikeMarkdownDocument(block), true);
  assert.equal(fenceKind("", block), "markdown");

  const doc = ["# 项目宪章", "", "## 这是什么", "", "- 每个口径有唯一身份", "- SQL 由定义生成"].join("\n");
  assert.equal(looksLikeMarkdownDocument(doc), true);
});

test("无语言围栏：代码片段保持代码", () => {
  const samples = [
    /* shell：只有 # 注释这一种结构。 */
    "# install deps\nnpm ci\n# run tests\nnpm test\n",
    /* python：## 注释是同一种结构，不能当成多级标题。 */
    "## Setup\npip install -r requirements.txt\n## Run\npython app.py\n",
    /* YAML：--- 是文档分隔符，不是 Markdown 结构。 */
    "---\nname: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n---\n",
    /* diff：---/+++ 行带文件名，不是分隔线。 */
    "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
    /* JSON 与普通日志。 */
    '{\n  "a": 1,\n  "b": [2, 3]\n}\n',
    "2026-11-26 08:00:00 INFO started\n2026-11-26 08:00:01 INFO ready\n",
    /* 只有列表：可能只是普通日志/清单。 */
    "- one\n- two\n- three\n",
  ];
  for (const sample of samples) {
    assert.equal(looksLikeMarkdownDocument(sample), false, sample);
    assert.equal(fenceKind("", sample), "code", sample);
  }
});

test("无语言围栏：强代码特征优先按代码处理", () => {
  const sample = "# 第一节\n\ndef build():\n    return 1\n";
  assert.equal(looksLikeMarkdownDocument(sample), false);
});

test("空的无语言围栏整块隐藏（围栏错位留下的空框）", () => {
  assert.equal(fenceKind("", ""), "hidden");
  assert.equal(fenceKind("", "  \n\t\n"), "hidden");
});

test("有语言标记时按语言判断，不做启发式", () => {
  const md = "# 标题\n\n- 列表\n";
  assert.equal(fenceKind("markdown", md), "markdown");
  assert.equal(fenceKind("md", md), "markdown");
  assert.equal(fenceKind("text", md), "code");
  assert.equal(fenceKind("yaml", "name: ci\n"), "code");
  /* 有明确语言时，空内容也保留容器语义以外的最小行为。 */
  assert.equal(fenceKind("typescript", ""), "code");
});
