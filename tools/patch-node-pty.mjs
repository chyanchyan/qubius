#!/usr/bin/env node
// Windows 上关闭终端时，node-pty 1.1.0 的 WindowsPtyAgent.kill() 会 fork
// lib/conpty_console_list_agent.js 枚举控制台进程。shell 已经退出、或宿主进程
// 没有控制台（服务、计划任务、session 0）时，原生 AttachConsole 失败，agent 没有
// try/catch，会以未捕获异常退出并打印一整段栈。终端功能本身不受影响，只是噪音。
//
// 上游 microsoft/node-pty 已用 try/catch 修复（1.2.0-beta.18 起），但 npm 正式版
// 1.1.0 还没有。这里在 npm ci 的 postinstall 阶段给已安装的 agent 文件打补丁，
// 不改仓库里的依赖声明。补丁是幂等的；无法识别的内容只告警，绝不阻断安装。
//
// 上游正式版包含修复后，删除本文件、patch-node-pty.test.mjs，以及根 package.json
// 里的 postinstall 即可。说明见 docs/deployment.md「node-pty 补丁」。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/** node-pty 在 workspace 里的常见位置：根目录和 server 各可能有一份。 */
const AGENT_PATHS = [
  ["node_modules", "node-pty", "lib", "conpty_console_list_agent.js"],
  ["server", "node_modules", "node-pty", "lib", "conpty_console_list_agent.js"],
];

/** 1.1.0 里需要替换的两行（允许 CRLF）。 */
const ORIGINAL_BLOCK =
  /^var shellPid = parseInt\(process\.argv\[2\], 10\);\r?\nvar consoleProcessList = getConsoleProcessList\(shellPid\);\r?\n/m;

/** 已打过补丁（或上游已修复）的标记。 */
const PATCHED_MARKER = /if \(shellPid > 0\) \{\s*\n\s*try \{/;

/**
 * 与上游 1.2.0-beta.18 的修复保持一致：shellPid 无效时不调用原生模块，
 * AttachConsole 抛错时退回空列表。
 */
const PATCHED_BLOCK = `var shellPid = parseInt(process.argv[2], 10);
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
`;

/**
 * 给 agent 源码打补丁，不改动其它内容。
 *
 * @param {string} source
 * @returns {{status: "patched" | "already" | "unknown", source: string}}
 *   patched 表示本次改写了内容；already 表示已是补丁后/上游修复后的版本；
 *   unknown 表示内容不认识，调用方应原样保留并告警。
 */
export function patchAgentSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("patchAgentSource 需要字符串源码");
  }
  if (PATCHED_MARKER.test(source)) {
    return { status: "already", source };
  }
  if (!ORIGINAL_BLOCK.test(source)) {
    return { status: "unknown", source };
  }
  const patched = source.replace(ORIGINAL_BLOCK, PATCHED_BLOCK);
  if (patched === source) {
    return { status: "unknown", source };
  }
  // 替换结果必须仍是合法 JS；否则宁可保持原样，也不要写坏依赖。
  try {
    new vm.Script(patched, { filename: "conpty_console_list_agent.js" });
  } catch {
    return { status: "unknown", source };
  }
  return { status: "patched", source: patched };
}

/**
 * 找出所有已安装的 agent 文件（根目录优先，server 下的副本也处理）。
 *
 * @param {string} rootDir 仓库根目录
 * @returns {string[]}
 */
export function findAgentFiles(rootDir) {
  const files = [];
  for (const parts of AGENT_PATHS) {
    const file = path.join(rootDir, ...parts);
    try {
      if (fs.statSync(file).isFile()) files.push(file);
    } catch {
      // 没安装 node-pty 或路径不可读：忽略这一份。
    }
  }
  return files;
}

/**
 * 返回第一份 agent 文件；保留这个导出供调用方判断是否安装了 node-pty。
 *
 * @param {string} rootDir
 * @returns {string | null}
 */
export function findAgentFile(rootDir) {
  return findAgentFiles(rootDir)[0] ?? null;
}

/**
 * 读取文件，需要时原子改写。IO 错误向上抛出，由 runPatch 统一吞掉。
 *
 * @param {string} file
 * @returns {"patched" | "already" | "unknown"}
 */
export function patchFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const result = patchAgentSource(source);
  if (result.status !== "patched") return result.status;

  // 先写同目录临时文件再 rename，避免并发安装或中断时留下半截文件。
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  const mode = fs.statSync(file).mode & 0o777;
  try {
    fs.writeFileSync(tmp, result.source, { mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不影响主流程。
    }
    throw error;
  }
  return "patched";
}

/**
 * postinstall 入口：处理所有副本。任何异常都只告警，不改变退出码。
 *
 * @param {string} rootDir
 * @param {{log?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void}} [io]
 * @returns {{file: string, status: "patched" | "already" | "unknown" | "error"}[]}
 */
export function runPatch(
  rootDir,
  { log = console.log, warn = console.warn } = {},
) {
  let files;
  try {
    files = findAgentFiles(rootDir);
  } catch (error) {
    warn(`[patch-node-pty] 查找 node-pty 失败，跳过：${describeError(error)}`);
    return [];
  }

  const results = [];
  for (const file of files) {
    try {
      const status = patchFile(file);
      results.push({ file, status });
      if (status === "patched") {
        log(`[patch-node-pty] 已修补 ${file}`);
      } else if (status === "unknown") {
        warn(
          `[patch-node-pty] 无法识别 node-pty${nodePtyVersion(file)} 的控制台枚举脚本，已跳过：${file}\n` +
            "  如果关闭终端仍打印 AttachConsole failed，请按新的 agent 内容更新 tools/patch-node-pty.mjs。",
        );
      }
    } catch (error) {
      results.push({ file, status: "error" });
      warn(`[patch-node-pty] 跳过 ${file}：${describeError(error)}`);
    }
  }
  return results;
}

/** 读取 agent 所属 node-pty 的版本，只用于告警文案。 */
function nodePtyVersion(file) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(file), "..", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" && pkg.version ? ` ${pkg.version}` : "";
  } catch {
    return "";
  }
}

function describeError(error) {
  if (error && typeof error === "object" && "code" in error && error.code) {
    return String(error.code);
  }
  return error instanceof Error ? error.message : String(error);
}

/** 只有直接运行本文件时才执行；被测试 import 时不产生副作用。 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(process.argv[1]);
    return process.platform === "win32"
      ? self.toLowerCase() === entry.toLowerCase()
      : self === entry;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    runPatch(process.cwd());
  } catch (error) {
    // 兜底：postinstall 绝不能因为补丁失败而让 npm ci 失败。
    console.warn(`[patch-node-pty] 跳过：${describeError(error)}`);
  }
}
