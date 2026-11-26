import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendProjectToFile, removeProjectFromFile } from "./project-source.js";

function tempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-project-source-"));
  const file = path.join(dir, "projects.yaml");
  fs.writeFileSync(file, content);
  return file;
}

const SAMPLE = [
  "# 额外项目（部署页维护）",
  "  - id: 'one'",
  "    name: 'One'",
  "    path: '/srv/one'",
  "    permission: acceptEdits",
  "    # one 的说明",
  "",
  "# two 上面的一行注释",
  "  - id: 'two'",
  "    name: 'Two'",
  "    path: '/srv/two'",
  "    permission: auto",
  "    isolated: true",
  "",
].join("\n");

test("removeProjectFromFile 删除目标条目并保留其它项目、顶格注释和空行", () => {
  const file = tempFile(SAMPLE);
  assert.equal(removeProjectFromFile(file, "one"), true);
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /id: 'one'/);
  assert.doesNotMatch(text, /one 的说明/);
  assert.match(text, /^# 额外项目（部署页维护）$/m);
  assert.match(text, /^# two 上面的一行注释$/m);
  assert.match(text, /^  - id: 'two'$/m);
  assert.match(text, /^    isolated: true$/m);
});

test("removeProjectFromFile 删除最后一项不会留下条目内容", () => {
  const file = tempFile(SAMPLE);
  assert.equal(removeProjectFromFile(file, "two"), true);
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /id: 'two'/);
  assert.doesNotMatch(text, /isolated: true/);
  assert.match(text, /^  - id: 'one'$/m);
});

test("removeProjectFromFile 对不存在或无法识别的条目返回 false", () => {
  const file = tempFile(SAMPLE);
  assert.equal(removeProjectFromFile(file, "missing"), false);
  assert.match(fs.readFileSync(file, "utf8"), /id: 'one'/);

  const flow = tempFile("- { id: flow, name: Flow, path: /srv/flow, permission: auto }\n");
  assert.equal(removeProjectFromFile(flow, "flow"), false);
});

test("append/remove 往返后文件仍能被部署校验的缩进规则接受", () => {
  const file = tempFile("");
  appendProjectToFile(file, {
    id: "demo",
    name: "示例",
    path: "/srv/demo",
    permission: "acceptEdits",
    isolated: false,
  });
  appendProjectToFile(file, {
    id: "gone",
    name: "待删",
    path: "/srv/gone",
    permission: "acceptEdits",
    isolated: false,
  });
  assert.equal(removeProjectFromFile(file, "gone"), true);
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    assert.ok(/^  - /.test(line) || /^    [^ ]/.test(line), `缩进不合法：${line}`);
    assert.ok(!line.includes("\t"));
  }
});
