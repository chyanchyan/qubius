import { execFileSync } from "node:child_process";
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
    if (commandNeedsReview(command, options.cwd)) return "ask";
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

/**
 * acceptEdits 下仍需人工确认的「会执行未审阅代码」的命令。
 *
 * `commandEscapes` 只看命令会不会碰到工作区外；这里补上第二类风险：命令本身
 * 会执行一段用户还没确认过的脚本，或者会被仓库里的钩子/脚本定义改变。
 *
 * 只在命令命中相应形态时才调用 git（同步、800ms 超时），普通命令没有额外开销。
 * 非 git 工作区不做仓库状态检查，避免普通对话目录里的 `./x.sh` 无端要确认；
 * 但 git 超时/异常时按需要确认处理（fail closed），不静默放行。
 */
export function commandNeedsReview(command: string, cwd: string): boolean {
  if (!command.trim()) return false;
  return commandsNeedReview(parseShell(command), cwd, 0);
}

const MAX_SPLIT_DEPTH = 8;

function commandsNeedReview(parsed: ParsedShell, cwd: string, depth: number): boolean {
  if (depth > MAX_SPLIT_DEPTH) return true;
  const commands = parsed.commands;
  if (hasNestedExecution(commands)) return true;

  const executed = new Set<string>();
  const inputSources = new Set<string>();
  const written = writtenScripts(commands, cwd);
  let inlineInput = false;
  let checkPackages = false;
  let checkMake = false;
  let checkHooks = false;

  for (const simple of commands) {
    // `env -S 'bash -c ...'` 的参数本身就是命令：把 split 值 + 后续参数 +
    // 外层重定向合成内层命令后递归判定；无法安全合成时保守 ask。
    const split = envSplitString(simple.words);
    if (split !== undefined) {
      const nested = parseShell(split.value);
      if (nested.error || nested.commands.length === 0) return true;
      // 后续参数会被 env 追加给内层命令，语义难以安全判定：保守 ask。
      if (split.tail.length > 0) return true;
      const composed = appendToCommands(
        nested,
        simple.redirects,
        simple.separator === "|" || simple.pipedGroup === true,
      );
      if (commandsNeedReview(composed, cwd, depth + 1)) return true;
      continue;
    }
    const word = commandWord(simple.words);
    if (!word) continue;
    // 解释器从 stdin/herestring/heredoc 读脚本：内容不在命令词里。
    if (isInterpreter(word.name)) {
      for (const redirect of simple.redirects) {
        if (redirect.op === "<") {
          inputSources.add(path.resolve(cwd, redirect.target));
        } else if (redirect.op === "<<<" || redirect.op === "<<" || redirect.op === "<<-") {
          inlineInput = true;
        }
      }
    }
    for (const script of scriptTargets(simple.words, word.index, word.name, cwd)) {
      executed.add(script);
    }
    if (PACKAGE_MANAGERS.has(word.name)) checkPackages = true;
    if (MAKE_COMMANDS.has(word.name)) checkMake = true;
    if (word.name === "git") {
      const subcommand = gitSubcommand(simple.words.slice(word.index + 1));
      if (subcommand && GIT_HOOK_COMMANDS.has(subcommand)) checkHooks = true;
    }
  }

  // 内联脚本（herestring/heredoc）无法预先审阅，直接确认。
  if (inlineInput) return true;
  // 同一条命令里先写脚本再执行/喂给解释器：内容还没进过仓库，直接确认。
  for (const script of executed) {
    if (written.has(script)) return true;
  }
  for (const source of inputSources) {
    if (written.has(source)) return true;
  }

  const existing = [...executed].filter((script) => isFile(script));
  if (
    existing.length === 0
    && inputSources.size === 0
    && !checkPackages
    && !checkMake
    && !checkHooks
  ) {
    return false;
  }

  const repo = gitWorktreeState(cwd);
  // 只有 git 明确报告“不是仓库”才跳过普通脚本检查；输入重定向的来源
  // 无法判断是否已审阅，此时仍然要确认。
  if (repo === "not-a-repo") return inputSources.size > 0;
  if (repo === "error") return true;
  if (existing.length > 0 && hasUncommitted(cwd, existing)) return true;
  if (inputSources.size > 0) {
    for (const source of inputSources) {
      // 文件不存在或状态读不到都算“无法判断”。
      if (!isFile(source) || hasUncommitted(cwd, [source])) return true;
    }
  }
  if (checkPackages && hasUncommitted(cwd, ["package.json", "package-lock.json"])) return true;
  if (checkMake && hasUncommitted(cwd, ["Makefile", "makefile", "GNUmakefile"])) return true;
  if (checkHooks && gitHooksNeedReview(cwd)) return true;
  return false;
}

