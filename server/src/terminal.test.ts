import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  clampCols,
  clampRows,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_INPUT_CHARS,
  normalizeDimension,
  parseTerminalClientMessage,
  resolveHome,
  resolveShell,
  TerminalLimitError,
  TerminalManager,
  terminalEnv,
  type PtyExit,
  type PtyProcess,
  type PtySpawnOptions,
} from "./terminal.js";

class FakePty implements PtyProcess {
  readonly pid = 4242;
  written: string[] = [];
  resized: [number, number][] = [];
  kills: (string | undefined)[] = [];
  pauses = 0;
  resumes = 0;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExit) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExit) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
  }

  kill(signal?: string): void {
    this.kills.push(signal);
  }

  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  exit(exitCode = 0): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }
}

function fakeManager(options: { maxSessions?: number } = {}) {
  const ptys: FakePty[] = [];
  const spawns: PtySpawnOptions[] = [];
  const manager = new TerminalManager({
    shell: "/bin/sh",
    cwd: "/tmp",
    env: { SHELL: "/bin/sh" },
    ...options,
    spawn: (spawnOptions) => {
      spawns.push(spawnOptions);
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  return { manager, ptys, spawns };
}

test("打开终端时按配置启动 PTY 并发送 ready 所需信息", () => {
  const { manager, spawns } = fakeManager();
  const session = manager.open({ cols: 120, rows: 40 });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.shell, "/bin/sh");
  assert.equal(spawns[0]?.cwd, "/tmp");
  assert.equal(spawns[0]?.cols, 120);
  assert.equal(spawns[0]?.rows, 40);
  assert.equal(spawns[0]?.env.TERM, "xterm-256color");
  assert.equal(session.shell, "/bin/sh");
  assert.equal(session.cwd, "/tmp");
  assert.equal(session.pid, 4242);
  assert.equal(manager.size, 1);
  session.close();
  assert.equal(manager.size, 0);
});

test("指定 cwd 时 PTY 在该目录启动", () => {
  const { manager, spawns } = fakeManager();
  const session = manager.open({ cwd: "/workspace/repo" });
  assert.equal(spawns[0]?.cwd, "/workspace/repo");
  assert.equal(session.cwd, "/workspace/repo");
  session.close();
});

test("输入、输出、尺寸和退出事件在会话中透传", () => {
  const { manager, ptys } = fakeManager();
  const session = manager.open();
  const received: string[] = [];
  const exits: PtyExit[] = [];
  session.onData((data) => received.push(data));
  session.onExit((exit) => exits.push(exit));

  session.write("ls\n");
  session.resize(100, 30);
  ptys[0]?.emit("file.txt\r\n");
  ptys[0]?.exit(3);

  assert.deepEqual(ptys[0]?.written, ["ls\n"]);
  assert.deepEqual(ptys[0]?.resized, [[100, 30]]);
  assert.deepEqual(received, ["file.txt\r\n"]);
  assert.deepEqual(exits, [{ exitCode: 3 }]);
  assert.equal(session.exited, true);
  assert.equal(manager.size, 0);
});

test("退出事件在注册前已经发生时仍然补发一次", () => {
  const { manager, ptys } = fakeManager();
  const session = manager.open();
  ptys[0]?.exit(0);
  const exits: PtyExit[] = [];
  session.onExit((exit) => exits.push(exit));
  // onExit 用 queueMicrotask 补发，等一个微任务。
  return Promise.resolve().then(() => {
    assert.deepEqual(exits, [{ exitCode: 0 }]);
  });
});

test("并发上限拒绝新连接，退出后释放名额", () => {
  const { manager, ptys } = fakeManager({ maxSessions: 1 });
  manager.open();
  assert.throws(() => manager.open(), TerminalLimitError);
  ptys[0]?.exit(0);
  assert.equal(manager.size, 0);
  const next = manager.open();
  assert.equal(manager.size, 1);
  next.close();
});

test("closeAll 结束所有 PTY", () => {
  const { manager, ptys } = fakeManager({ maxSessions: 4 });
  manager.open();
  manager.open();
  manager.closeAll();
  assert.equal(manager.size, 0);
  assert.deepEqual(ptys.map((pty) => pty.kills.length), [1, 1]);
});

test("断开后关闭会话会杀掉 PTY，且重复 close 幂等", () => {
  const { manager, ptys } = fakeManager();
  const session = manager.open();
  session.close();
  session.close();
  assert.equal(ptys[0]?.kills.length, 1);
  assert.equal(manager.size, 0);
});

test("客户端消息解析拒绝坏数据并收敛尺寸", () => {
  assert.deepEqual(parseTerminalClientMessage('{"type":"input","data":"ls\\n"}'), {
    type: "input",
    data: "ls\n",
  });
  assert.deepEqual(parseTerminalClientMessage('{"type":"resize","cols":120,"rows":40}'), {
    type: "resize",
    cols: 120,
    rows: 40,
  });
  // 越界尺寸收敛在范围内。
  assert.deepEqual(parseTerminalClientMessage('{"type":"resize","cols":99999,"rows":-3}'), {
    type: "resize",
    cols: 500,
    rows: 2,
  });
  assert.equal(parseTerminalClientMessage("not json"), undefined);
  assert.equal(parseTerminalClientMessage('{"type":"input"}'), undefined);
  assert.equal(parseTerminalClientMessage('{"type":"input","data":""}'), undefined);
  assert.equal(parseTerminalClientMessage(JSON.stringify({
    type: "input",
    data: "x".repeat(MAX_INPUT_CHARS + 1),
  })), undefined);
  assert.equal(parseTerminalClientMessage('{"type":"other"}'), undefined);
  assert.equal(parseTerminalClientMessage(Buffer.from("{}")), undefined);
});

test("尺寸解析对缺失和非法值使用默认值", () => {
  assert.equal(normalizeDimension(undefined, DEFAULT_COLS, 500), DEFAULT_COLS);
  assert.equal(normalizeDimension("80", DEFAULT_COLS, 500), DEFAULT_COLS);
  assert.equal(normalizeDimension(Number.NaN, DEFAULT_ROWS, 300), DEFAULT_ROWS);
  assert.equal(normalizeDimension(79.9, DEFAULT_COLS, 500), 79);
  assert.equal(clampCols(1), 2);
  assert.equal(clampRows(1000), 300);
});

test("shell 优先使用 $SHELL，不存在时回退到可用的 bash/sh", () => {
  const shell = resolveShell({ SHELL: "/definitely/not/a/shell" });
  assert.ok(shell === "/bin/bash" || shell === "/bin/sh");
  if (fs.existsSync("/bin/sh")) {
    assert.equal(resolveShell({ SHELL: "/bin/sh" }), "/bin/sh");
  }
});

test("主目录不可用时回退到进程工作目录", () => {
  assert.ok(resolveHome({ HOME: "/definitely/not/a/home" }).length > 0);
});

test("终端环境保留原变量并补上 TERM", () => {
  const env = terminalEnv({ PATH: "/usr/bin", TERM: "dumb" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
});

test("终端环境按前缀和名字片段脱敏凭据变量", () => {
  const removed = [
    "QUBIUS_AUTH_TOKEN",
    "REMOTE_CODER_AUTH_TOKEN",
    "QUBIUS_GITEA_TOKEN",
    "QUBIUS_OPS_TOKEN",
    "EDGECTL_DEV_PASSWORD_HASH",
    "EDGECTL_DEV_COOKIE_SECRET",
    "EDGECTL_PROD_API_KEY",
    "QUBIUS_SOME_CREDENTIALS",
    "QUBIUS_LEGACY_PASSWD",
    "QUBIUS_SESSION_COOKIE",
    "qubius_lower_case_secret",
  ];
  const kept = [
    "PATH",
    "HOME",
    "QUBIUS_AUTH",
    "QUBIUS_TERMINAL",
    "QUBIUS_EDGECTL_CONFIG",
    "QUBIUS_EDGECTL_BIN",
    "QUBIUS_OPS_ROOT",
    "QUBIUS_OPS_JOB",
    "QUBIUS_PUBLIC_HOST",
    "REMOTE_CODER_HOME",
    "EDGECTL_DEV",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITEA_TOKEN",
    // 前缀必须完整匹配，XQUBIUS_、REMOTE_CODERX_ 不是受控前缀。
    "XQUBIUS_AUTH_TOKEN",
    "REMOTE_CODERX_TOKEN",
  ];
  const env = terminalEnv(
    Object.fromEntries([...removed, ...kept].map((key) => [key, "value"])),
  );
  for (const key of removed) assert.equal(key in env, false, `应删除 ${key}`);
  for (const key of kept) assert.equal(env[key], "value", `应保留 ${key}`);
});

test("暂停和恢复透传给 PTY，结束后不再调用", () => {
  const { manager, ptys } = fakeManager();
  const session = manager.open();
  session.pause();
  session.resume();
  assert.equal(ptys[0]?.pauses, 1);
  assert.equal(ptys[0]?.resumes, 1);
  session.close();
  session.pause();
  session.resume();
  assert.equal(ptys[0]?.pauses, 1);
  assert.equal(ptys[0]?.resumes, 1);
});
