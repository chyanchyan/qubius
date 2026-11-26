#!/usr/bin/env node
// 克隆仓库后的首次启动命令：选择 npm 源（可同时选择配置目录），
// 依次执行 npm ci、npm run build、npm start。
// 只用 Node 内置模块，未安装依赖也能运行；Windows 和 POSIX 通用。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  DEFAULT_REGISTRY,
  NPM_LOGLEVELS,
  REGISTRIES,
  defaultConfigDir,
  listenerPids,
  nextFreePort,
  normalizeConfigDir,
  parseArgs,
  parsePort,
  portInUse,
  processInfo,
  registryFromInput,
  stopProcess,
  waitPortFree,
} from "./quickstart-lib.mjs";

const isWindows = process.platform === "win32";
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const npm = "npm";

function help() {
  console.log(`用法：npm run quickstart [-- --registry <地址或序号>] [--config-dir <绝对路径>]
                     [--port <端口>] [--verbose] [--loglevel <级别>] [--dry-run]

不带参数时会交互式询问：
  1. npm 源：官方源、npmmirror（淘宝）、腾讯云、华为云，也可以直接粘贴地址
  2. 配置目录：留空使用服务端默认值（Windows 为 %APPDATA%\\qubius，
     Linux/macOS 为 $XDG_CONFIG_HOME/qubius 或 ~/.config/qubius）
  3. 监听端口：默认 8787（副实例 8788），只绑定 127.0.0.1

随后依次执行 npm ci、npm run build、npm start。
--verbose（或 -v）输出 npm 安装/构建的详细日志，并实时显示依赖的安装脚本输出；
--loglevel 可以直接指定 npm 日志级别（${NPM_LOGLEVELS.join("、")}），
不想看日志时用 --loglevel silent。
只有首次启动需要选择配置目录；运行中的服务不能切换配置目录。
已有配置时端口以配置里的 listen 为准；被占用时交互菜单可以选择
停止占用进程（二次确认；Windows 上强制结束）或换一个空闲端口。`);
}

function printRegistries() {
  console.log("选择 npm 源（直接回车使用官方源，也可以粘贴一个源地址）：");
  for (const [index, item] of REGISTRIES.entries()) {
    console.log(`  ${index + 1}. ${item.label.padEnd(18)} ${item.url}`);
  }
}

async function askRegistry(preset) {
  if (preset) {
    const resolved = registryFromInput(preset);
    if (!resolved) throw new Error(`--registry 不是合法地址或序号：${preset}`);
    return resolved;
  }
  if (!interactive) return DEFAULT_REGISTRY;
  printRegistries();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question("序号或地址（默认 1）：");
      const resolved = registryFromInput(answer);
      if (resolved) return resolved;
      console.log("输入无效，请输入 1-4 的序号或一个 http(s) 地址。");
    }
  } finally {
    rl.close();
  }
}

async function askConfigDir(preset, env) {
  if (preset) return normalizeConfigDir(preset, env);
  const fromEnv = (env.QUBIUS_CONFIG_DIR ?? "").trim();
  if (fromEnv) {
    console.log(`使用环境变量 QUBIUS_CONFIG_DIR：${fromEnv}`);
    return normalizeConfigDir(fromEnv, env);
  }
  if (!interactive) return "";
  const fallback = defaultConfigDir(env);
  console.log(`配置目录留空时使用默认值：${fallback}`);
  console.log("只有首次启动需要选择；运行中的服务不能切换配置目录。");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question("配置目录（留空使用默认值）：");
      if (!answer.trim()) return "";
      try {
        return normalizeConfigDir(answer, env);
      } catch (error) {
        console.log(`${error.message}；留空即可使用默认值。`);
      }
    }
  } finally {
    rl.close();
  }
}

