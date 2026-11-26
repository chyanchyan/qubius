import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTerminalInput,
  MAX_INPUT_CHUNK,
  parseTerminalServerMessage,
  TerminalStreamParser,
  terminalCreateBody,
  terminalInputBody,
  terminalResizeBody,
} from "./terminal-protocol.js";

test("解析 ready/data/exit/error 消息", () => {
  assert.deepEqual(
    parseTerminalServerMessage('{"type":"ready","id":"t1","shell":"/bin/bash","cwd":"/home/q"}'),
    { type: "ready", id: "t1", shell: "/bin/bash", cwd: "/home/q" },
  );
  assert.deepEqual(
    parseTerminalServerMessage('{"type":"data","data":"\\u001b[32mok\\u001b[0m"}'),
    { type: "data", data: "\u001b[32mok\u001b[0m" },
  );
  assert.deepEqual(
    parseTerminalServerMessage('{"type":"exit","exitCode":0}'),
    { type: "exit", exitCode: 0 },
  );
  assert.deepEqual(
    parseTerminalServerMessage('{"type":"exit","exitCode":2,"signal":15}'),
    { type: "exit", exitCode: 2, signal: 15 },
  );
  assert.deepEqual(
    parseTerminalServerMessage('{"type":"error","message":"同时最多 4 个命令行"}'),
    { type: "error", message: "同时最多 4 个命令行" },
  );
});

test("忽略无法识别的帧", () => {
  assert.equal(parseTerminalServerMessage(""), undefined);
  assert.equal(parseTerminalServerMessage("not json"), undefined);
  assert.equal(parseTerminalServerMessage("null"), undefined);
  assert.equal(parseTerminalServerMessage("[]"), undefined);
  assert.equal(parseTerminalServerMessage('{"type":"data"}'), undefined);
  assert.equal(parseTerminalServerMessage('{"type":"exit","exitCode":"0"}'), undefined);
  assert.equal(parseTerminalServerMessage(Buffer.from("{}")), undefined);
});

test("SSE 解析器能处理跨块和多帧", () => {
  const parser = new TerminalStreamParser();
  assert.deepEqual(parser.push('data: {"type":"data","data":"a"}\n\n'), [
    { type: "data", data: "a" },
  ]);

  // 一帧被网络拆成两半。
  assert.deepEqual(parser.push('data: {"type":"da'), []);
  assert.deepEqual(parser.push('ta","data":"b"}\n\n'), [{ type: "data", data: "b" }]);

  // 一次到达两帧，中间夹一个心跳注释。
  assert.deepEqual(
    parser.push(
      ': keepalive\n\ndata: {"type":"data","data":"c"}\n\n'
      + 'data: {"type":"exit","exitCode":0}\n\n',
    ),
    [{ type: "data", data: "c" }, { type: "exit", exitCode: 0 }],
  );

  // 坏帧直接跳过，不影响后续帧。
  assert.deepEqual(
    parser.push('data: nope\n\ndata: {"type":"data","data":"d"}\n\n'),
    [{ type: "data", data: "d" }],
  );
});

test("输入按服务端上限切块", () => {
  assert.deepEqual(chunkTerminalInput(""), []);
  assert.deepEqual(chunkTerminalInput("ls\n"), ["ls\n"]);
  const long = "x".repeat(MAX_INPUT_CHUNK + 10);
  const chunks = chunkTerminalInput(long);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, MAX_INPUT_CHUNK);
  assert.equal(chunks[1]?.length, 10);
  assert.equal(chunks.join(""), long);
});

test("请求体是 JSON 且尺寸为正整数", () => {
  assert.deepEqual(JSON.parse(terminalCreateBody(120, 40)), { cols: 120, rows: 40 });
  assert.deepEqual(JSON.parse(terminalCreateBody(120, 40, "repo")), {
    cols: 120,
    rows: 40,
    project: "repo",
  });
  assert.deepEqual(JSON.parse(terminalCreateBody(120, 40, "")), { cols: 120, rows: 40 });
  assert.deepEqual(JSON.parse(terminalCreateBody(0, Number.NaN)), { cols: 1, rows: 1 });
  assert.deepEqual(JSON.parse(terminalInputBody("echo 你好\n")), {
    data: "echo 你好\n",
  });
  assert.deepEqual(JSON.parse(terminalResizeBody(132.9, 43)), { cols: 132, rows: 43 });
});
