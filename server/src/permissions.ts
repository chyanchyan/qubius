import fs from "node:fs";
import path from "node:path";

export const PERMISSIONS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;

export type PermissionLevel = (typeof PERMISSIONS)[number];

export type ToolDecision = "allow" | "ask" | "deny";

const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "BashOutput",
]);

const AUTO_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "TodoRead",
  "Agent",
  "Task",
  "WebSearch",
  "WebFetch",
  "Skill",
  "ToolSearch",
  "Bash",
  "BashOutput",
  "KillBash",
]);

const PATH_FIELDS = ["file_path", "path", "notebook_path", "target_file"];

export function isPermission(value: unknown): value is PermissionLevel {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export function decideTool(options: {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  blockedPath?: string;
  permission?: PermissionLevel;
}): ToolDecision {
  const permission = options.permission ?? "acceptEdits";
  if (options.toolName === "AskUserQuestion") return "ask";
  if (permission === "bypassPermissions") return "allow";
  if (permission === "auto") return "ask";

  const outside = leavesWorkspace(options);
  if (permission === "plan") {
    if (outside || !READ_TOOLS.has(options.toolName)) return "deny";
    return "allow";
  }
  if (outside) return "ask";
  if (permission === "default") {
    return READ_TOOLS.has(options.toolName) ? "allow" : "ask";
  }

  if (options.toolName === "Bash") {
    const command = typeof options.input.command === "string" ? options.input.command : "";
    if (commandEscapes(command, options.cwd)) return "ask";
    return "allow";
  }
  if (!AUTO_TOOLS.has(options.toolName)) return "ask";
  return "allow";
}

export function denyMessage(permission: PermissionLevel): string {
  if (permission === "plan") return "当前是只规划，不能修改文件、执行命令或访问工作区外的路径";
  return "当前授权级别拒绝了这次操作";
}

function leavesWorkspace(options: {
  input: Record<string, unknown>;
  cwd: string;
  blockedPath?: string;
}): boolean {
  const inside = insideChecker(options.cwd);
  if (options.blockedPath && !inside(options.blockedPath)) return true;
  return pathFields(options.input).some((item) => !inside(item));
}

/**
 * 同一次判断里复用已解析的工作区根目录：第一次路径检查时才解析，
 * 解析失败后后续检查一律按“不在工作区内”处理。
 */
function insideChecker(cwd: string): (candidate: string) => boolean {
  let resolvedRoot: string | null | undefined;
  return (candidate: string) => {
    if (!candidate.trim()) return true;
    if (resolvedRoot === undefined) {
      try {
        resolvedRoot = resolveRealPath(path.resolve(cwd));
      } catch {
        resolvedRoot = null;
      }
    }
    if (resolvedRoot === null) return false;
    return isInsideResolved(resolvedRoot, candidate);
  };
}

export function isInside(root: string, candidate: string): boolean {
  if (!candidate.trim()) return true;
  try {
    return isInsideResolved(resolveRealPath(path.resolve(root)), candidate);
  } catch {
    // 权限判断本身不能抛错：解析失败时按“不在工作区内”处理，交给用户确认。
    return false;
  }
}

/** 工作区根目录已解析后的判定，避免每次候选路径都重复 realpath 同一个 cwd。 */
function isInsideResolved(resolvedRoot: string, candidate: string): boolean {
  if (!candidate.trim()) return true;
  try {
    // 不能先 path.resolve(candidate)：那会把 `link/..` 文本折叠掉，而内核是
    // 先跟随软链接再处理 `..`。保留原始相对路径交给 realpath 解析。
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : `${resolvedRoot}${path.sep}${candidate}`;
    return isWithin(resolvedRoot, resolveRealPath(absolute));
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/**
 * 解析路径的真实位置：先整体 realpath；不存在时解析父目录再把最后一段拼回。
 * 父目录由 realpath 处理，因此 `link/../x` 会按内核语义（先跟随软链接）判断。
 */
function resolveRealPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch (error) {
    // 只有“不存在”可以继续解析父目录；权限/循环链接等一律按不可解析处理。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // realpath 失败但该位置是软链接，说明链接目标不存在。此时不能按文本路径
  // 当作工作区内，否则 Write 会穿过悬空链接在外部创建文件。
  const stat = lstatOrNull(target);
  if (stat?.isSymbolicLink()) throw new Error("无法解析软链接目标");
  const parent = path.dirname(target);
  if (parent === target) return target;
  const resolvedParent = resolveRealPath(parent);
  const base = path.basename(target);
  if (base === "..") return path.dirname(resolvedParent);
  if (!base || base === ".") return resolvedParent;
  return path.join(resolvedParent, base);
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pathFields(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PATH_FIELDS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) found.push(value);
  }
  return found;
}

const SHELL_WORD = /(?:^|[\s;&|(])(?:(?:ba|da|k|z|c|tc)?sh|fish)(?=[\s;&|)]|$)/;
const EVAL_XARGS = /(?:^|[\s;&|(])(?:eval|xargs)(?=[\s;&|)]|$)/;
// awk/gawk 等文本工具也图灵完备，但太常用；先把它们视为已知启发式边界。
const INTERPRETERS =
  /^(?:python[0-9.]*|node(?:js)?|deno|bun|perl|ruby|php|lua|rscript|tclsh)$/i;
const WRAPPERS = new Set([
  "sudo", "env", "time", "timeout", "nice", "exec", "command", "nohup", "npx", "xargs", "busybox", "find",
  "bash", "sh", "dash", "zsh", "ksh", "csh", "tcsh", "fish",
]);

function isInterpreterName(name: string): boolean {
  return INTERPRETERS.test(name);
}

/**
 * 解释器出现在命令位置（或 shell/包装器之后）时，无法可靠判断它会访问什么。
 * 去掉引号/反斜杠后按命令分隔符切段，跳过环境变量赋值，再看命令词。
 */
function hasInlineInterpreter(stripped: string): boolean {
  const scan = stripped.replace(/\n/g, ";");
  for (const raw of scan.split(/[;|&(){}]+/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
    if (index >= tokens.length) continue;
    const first = tokens[index].split("/").pop() ?? tokens[index];
    if (isInterpreterName(first)) return true;
    if (!WRAPPERS.has(first)) continue;
    if (first === "find" && !tokens.some((token) => token === "-exec" || token === "-execdir")) {
      continue;
    }
    for (const token of tokens.slice(index + 1)) {
      const name = token.split("/").pop() ?? token;
      if (isInterpreterName(name)) return true;
    }
  }
  return false;
}

export function commandEscapes(command: string, cwd: string): boolean {
  // 引号和反斜杠只去掉一次，内联解释器判断和 shell 词识别共用。
  const shellScan = command.replace(/["'\\]/g, "");
  // 内联执行任意代码时无法可靠判断它会访问什么，直接要求确认。
  if (hasInlineInterpreter(shellScan)) return true;
  // `bash -c '...'`/`eval`/`xargs` 会让内层重新展开。
  // shellScan 已经去掉引号和反斜杠（`"ba""sh"`、`b\ash` 等）。
  const nestedShell = SHELL_WORD.test(shellScan) || EVAL_XARGS.test(shellScan);
  if (nestedShell) {
    if (command.includes("$") || command.includes("`") || command.includes("~")) return true;
  } else if (hasExpansion(command)) {
    return true;
  }
  if (/<\(|>\(/.test(command)) return true;
  // 按 shell 语义去除引号并反转义，再做路径判断。
  const withoutUrls = stripUrls(removeQuotes(command));
  // ~ 的引号语义必须基于原始命令。
  if (hasUnquotedTilde(command)) return true;
  // 单引号内不是路径；转义引号不能当作引号分隔符。花括号展开用逗号分隔参数。
  if (/(^|[\s"'=<>|&();{},])\/\//.test(maskSingleQuoted(command))) return true;
  // file:/etc/passwd 和 file:///etc/passwd 都要检查路径。
  const inside = insideChecker(cwd);
  for (const match of withoutUrls.matchAll(/\bfile:([^\s"'`<>|;&()]*)/gi)) {
    const value = match[1] ?? "";
    if (value && !inside(value)) return true;
  }
  // 覆盖 `../x`、`./../../x`、`foo/../../x`、`>../x` 等所有含 `..` 路径段的形式。
  if (/(^|[\s"'`=/\\<>|&();{},])\.\.([/\\]|$)/.test(withoutUrls)) return true;
  for (const item of absolutePaths(withoutUrls)) {
    if (!inside(item)) return true;
  }
  for (const token of shellTokens(withoutUrls)) {
    if (!token) continue;
    // 根目录本身不在任何工作区内。
    if (token === "/") return true;
    if (token.startsWith("-")) {
      // `--opt=value`：只看等号后的值，避免把相对路径当成 `/...`。
      const eq = token.indexOf("=");
      if (eq >= 0) {
        const value = token.slice(eq + 1);
        if (value && !value.startsWith("-") && !inside(value)) return true;
        continue;
      }
      // `-f/etc/passwd`、`-I./include`：从选项前缀后的第一个路径起始字符开始。
      const pathStart = token.search(/[.~]|[/\\]/);
      if (pathStart >= 0 && !inside(token.slice(pathStart))) return true;
      // `-Iinclude`、`-ooutfile`：值直接粘在选项字母后，也可能是软链接。
      for (const glued of [token.slice(1), token.slice(2)]) {
        if (glued && !glued.startsWith("-") && !inside(glued)) return true;
      }
      continue;
    }
    // 相对参数统一交给 realpath 判断，中间目录/末尾是软链接都能识别。
    if (!token.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(token)) {
      if (!inside(token)) return true;
    }
  }
  return false;
}

/** 清空单引号区段，并把转义字符当作字面值；用于 `//` 路径判断。 */
function maskSingleQuoted(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
        out += "'";
      } else {
        out += " ";
      }
      continue;
    }
    if (quote === '"') {
      // 双引号内的单引号是字面量，不能开启单引号区。
      out += char;
      if (char === "\\") {
        const next = command[index + 1];
        if (next !== undefined) {
          out += next;
          index += 1;
        }
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        // 转义引号不能当作引号分隔符。
        out += next === "'" || next === '"' ? "_" : next;
        index += 1;
        continue;
      }
    }
    if (char === "'") {
      quote = "'";
      out += "'";
      continue;
    }
    if (char === '"') {
      quote = '"';
      out += '"';
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * 按 shell 语义移除引号并反转义：`li''nk` → `link`，`\.\./x` → `../x`。
 * 单引号内的内容原样保留（反斜杠无转义语义）。
 */
function removeQuotes(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else out += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        const next = command[index + 1];
        if (next !== undefined) {
          out += next;
          index += 1;
        }
      } else {
        out += char;
      }
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        out += next;
        index += 1;
        continue;
      }
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    out += char;
  }
  return out;
}

/** 未加引号（或仅在双引号中）的 $ 展开和反引号。 */
function hasExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    // 单引号内反斜杠没有转义语义，必须先判断引号状态。
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (char === "$") {
      const next = command[index + 1] ?? "";
      // `$'...'`（ANSI-C 引用）也会展开，因此把单引号也算进来。
      if (/[A-Za-z0-9_{($?#@*!-']/.test(next)) return true;
    }
    if (char === "`") return true;
  }
  return false;
}

function hasUnquotedTilde(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let wordStart = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/[\s;|&<>()]/.test(char)) {
      wordStart = index + 1;
      continue;
    }
    if (char === "~") {
      const prev = command[index - 1];
      if (!prev || /[\s:(,;|&]/.test(prev)) return true;
      if (prev === "=") {
        // `foo=~/x` 会展开；`--out=~/x` 不会。
        const word = command.slice(wordStart, index - 1);
        if (!word.startsWith("-")) return true;
      }
    }
  }
  return false;
}

function shellTokens(command: string): string[] {
  return command.split(/[\s"'`;|&<>(){},]+/);
}

function stripUrls(command: string): string {
  // 剥掉网络协议（file:// 除外，留给 `//` 和路径检查）；限制字符集，
  // 避免把紧贴 URL 的 `>` 重定向一起吞掉。
  return command.replace(/\b(?!file:)[a-z][a-z0-9+.-]+:\/\/[^\s<>|;&()'"]+/gi, " ");
}

/** 调用方传入的命令已经过 stripUrls 处理。 */
function absolutePaths(stripped: string): string[] {
  const found: string[] = [];
  // 路径也可能紧跟在重定向/管道/花括号展开等 shell 元字符后面。
  const pattern = /(?:^|[\s"'`=<>|&();{},])((?:\/(?!\/)[^\s"'`]+)|(?:[A-Za-z]:[\\/][^\s"'`]+))/g;
  for (const match of stripped.matchAll(pattern)) {
    const value = match[1];
    if (value) found.push(value);
  }
  return found;
}