interface SimpleCommand {
  /** 去引号、处理转义后的词。 */
  words: string[];
  /** 这条命令前面的分隔符；第一条没有。 */
  separator?: "|" | "||" | "&&" | ";" | "&" | "newline" | "(" | ")" | "{" | "}";
  /** 输出重定向等；target 已去引号。 */
  redirects: Array<{ op: string; target: string }>;
  /** 位于管道下游的复合组（`... | ( ... )`、`... | { ...; }`）内部。 */
  pipedGroup?: boolean;
}

interface ParsedShell {
  commands: SimpleCommand[];
  /** 引号/heredoc 未闭合等解析问题；用于 env -S 参数判定（解析不了就 ask）。 */
  error: boolean;
}

/**
 * 轻量 shell 解析：按引号/转义规则切出简单命令、词和重定向目标。
 * heredoc 正文会整段跳过，避免把正文里的命令当成真实执行。
 */
function parseShell(command: string): ParsedShell {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let redirects: Array<{ op: string; target: string }> = [];
  let current = "";
  let hasCurrent = false;
  let quote: "'" | '"' | null = null;
  let pendingRedirect: string | null = null;
  let separator: SimpleCommand["separator"];
  let error = false;
  /** 当前是否位于管道下游的复合组内；栈保存各层进入前的状态。 */
  let pipedGroup = false;
  const groupStack: boolean[] = [];
  /** 尚未读取正文的 heredoc；按出现顺序逐个跳过。 */
  const heredocs: Array<{ marker: string; stripTabs: boolean }> = [];

  const flushWord = () => {
    if (!hasCurrent) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        heredocs.push({ marker: current, stripTabs: pendingRedirect === "<<-" });
      }
      redirects.push({ op: pendingRedirect, target: current });
      pendingRedirect = null;
    } else {
      words.push(current);
    }
    current = "";
    hasCurrent = false;
  };
  const flushCommand = (nextSeparator?: SimpleCommand["separator"]) => {
    flushWord();
    pendingRedirect = null;
    if (words.length > 0 || redirects.length > 0) {
      commands.push({
        words,
        separator,
        redirects,
        ...(pipedGroup ? { pipedGroup: true } : {}),
      });
      words = [];
      redirects = [];
    }
    separator = nextSeparator;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
        hasCurrent = true;
      } else {
        current += char;
        hasCurrent = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index += 1;
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (char === "\n") {
        flushCommand("newline");
        if (heredocs.length > 0) {
          const skipped = skipHeredocBodies(command, index + 1, heredocs);
          index = skipped.index - 1;
          if (!skipped.complete) error = true;
        }
      } else {
        flushWord();
      }
      continue;
    }
    if (char === ">") {
      let op = ">";
      if (command[index + 1] === ">") {
        op = ">>";
        index += 1;
      } else if (command[index + 1] === "|") {
        op = ">|";
        index += 1;
      }
      // `2>file` 里的 fd 数字不是命令词。
      if (hasCurrent && /^\d+$/.test(current)) {
        current = "";
        hasCurrent = false;
      }
      flushWord();
      pendingRedirect = op;
      continue;
    }
    if (char === "<") {
      // `<<<` herestring、`<<`/`<<-` heredoc、`<` 输入重定向。
      if (command[index + 1] === "<") {
        if (command[index + 2] === "<") {
          flushWord();
          pendingRedirect = "<<<";
          index += 2;
          continue;
        }
        flushWord();
        pendingRedirect = "<<";
        index += 1;
        if (command[index + 1] === "-") {
          pendingRedirect = "<<-";
          index += 1;
        }
        continue;
      }
      flushWord();
      pendingRedirect = "<";
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "|") {
        index += 1;
        flushCommand("||");
      } else if (command[index + 1] === "&") {
        // bash 的 `|&` 等价于管道（stdout+stderr 都送进下一段）。
        index += 1;
        flushCommand("|");
      } else {
        flushCommand("|");
      }
      continue;
    }
    if (char === "&") {
      if (command[index + 1] === "&") {
        index += 1;
        flushCommand("&&");
      } else {
        flushCommand("&");
      }
      continue;
    }
    if (char === ";") {
      flushCommand(";");
      continue;
    }
    if (char === "(" || char === "{") {
      // 组跟在管道后面时，把“位于管道下游”带进组内：`... | (sh)`。
      const piped: boolean = separator === "|" || pipedGroup;
      flushCommand();
      groupStack.push(pipedGroup);
      pipedGroup = piped;
      continue;
    }
    if (char === ")" || char === "}") {
      flushCommand();
      pipedGroup = groupStack.pop() ?? false;
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  flushCommand();
  if (quote !== null || heredocs.length > 0) error = true;
  return { commands, error };
}