function run(label, args, env, { verbose = false } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n[quickstart] ${label}`);
    if (verbose) console.log(`[quickstart] 命令：npm ${args.join(" ")}`);
    const startedAt = Date.now();
    // Windows 上 npm 是 npm.cmd，需要经 cmd.exe 启动。
    const child = spawn(npm, args, { stdio: "inherit", shell: isWindows, env });
    child.on("error", (error) => reject(new Error(`${label} 启动失败：${error.message}`)));
    child.on("exit", (code, signal) => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (signal) {
        reject(new Error(`${label} 被信号 ${signal} 终止`));
        return;
      }
      if (code === 0) {
        console.log(`[quickstart] ${label} 完成（用时 ${seconds}s）`);
        resolve();
      } else {
        reject(new Error(`${label} 失败（退出码 ${code ?? "未知"}，用时 ${seconds}s）`));
      }
    });
  });
}

/**
 * 与 server/src/index.ts 的 configPath 对齐：显式配置、仓库 config.yaml、
 * Windows / macOS 的部署配置目录。
 */
function findConfigFile(env) {
  const explicit = (env.QUBIUS_CONFIG ?? env.REMOTE_CODER_CONFIG ?? "").trim();
  if (explicit && fs.existsSync(path.resolve(explicit))) return path.resolve(explicit);
  const local = path.join(process.cwd(), "config.yaml");
  if (fs.existsSync(local)) return local;
  // Linux 由 start-all.sh/run.sh 显式传 QUBIUS_CONFIG；Windows 和 macOS 的
  // 页面部署把配置留在配置目录，手工启动时要自己找回来。
  if (!isWindows && process.platform !== "darwin") return "";
  const dir = (env.QUBIUS_CONFIG_DIR ?? "").trim() || defaultConfigDir(env);
  const secondary = env.QUBIUS_SECONDARY === "1";
  const deployed = path.join(dir, secondary ? "config-secondary.yaml" : "config.yaml");
  return fs.existsSync(deployed) ? deployed : "";
}

/** 从已有配置里读 listen 端口；读不到时服务端默认 8787。 */
function configListenPort(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/^\s*listen:\s*[^\s#]+:(\d+)\s*$/m);
    const port = match ? Number(match[1]) : undefined;
    return port !== undefined && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function printPortHelp(port) {
  if (isWindows) {
    console.log(`  查看占用：netstat -ano | findstr :${port}`);
    console.log("  停止进程：taskkill /PID <PID> /F");
  } else {
    console.log(`  查看占用：lsof -i :${port}  或  ss -ltnp | grep :${port}`);
    console.log("  停止进程：kill <PID>");
  }
}

async function askPort(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question(question);
      const text = answer.trim();
      if (text.toLowerCase() === "q") throw new Error("已取消启动。");
      const chosen = text ? parsePort(text) : fallback;
      if (chosen) return chosen;
      console.log("端口必须是 1–65535 的整数。");
    }
  } finally {
    rl.close();
  }
}

function listenersFor(port) {
  const { pids } = listenerPids(port);
  const own = new Set([process.pid, process.ppid].filter((pid) => Number.isInteger(pid)));
  return pids
    .filter((pid) => !own.has(pid))
    .map((pid) => processInfo(pid) ?? { pid, name: "", command: "" });
}

function printListeners(listeners) {
  if (listeners.length === 0) {
    console.log("  未能自动获取占用进程；可能需要权限或系统缺少 lsof/ss。");
    return;
  }
  console.log("  占用进程：");
  for (const item of listeners) {
    const detail = item.command ? `  ${item.command}` : "";
    console.log(`    PID ${item.pid}  ${item.name || "未知进程"}${detail}`);
    if (!/node|qubius/i.test(`${item.name} ${item.command}`)) {
      console.log("      注意：这个进程看起来不是 qubius/node，请确认后再停止。");
    }
  }
}

async function askAction({ allowStop, allowChange }) {
  const choices = [];
  if (allowStop) choices.push({ action: "stop", label: "停止占用进程并继续（需再次确认）" });
  if (allowChange) choices.push({ action: "port", label: "换一个端口" });
  choices.push({ action: "exit", label: "退出" });
  // 默认不结束进程：能换端口时默认换端口，否则退出。
  const defaultAction = allowChange ? "port" : "exit";
  const defaultNumber = choices.findIndex((choice) => choice.action === defaultAction) + 1;

  console.log("如何处理？");
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`选择（默认 ${defaultNumber}）：`)).trim().toLowerCase();
      if (!answer) return defaultAction;
      if (/^\d+$/.test(answer)) {
        const choice = choices[Number(answer) - 1];
        if (choice) return choice.action;
      }
      const alias = answer === "q" ? "exit" : answer === "s" ? "stop" : answer === "p" ? "port" : answer;
      const choice = choices.find((item) => item.action === alias);
      if (choice) return choice.action;
      console.log("输入无效，请重新选择。");
    }
  } finally {
    rl.close();
  }
}

async function confirmStop(listeners) {
  if (isWindows) {
    console.log("Windows 上会使用 taskkill /F 强制结束进程，可能丢失最近约 1 秒未落盘的会话改动。");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(isWindows ? "确认强制停止上述进程？[y/N]：" : "确认停止上述进程？[y/N]：");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function stopListeners(port, listeners) {
  for (const item of listeners) {
    try {
      stopProcess(item.pid);
      console.log(`[quickstart] 已发送停止信号：PID ${item.pid}`);
    } catch (error) {
      console.log(`[quickstart] 无法停止 PID ${item.pid}：${error.message}`);
    }
  }
  const freed = await waitPortFree(port);
  if (freed) {
    console.log(`[quickstart] 端口 ${port} 已释放。`);
  } else {
    console.log(`[quickstart] 端口 ${port} 仍在监听，可能需要更高权限或手动结束进程。`);
    printPortHelp(port);
    if (isWindows) console.log("  如果提示拒绝访问，请以管理员身份打开终端后重试。");
  }
  return freed;
}

/**
 * 启动前确认监听端口。
 * 已有配置时端口由配置决定，不能靠环境变量改；否则交互模式会先询问端口，
 * 被占用时还可以换一个空闲端口。非交互或 --port 指定时不询问。
 */
async function choosePort(preset, env, lockedPort) {
  const secondary = env.QUBIUS_SECONDARY === "1";
  const envKey = secondary ? "QUBIUS_SECONDARY_PORT" : "QUBIUS_PRIMARY_PORT";
  const fallback = secondary ? 8788 : 8787;
  let port;
  if (lockedPort !== undefined) {
    port = lockedPort;
    if (preset !== undefined && parsePort(preset) !== undefined && parsePort(preset) !== port) {
      console.log(`已有配置固定使用端口 ${port}，忽略 --port ${preset}。`);
    }
  } else if (preset !== undefined) {
    port = parsePort(preset);
    if (!port) throw new Error(`--port 必须是 1–65535 的整数：${preset}`);
  } else {
    port = parsePort(env[envKey]) ?? fallback;
    if (interactive) {
      console.log("服务只监听 127.0.0.1；对外暴露请用反向代理或 SSH 隧道。");
      port = await askPort(`监听端口（默认 ${port}，直接回车使用，输入 q 退出）：`, port);
    }
  }

  for (;;) {
    if (!(await portInUse(port))) return { port, envKey, locked: lockedPort !== undefined };
    console.log(`\n[quickstart] 端口 ${port} 已被占用，可能是已经有一个 qubius 实例在运行。`);
    const listeners = listenersFor(port);
    printListeners(listeners);
    if (listeners.length === 0) printPortHelp(port);

    if (!interactive) {
      printPortHelp(port);
      throw new Error(`端口 ${port} 已被占用；请用 --port <空闲端口>，或先停止占用进程后重试。`);
    }

    const allowChange = lockedPort === undefined;
    if (!allowChange && listeners.length === 0) {
      printPortHelp(port);
      throw new Error(`端口 ${port} 已被占用；未能自动找到占用进程，请手动停止后重试。`);
    }

    const action = await askAction({ allowStop: listeners.length > 0, allowChange });
    if (action === "exit") throw new Error("已取消启动。");
    if (action === "stop") {
      if (!(await confirmStop(listeners))) continue;
      await stopListeners(port, listeners);
      continue;
    }
    const suggestion = (await nextFreePort(port)) ?? (port < 65535 ? port + 1 : 65534);
    port = await askPort(`输入新端口（回车使用 ${suggestion}，输入 q 退出）：`, suggestion);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }
  if (options.unknown?.length) {
    throw new Error(`未知参数：${options.unknown.join(" ")}；用 --help 查看用法`);
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(`需要 Node.js 22 或更高版本，当前是 ${process.version}`);
  }
  if (!fs.existsSync(path.join(process.cwd(), "package.json"))) {
    throw new Error(`当前目录不像 qubius 仓库（缺少 package.json）：${process.cwd()}`);
  }

  const env = { ...process.env };
  // 不指定时沿用 npm 默认的 notice 级别；--verbose / --loglevel 让安装过程更详细。
  let npmLoglevel = "";
  if (options.loglevel !== undefined) {
    npmLoglevel = String(options.loglevel).trim();
    if (!NPM_LOGLEVELS.includes(npmLoglevel)) {
      throw new Error(`--loglevel 只支持 ${NPM_LOGLEVELS.join("、")}，收到：${options.loglevel ?? ""}`);
    }
  } else if (options.verbose) {
    npmLoglevel = "verbose";
  }
  if (npmLoglevel) {
    env.npm_config_loglevel = npmLoglevel;
    // npm 默认会缓存依赖的安装脚本（例如 node-pty 编译）输出，只在失败时展示。
    env.npm_config_foreground_scripts = "true";
  }

  const registry = await askRegistry(options.registry);
  env.npm_config_registry = registry;

  const configDir = await askConfigDir(options.configDir, env);
  if (configDir) {
    if (!options.dryRun) fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    env.QUBIUS_CONFIG_DIR = configDir;
  }

  console.log(`\n[quickstart] npm 源：${registry}`);
  console.log(`[quickstart] 配置目录：${configDir || `默认（${defaultConfigDir(env)}）`}`);
  if (npmLoglevel) {
    console.log(`[quickstart] 详细日志：npm --loglevel=${npmLoglevel}，并实时显示依赖安装脚本输出`);
  }

  const configFile = findConfigFile(env);
  const configuredPort = configFile ? configListenPort(configFile) : undefined;
  if (configFile) {
    console.log(`[quickstart] 检测到已有配置：${configFile}`);
    console.log(
      `[quickstart] 服务会按配置里的 listen 端口启动${configuredPort ? `（${configuredPort}）` : ""}；`
        + "要换端口请修改该文件，或换一个配置目录。",
    );
  }

  if (options.dryRun) {
    const secondary = env.QUBIUS_SECONDARY === "1";
    const envKey = secondary ? "QUBIUS_SECONDARY_PORT" : "QUBIUS_PRIMARY_PORT";
    if (options.port !== undefined && parsePort(options.port) === undefined) {
      throw new Error(`--port 必须是 1–65535 的整数：${options.port}`);
    }
    const port = configFile
      ? configuredPort ?? 8787
      : parsePort(options.port) ?? parsePort(env[envKey]) ?? (secondary ? 8788 : 8787);
    console.log(`[quickstart] 监听端口：${port}（仅 127.0.0.1；对外暴露请用反向代理或 SSH 隧道）`);
    const ciPreview = ["ci", "--no-audit", "--no-fund"];
    if (npmLoglevel) ciPreview.push(`--loglevel=${npmLoglevel}`, "--foreground-scripts");
    console.log(`[quickstart] --dry-run：将依次执行 npm ${ciPreview.join(" ")}、npm run build、npm start`);
    return;
  }

  // 先确认端口空闲，避免构建完成后才在 npm start 里报 EADDRINUSE。
  const { port, envKey, locked } = await choosePort(
    options.port,
    env,
    configFile ? configuredPort ?? 8787 : undefined,
  );
  if (!locked) env[envKey] = String(port);
  if (port < 1024) {
    console.log(`[quickstart] 提示：端口 ${port} 小于 1024，Linux/macOS 上可能需要额外权限。`);
  }
  console.log(`[quickstart] 监听端口：${port}（仅 127.0.0.1；对外暴露请用反向代理或 SSH 隧道）`);

  const ciArgs = ["ci", "--no-audit", "--no-fund"];
  if (npmLoglevel) ciArgs.push(`--loglevel=${npmLoglevel}`, "--foreground-scripts");

  try {
    await run("安装依赖：npm ci", ciArgs, env, { verbose: Boolean(npmLoglevel) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n可以重新运行并换一个 npm 源；如果失败在 node-pty 编译，请先安装 python3、make 和 C++ 编译器（g++ 或 clang++）。`,
    );
  }
  await run("构建：npm run build", ["run", "build"], env, { verbose: Boolean(npmLoglevel) });

  console.log(`\n[quickstart] 构建完成。启动后打开 http://127.0.0.1:${port}/deploy 完成首次部署向导。`);
  console.log("[quickstart] 按 Ctrl-C 停止服务。\n");
  await run("启动服务：npm start", ["start"], env, { verbose: Boolean(npmLoglevel) });
}

main().catch((error) => {
  console.error(`\n[quickstart] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
