#!/usr/bin/env node
// 同时启动服务端（127.0.0.1:8787）和前端 Vite（127.0.0.1:5173，/api 代理到服务端）。
// 两条命令各放进独立进程组，Ctrl-C 或任一条退出时整组停掉，避免 npm 的子进程残留。
// 放在 Node 里做是为了 Windows（cmd.exe）和 POSIX 都能用，Makefile 里不需要 bash 语法。
import { spawn, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

/** @type {{ name: string, child: import("node:child_process").ChildProcess }[]} */
const running = [];
let stopping = false;

function start(name, script) {
  const child = spawn("npm", ["run", script], {
    stdio: "inherit",
    // Windows 上 npm 是 npm.cmd，只能经 cmd.exe 启动。
    shell: isWindows,
    // POSIX 上给每条命令单独一个进程组，退出时可以整组回收。
    detached: !isWindows,
  });
  running.push({ name, child });

  child.on("error", (error) => {
    console.error(`[dev] ${name} 启动失败：${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    const reason = signal ? `收到信号 ${signal}` : `退出码 ${code ?? 0}`;
    shutdown(signal ? 1 : code ?? 0, `${name} ${reason}`);
  });
}

function kill(child, force) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    // taskkill /T 连 npm 派生出的子进程一起结束；控制台程序直接 /F 才可靠。
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // 进程组已经退出
  }
}

function shutdown(code, cause) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (cause) console.error(`[dev] ${cause}，正在停止其余进程`);
  for (const { child } of running) kill(child, false);
  // 给进程一点时间自行退出；仍然活着的强制结束，避免 Ctrl-C 后卡住。
  setTimeout(() => {
    for (const { child } of running) kill(child, true);
  }, 3000).unref();
}

process.on("SIGINT", () => shutdown(130, "收到 Ctrl-C"));
process.on("SIGTERM", () => shutdown(143, "收到 SIGTERM"));

console.error("[dev] 启动服务端和前端，浏览器打开 http://127.0.0.1:5173 ，Ctrl-C 结束");
start("服务端", "dev");
start("前端", "dev:web");