/** 从 after 开始跳过所有 heredoc 正文，返回终止符之后的下标。 */
function skipHeredocBodies(
  command: string,
  after: number,
  heredocs: Array<{ marker: string; stripTabs: boolean }>,
): { index: number; complete: boolean } {
  let index = after;
  while (heredocs.length > 0) {
    const { marker, stripTabs } = heredocs[0]!;
    const lineEnd = command.indexOf("\n", index);
    const line = command.slice(index, lineEnd === -1 ? command.length : lineEnd);
    const normalized = stripTabs ? line.replace(/^\t+/, "") : line;
    if (normalized === marker) {
      heredocs.shift();
      index = lineEnd === -1 ? command.length : lineEnd + 1;
      continue;
    }
    if (lineEnd === -1) return { index: command.length, complete: false };
    index = lineEnd + 1;
  }
  return { index, complete: true };
}

/** 会把别处的文本送进解释器、或让内层重新展开的命令。 */
function hasNestedExecution(commands: SimpleCommand[]): boolean {
  for (const simple of commands) {
    const word = commandWord(simple.words);
    if (!word) continue;
    // eval/source 及其同义写法只在命令位置才算；`grep eval` 不误报。
    if (word.name === "eval" || word.name === "source" || word.name === ".") return true;
    const rest = simple.words.slice(word.index + 1);
    if (SHELL_COMMANDS.has(word.name)) {
      // `bash -c`/`sh -lc`/`bash --command ...`
      if (rest.some((token) => /^-[A-Za-z]*c$/.test(token) || token === "--command")) return true;
    }
    // 管道（含 `|&`）目标是 shell/解释器：`curl x | "sh"`、`... |& sudo bash`。
    if (simple.separator === "|" && isInterpreter(word.name)) return true;
    // 管道下游的复合组：`curl x | (sh)`、`... |& { sh; }`。
    if (simple.pipedGroup === true && isInterpreter(word.name)) return true;
    if (word.name === "xargs") {
      const operands = rest.filter((token) => !token.startsWith("-"));
      if (operands.some((token) => isInterpreter(baseName(token)))) return true;
    }
  }
  return false;
}

function isInterpreter(name: string): boolean {
  return SHELL_COMMANDS.has(name) || SCRIPT_COMMANDS.test(name);
}

const SHELL_COMMANDS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);
const SCRIPT_COMMANDS =
  /^(?:python[0-9.]*|node(?:js)?|deno|bun|perl|ruby|php|lua|rscript|tclsh)$/i;
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|ksh|dash|py|rb|pl|php|js|mjs|cjs|ts|lua)$/i;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const MAKE_COMMANDS = new Set(["make", "gmake"]);
const GIT_HOOK_COMMANDS = new Set(["commit", "push", "merge", "rebase", "am"]);
/** 出现在命令位置但本身只是包装器的命令；解析掉它们的参数后再看真正的命令词。 */
const COMMAND_WRAPPERS = new Set([
  "sudo", "env", "time", "nice", "nohup", "command", "exec", "timeout", "stdbuf", "setsid", "builtin",
]);
/** 这些包装器的选项带一个独立的值（`-u root`、`-n 5` 等）。 */
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-h", "--host", "-D", "--chdir", "--chroot"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  exec: new Set(["-a"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
};

/**
 * 一个选项词占用几个 token：2 表示值在下一个词里（`-u root`、
 * `-o L`、紧凑写法 `-Eu root` 的最后一个字母带值），1 表示只有它自己
 * （值粘在选项里，如 `-uroot`、`-sKILL`）。
 */
function optionArity(token: string, valueOptions: ReadonlySet<string>): number {
  if (valueOptions.has(token)) return 2;
  if (/^-[A-Za-z]+$/.test(token)) {
    for (let position = 1; position < token.length; position += 1) {
      if (!valueOptions.has(`-${token[position]}`)) continue;
      return position === token.length - 1 ? 2 : 1;
    }
  }
  return 1;
}

function baseName(token: string): string {
  return token.split(/[/\\]/).pop() || token;
}

