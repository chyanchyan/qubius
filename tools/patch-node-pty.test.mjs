import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  findAgentFile,
  findAgentFiles,
  patchAgentSource,
  patchFile,
  runPatch,
} from "./patch-node-pty.mjs";

const AGENT_DIR = path.join("node_modules", "node-pty", "lib");
const AGENT_NAME = "conpty_console_list_agent.js";
const SCRIPT = fileURLToPath(new URL("./patch-node-pty.mjs", import.meta.url));

/** node-pty 1.1.0 的原始 agent（npm 正式版）。 */
const ORIGINAL_SOURCE = `"use strict";
/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 *
 * This module fetches the console process list for a particular PID. It must be
 * called from a different process (child_process.fork) as there can only be a
 * single console attached to a process.
 */
Object.defineProperty(exports, "__esModule", { value: true });
var utils_1 = require("./utils");
var getConsoleProcessList = utils_1.loadNativeModule('conpty_console_list').module.getConsoleProcessList;
var shellPid = parseInt(process.argv[2], 10);
var consoleProcessList = getConsoleProcessList(shellPid);
process.send({ consoleProcessList: consoleProcessList });
process.exit(0);
//# sourceMappingURL=conpty_console_list_agent.js.map`;

/** node-pty 1.2.0-beta.18 已包含上游修复。 */
const UPSTREAM_FIXED_SOURCE = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var utils_1 = require("./utils");
var getConsoleProcessList = (0, utils_1.loadNativeModule)('conpty_console_list').module.getConsoleProcessList;
var shellPid = parseInt(process.argv[2], 10);
var consoleProcessList = [];
if (shellPid > 0) {
    try {
        consoleProcessList = getConsoleProcessList(shellPid);
    }
    catch (_a) {
        // AttachConsole can fail if the process already exited or is invalid.
        consoleProcessList = [];
    }
}
process.send({ consoleProcessList: consoleProcessList });
process.exit(0);`;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-node-pty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeAgent(root, source, prefix = "") {
  const dir = path.join(root, prefix, AGENT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, AGENT_NAME);
  fs.writeFileSync(file, source);
  return file;
}

function assertParses(source) {
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: AGENT_NAME }),
    "打补丁后的源码必须是合法 JS",
  );
}

/** 用假的 require/process 执行 agent，返回它发出的消息。 */
function runAgent(source, { pid, getConsoleProcessList }) {
  const sent = [];
  const exitCodes = [];
  const context = {
    exports: {},
    require: (id) => {
      assert.equal(id, "./utils");
      return { loadNativeModule: () => ({ module: { getConsoleProcessList } }) };
    },
    process: {
      argv: ["node", AGENT_NAME, pid],
      send: (message) => sent.push(message),
      exit: (code) => exitCodes.push(code),
    },
  };
  vm.runInNewContext(source, context, { filename: AGENT_NAME });
  // vm 里创建的对象来自另一个 realm，转成宿主对象再比较。
  return { sent: JSON.parse(JSON.stringify(sent)), exitCodes };
}

test("patchAgentSource 给 1.1.0 加上 shellPid 判断和 try/catch", () => {
  const result = patchAgentSource(ORIGINAL_SOURCE);
  assert.equal(result.status, "patched");
  assert.match(result.source, /var consoleProcessList = \[\];/);
  assert.match(result.source, /if \(shellPid > 0\) \{/);
  assert.match(result.source, /try \{[\s\S]*getConsoleProcessList\(shellPid\)/);
  assert.match(result.source, /catch \(_a\) \{/);
  // 其余内容保持不变。
  assert.match(result.source, /process\.send\(\{ consoleProcessList: consoleProcessList \}\);/);
  assert.match(result.source, /process\.exit\(0\);/);
  assert.match(result.source, /sourceMappingURL=conpty_console_list_agent\.js\.map/);
});

test("打补丁后的源码仍然是合法 JS", () => {
  const result = patchAgentSource(ORIGINAL_SOURCE);
  assert.equal(result.status, "patched");
  assertParses(result.source);
  assertParses(result.source.replace(/\n/g, "\r\n"));
});

test("未打补丁的源码在 AttachConsole 失败时会抛出（复现原问题）", () => {
  assert.throws(
    () =>
      runAgent(ORIGINAL_SOURCE, {
        pid: "1234",
        getConsoleProcessList: () => {
          throw new Error("AttachConsole failed");
        },
      }),
    /AttachConsole failed/,
  );
});

test("打补丁后的源码在 AttachConsole 失败时发送空列表并正常退出", () => {
  const { sent, exitCodes } = runAgent(patchAgentSource(ORIGINAL_SOURCE).source, {
    pid: "1234",
    getConsoleProcessList: () => {
      throw new Error("AttachConsole failed");
    },
  });
  assert.deepEqual(sent, [{ consoleProcessList: [] }]);
  assert.deepEqual(exitCodes, [0]);
});

test("打补丁后的源码在正常和 pid 无效时都按预期工作", () => {
  const success = runAgent(patchAgentSource(ORIGINAL_SOURCE).source, {
    pid: "1234",
    getConsoleProcessList: () => [1, 2, 3],
  });
  assert.deepEqual(success.sent, [{ consoleProcessList: [1, 2, 3] }]);

  let calls = 0;
  const zero = runAgent(patchAgentSource(ORIGINAL_SOURCE).source, {
    pid: "0",
    getConsoleProcessList: () => {
      calls += 1;
      return [9];
    },
  });
  assert.equal(calls, 0, "pid 无效时不应调用原生模块");
  assert.deepEqual(zero.sent, [{ consoleProcessList: [] }]);
  assert.deepEqual(zero.exitCodes, [0]);
});

test("patchAgentSource 幂等，第二次返回 already 且内容不变", () => {
  const first = patchAgentSource(ORIGINAL_SOURCE);
  assert.equal(first.status, "patched");
  const second = patchAgentSource(first.source);
  assert.equal(second.status, "already");
  assert.equal(second.source, first.source);
});

test("上游已修复的版本识别为 already，不重复改写", () => {
  const result = patchAgentSource(UPSTREAM_FIXED_SOURCE);
  assert.equal(result.status, "already");
  assert.equal(result.source, UPSTREAM_FIXED_SOURCE);
});

test("无法识别的源码保持原样并返回 unknown", () => {
  const source = '"use strict";\nconsole.log("node-pty 改变了实现");\n';
  const result = patchAgentSource(source);
  assert.equal(result.status, "unknown");
  assert.equal(result.source, source);
});

test("CRLF 的 1.1.0 源码也能打补丁且保持合法", () => {
  const result = patchAgentSource(ORIGINAL_SOURCE.replace(/\n/g, "\r\n"));
  assert.equal(result.status, "patched");
  assertParses(result.source);
  assert.match(result.source, /catch \(_a\) \{/);
});

test("findAgentFile 依次查找根目录和 server/node_modules", (t) => {
  const root = tempRoot(t);
  assert.equal(findAgentFile(root), null);

  const serverFile = writeAgent(root, ORIGINAL_SOURCE, "server");
  assert.equal(findAgentFile(root), serverFile);

  const rootFile = writeAgent(root, ORIGINAL_SOURCE);
  assert.equal(findAgentFile(root), rootFile);
});

test("findAgentFiles 返回全部副本，runPatch 全部打补丁", (t) => {
  const root = tempRoot(t);
  const rootFile = writeAgent(root, ORIGINAL_SOURCE);
  const serverFile = writeAgent(root, ORIGINAL_SOURCE, "server");
  assert.deepEqual(findAgentFiles(root), [rootFile, serverFile]);

  const messages = [];
  const results = runPatch(root, {
    log: (message) => messages.push(message),
    warn: (message) => messages.push(`WARN ${message}`),
  });
  assert.deepEqual(results, [
    { file: rootFile, status: "patched" },
    { file: serverFile, status: "patched" },
  ]);
  assert.equal(messages.length, 2);
  assert.match(fs.readFileSync(rootFile, "utf8"), /catch \(_a\)/);
  assert.match(fs.readFileSync(serverFile, "utf8"), /catch \(_a\)/);
});

test("未安装 node-pty 时静默返回空列表（不阻断安装）", (t) => {
  const root = tempRoot(t);
  const logs = [];
  const results = runPatch(root, {
    log: (message) => logs.push(message),
    warn: (message) => logs.push(`WARN ${message}`),
  });
  assert.deepEqual(results, []);
  assert.deepEqual(logs, []);
});

test("patchFile 原子改写、第二次 already，且不留临时文件", (t) => {
  const root = tempRoot(t);
  const file = writeAgent(root, ORIGINAL_SOURCE);
  assert.equal(patchFile(file), "patched");
  assert.match(fs.readFileSync(file, "utf8"), /catch \(_a\)/);
  assert.equal(patchFile(file), "already");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), [AGENT_NAME]);
});

test("patchFile 遇到无法识别的源码不改写文件", (t) => {
  const root = tempRoot(t);
  const source = '"use strict";\nprocess.exit(0);\n';
  const file = writeAgent(root, source);
  assert.equal(patchFile(file), "unknown");
  assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("runPatch 对未知内容只告警（带上 node-pty 版本），不抛错", (t) => {
  const root = tempRoot(t);
  writeAgent(root, '"use strict";\n// 新版本\n');
  fs.writeFileSync(
    path.join(root, "node_modules", "node-pty", "package.json"),
    JSON.stringify({ name: "node-pty", version: "9.9.9" }),
  );
  const warnings = [];
  assert.doesNotThrow(() =>
    runPatch(root, { log: () => {}, warn: (message) => warnings.push(message) }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /无法识别 node-pty 9\.9\.9/);
});

test("runPatch 在文件不可写时只告警，不抛错", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root 会忽略目录权限");
    return;
  }
  const root = tempRoot(t);
  const file = writeAgent(root, ORIGINAL_SOURCE);
  const dir = path.dirname(file);
  const warnings = [];
  fs.chmodSync(dir, 0o500);
  try {
    assert.doesNotThrow(() =>
      runPatch(root, { log: () => {}, warn: (message) => warnings.push(message) }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /跳过/);
    assert.match(fs.readFileSync(file, "utf8"), /getConsoleProcessList\(shellPid\)/);
  } finally {
    // 先恢复写权限，否则临时目录清理也会失败。
    fs.chmodSync(dir, 0o700);
  }
});

test("作为 postinstall 运行时打补丁并且退出码为 0", (t) => {
  const root = tempRoot(t);
  const file = writeAgent(root, ORIGINAL_SOURCE);
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已修补/);
  assert.match(fs.readFileSync(file, "utf8"), /catch \(_a\)/);

  const again = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), "", "already 时保持安静");
  assert.equal(again.stderr.trim(), "");
});

test("作为 postinstall 遇到未知内容告警但仍然退出 0", (t) => {
  const root = tempRoot(t);
  writeAgent(root, '"use strict";\n// 新版本\n');
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /无法识别/);
});