/** 跳过包装器自身的选项和操作数，返回真正命令词的下标。 */
function skipWrapperOperands(tokens: string[], start: number, name: string): number {
  let index = start;
  if (name === "timeout") {
    // timeout [选项] <时长> <命令>
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      index += optionArity(tokens[index]!, WRAPPER_VALUE_OPTIONS.timeout!);
    }
    if (index < tokens.length) index += 1;
    return index;
  }
  if (name === "nice") {
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === "--") return index + 1;
      if (token === "-n" || token === "--adjustment") {
        index += 2;
        continue;
      }
      if (/^-\d+$/.test(token) || /^-n\d+$/.test(token) || token.startsWith("--adjustment=")) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      return index;
    }
    return index;
  }
  if (name === "env") {
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === "--") return index + 1;
      if (WRAPPER_VALUE_OPTIONS.env!.has(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith("--unset=") || token.startsWith("--chdir=") || token.startsWith("--split-string=")) {
        index += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      return index;
    }
    return index;
  }
  const valueOptions = WRAPPER_VALUE_OPTIONS[name] ?? EMPTY_OPTIONS;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") return index + 1;
    if (token.startsWith("-")) {
      index += optionArity(token, valueOptions);
      continue;
    }
    return index;
  }
  return index;
}

interface EnvSplit {
  /** `-S`/`--split-string` 的值（命令串）。 */
  value: string;
  /** 该值之后、仍属于同一条简单命令的参数；env 会把它们追加给内层命令。 */
  tail: string[];
}

/** xargs 中带独立值的选项，用于跳过它们再找嵌套的 env。 */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-I", "--replace", "-n", "--max-args", "-P", "--max-procs", "-L", "--max-lines",
  "-s", "--max-chars", "-d", "--delimiter", "-E", "--eof", "-a", "--arg-file",
  "-J", "--max-lines", "-R",
]);

/**
 * 定位命令位置上的 env（可穿过包装器、xargs、嵌套 env），并取出
 * `-S`/`--split-string` 的值与后续参数。`--` 之后的都不是 env 选项。
 */
function envSplitString(tokens: string[]): EnvSplit | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    const name = baseName(token);
    if (name === "env") {
      const split = readEnvSplitString(tokens, index + 1);
      if (split !== undefined) return split;
      // 这一层 env 没有 -S：继续看它包着的（可能仍是 env）命令。
      index = skipWrapperOperands(tokens, index + 1, "env");
      continue;
    }
    if (name === "xargs") {
      let position = index + 1;
      while (position < tokens.length && tokens[position]!.startsWith("-")) {
        position += optionArity(tokens[position]!, XARGS_VALUE_OPTIONS);
      }
      const nested = envSplitString(tokens.slice(position));
      if (nested !== undefined) return nested;
      return undefined;
    }
    if (!COMMAND_WRAPPERS.has(name)) return undefined;
    index = skipWrapperOperands(tokens, index + 1, name);
  }
  return undefined;
}

function readEnvSplitString(tokens: string[], start: number): EnvSplit | undefined {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    // `--` 之后都是普通参数，不能再当作 env 选项。
    if (token === "--") return undefined;
    if (token === "-S" || token === "--split-string") {
      const value = tokens[index + 1];
      return { value: value ?? "", tail: value === undefined ? [] : tokens.slice(index + 2) };
    }
    if (token.startsWith("--split-string=")) {
      return { value: token.slice("--split-string=".length), tail: tokens.slice(index + 1) };
    }
    if (token.startsWith("-S") && token.length > 2) {
      return { value: token.slice(2), tail: tokens.slice(index + 1) };
    }
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * 把 env 的外层重定向和“位于管道下游”的上下文并进 split 出的内层命令。
 * 后续参数不在这里合并：调用方遇到 tail 会保守 ask。
 */
function appendToCommands(
  parsed: ParsedShell,
  redirects: Array<{ op: string; target: string }>,
  downstream: boolean,
): ParsedShell {
  const commands = parsed.commands.map((command) => ({
    ...command,
    words: [...command.words],
    redirects: [...command.redirects],
    ...(downstream && command.pipedGroup !== true ? { pipedGroup: true } : {}),
  }));
  const last = commands[commands.length - 1];
  if (last) {
    last.redirects.push(...redirects);
  } else {
    commands.push({
      words: [],
      redirects: [...redirects],
      ...(downstream ? { pipedGroup: true } : {}),
    });
  }
  if (downstream && commands[0] && commands[0].separator === undefined) {
    commands[0].separator = "|";
  }
  return { commands, error: parsed.error };
}

const EMPTY_OPTIONS: ReadonlySet<string> = new Set();

/** 跳过环境变量赋值、选项和包装器，找到真正执行的命令词。 */
function commandWord(tokens: string[]): { index: number; name: string } | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    const name = baseName(token);
    if (COMMAND_WRAPPERS.has(name)) {
      index = skipWrapperOperands(tokens, index + 1, name);
      continue;
    }
    return { index, name };
  }
  return undefined;
}

/**
 * 这段简单命令会执行的脚本路径（解析成绝对路径）。
 * 只有命令位置是解释器，或命令词本身就是 `./x.sh` 这类脚本时才计入；
 * 是否真的存在由调用方再判断（不存在的脚本可能刚被同一命令写入）。
 */
function scriptTargets(tokens: string[], index: number, name: string, cwd: string): string[] {
  const first = tokens[index] ?? "";
  let candidate: string | undefined;
  if (isInterpreter(name)) {
    if (tokens.slice(index + 1).some((token) => /^-[A-Za-z]*c$/.test(token) || token === "--command")) {
      // `bash -c ...` 里的参数不是脚本文件。
      return [];
    }
    for (let position = index + 1; position < tokens.length; position += 1) {
      const token = tokens[position]!;
      if (token.startsWith("-")) continue;
      candidate = token;
      break;
    }
  } else if (first.startsWith("./") || first.startsWith("../") || SCRIPT_EXTENSIONS.test(name)) {
    candidate = first;
  }
  if (!candidate) return [];
  return [path.resolve(cwd, candidate)];
}

/** 同一条命令里被写入的脚本路径：`>/>>` 目标和 tee 的普通参数。 */
function writtenScripts(commands: SimpleCommand[], cwd: string): Set<string> {
  const written = new Set<string>();
  for (const simple of commands) {
    for (const redirect of simple.redirects) {
      if (redirect.op === ">" || redirect.op === ">>" || redirect.op === ">|") {
        written.add(path.resolve(cwd, redirect.target));
      }
    }
    const word = commandWord(simple.words);
    if (!word || word.name !== "tee") continue;
    for (const token of simple.words.slice(word.index + 1)) {
      if (token.startsWith("-")) continue;
      written.add(path.resolve(cwd, token));
    }
  }
  return written;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 取 git 子命令：跳过选项；`-C`/`-c` 这类带值的选项连值一起跳过。 */
function gitSubcommand(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (GIT_VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const GIT_TIMEOUT_MS = 800;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // 消息固定英文，便于区分“不是 git 仓库”和其它错误。
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return { ok: true, stdout: String(stdout), stderr: "" };
  } catch (error) {
    const record = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: gitText(record.stdout), stderr: gitText(record.stderr) };
  }
}

function gitText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

type GitWorktreeState = "worktree" | "not-a-repo" | "error";

function gitWorktreeState(cwd: string): GitWorktreeState {
  // 工作目录本身不存在（列目录阶段就会给出可读错误）时不把 git 的 ENOENT
  // 当成仓库损坏；这里没有可执行的脚本，按“不在仓库里”跳过。其它 stat
  // 失败仍按错误处理（fail closed）。
  try {
    if (!fs.statSync(cwd).isDirectory()) return "error";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not-a-repo";
    return "error";
  }
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (result.ok) return result.stdout.trim() === "true" ? "worktree" : "error";
  if (isNotARepository(result.stderr)) return "not-a-repo";
  // 超时、git 不存在、仓库损坏等一律 fail closed。
  return "error";
}

function isNotARepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** 这些路径有未跟踪或未提交改动时返回 true；git 失败按有改动处理（fail closed）。 */
function hasUncommitted(cwd: string, files: string[]): boolean {
  const result = runGit(cwd, ["status", "--porcelain", "--", ...files]);
  if (!result.ok) return true;
  return result.stdout.trim().length > 0;
}

/**
 * hooks 目录里存在非 `.sample` 且可执行的文件（可能改变 commit/push 行为）。
 * hooks 目录不存在视为没有 hook；读取失败按需要确认处理（fail closed）。
 */
function gitHooksNeedReview(cwd: string): boolean {
  const result = runGit(cwd, ["rev-parse", "--git-path", "hooks"]);
  if (!result.ok) return !isNotARepository(result.stderr);
  const hooksDir = path.resolve(cwd, result.stdout.trim());
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(hooksDir, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".sample")) continue;
    try {
      const stat = fs.statSync(path.join(hooksDir, entry.name));
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return true;
    } catch {
      // 悬空链接等读不到的文件不当作有效 hook。
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
