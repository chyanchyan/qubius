#!/usr/bin/env node
// qubius 本机命令行：通过 HTTP API 创建会话、发消息、等待结果。
// 用法见 USAGE；--json 时 stdout 只输出 JSON，诊断信息走 stderr。
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  QubiusApiError,
  createClient,
  resolveRunOptions,
  waitForSession,
} from "./qubius-client.mjs";

const BOOLEAN_FLAGS = new Set(["json", "wait", "interject", "help"]);
const VALUE_FLAGS = new Set([
  "url",
  "token",
  "project",
  "prompt",
  "provider",
  "model",
  "effort",
  "title",
  "workflow",
  "timeout",
]);

const USAGE = `用法：qubius <命令> [参数]

命令：
  project list
  session list --project <id>
  session show <id>
  session create --project <id> --prompt <文本|-> [--provider <id>] [--model <m>] [--effort <e>] [--title <t>] [--workflow <w>]
  session send <id> <文本|-> [--interject] [--wait] [--timeout <秒>]
  session wait <id> [--timeout <秒>]
  session stop <id>
  schedule list --project <id>
  schedule run <project> <schedule>

全局参数：
  --json             只输出 JSON
  --url <地址>       服务地址（默认 http://127.0.0.1:8787，或 QUBIUS_URL）
  --token <令牌>     访问令牌（或 QUBIUS_TOKEN / QUBIUS_AUTH_TOKEN / QUBIUS_TOKEN_FILE）

参数值写 \`-\` 时从 stdin 读取正文。`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/** 解析 --flag、--flag=value、布尔开关和位置参数。 */
export function parseArgs(argv = []) {
  const positionals = [];
  const flags = {};
  let endOfFlags = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (endOfFlags) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--") && arg.length > 2) {
      const equal = arg.indexOf("=");
      const name = equal === -1 ? arg.slice(2) : arg.slice(2, equal);
      const inline = equal === -1 ? undefined : arg.slice(equal + 1);

      if (BOOLEAN_FLAGS.has(name)) {
        if (inline !== undefined) throw new UsageError(`--${name} 不接受值`);
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`未知参数 --${name}`);
      if (inline !== undefined) {
        flags[name] = inline;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--") && next.length > 2)) {
        throw new UsageError(`--${name} 需要一个值`);
      }
      flags[name] = next;
      index += 1;
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

/** 把 argv 拆成一级命令、二级命令、位置参数和开关。 */
export function parseCommand(argv = []) {
  const { positionals, flags } = parseArgs(argv);
  const [group, action, ...rest] = positionals;
  if (!group) throw new UsageError("缺少命令");
  if (!action) throw new UsageError(`缺少子命令：${group}`);
  return { group, action, rest, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`缺少 --${name}`);
  return value;
}

function requireArg(rest, index, label) {
  const value = rest[index];
  if (typeof value !== "string" || !value) throw new UsageError(`缺少参数 ${label}`);
  return value;
}

function noExtraArgs(rest, expected, label) {
  if (rest.length > expected) throw new UsageError(`${label} 不接受多余的位置参数`);
}

function readTimeout(flags, fallback = 600) {
  if (flags.timeout === undefined) return fallback;
  const value = Number(flags.timeout);
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError("--timeout 必须是非负秒数");
  }
  return value;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveText(value, readStdin) {
  if (value === "-") return readStdin();
  return value;
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function oneLine(value, limit = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatSession(session) {
  return `${session?.id ?? "?"}\t${session?.phase ?? "?"}\t${oneLine(session?.title)}`;
}

function printSessionDetail(session, stream) {
  stream.write(`id: ${session?.id ?? ""}\n`);
  stream.write(`project: ${session?.projectId ?? ""}\n`);
  stream.write(`phase: ${session?.phase ?? ""}\n`);
  stream.write(`title: ${session?.title ?? ""}\n`);
  stream.write(`model: ${session?.providerId ?? ""}/${session?.model ?? ""} (${session?.effort ?? ""})\n`);
  if (session?.branch) stream.write(`branch: ${session.branch}\n`);
  if (session?.cwd) stream.write(`cwd: ${session.cwd}\n`);
  if (session?.lastError) stream.write(`error: ${session.lastError}\n`);
}

/** 等待结果映射为退出码：completed 0，needs_input 2，超时 3，其余 1。 */
export function exitCodeForWait({ phase, timedOut }) {
  if (timedOut) return 3;
  if (phase === "needs_input") return 2;
  if (phase === "completed") return 0;
  return 1;
}

function reportWait(result, flags, stdout, stderr) {
  const code = exitCodeForWait(result);
  if (flags.json) {
    writeJson(stdout, {
      phase: result.phase,
      timedOut: result.timedOut,
      session: result.session,
    });
  } else if (result.session) {
    stdout.write(`${formatSession(result.session)}\n`);
  }
  if (result.timedOut) {
    stderr.write("qubius: 等待超时，对话还没有结束\n");
  } else if (result.phase === "needs_input") {
    stderr.write("qubius: 对话需要人工输入\n");
  }
  return code;
}

/**
 * 执行一次 CLI。返回退出码；所有可预期错误都转换成 stderr + 退出码。
 * options 可注入 client、stdout/stderr、env、readStdin，方便测试。
 */
export async function runCli(argv = [], options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const readStdin = options.readStdin ?? (() => readStream(process.stdin));

  try {
    // 先单独看 --help：此时可能只给了这一个参数，还没有命令。
    if (parseArgs(argv).flags.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const { group, action, rest, flags } = parseCommand(argv);
    const client = options.client ?? createClient(flags, env);

    if (group === "project" && action === "list") {
      noExtraArgs(rest, 0, "project list");
      const projects = await client.listProjects();
      if (flags.json) writeJson(stdout, projects);
      else {
        for (const project of projects) {
          stdout.write(`${project.id}\t${project.name}\t${project.path ?? ""}\n`);
        }
      }
      return 0;
    }

    if (group === "session" && action === "list") {
      noExtraArgs(rest, 0, "session list");
      const projectId = requireFlag(flags, "project");
      const sessions = await client.listProjectSessions(projectId);
      if (flags.json) writeJson(stdout, sessions);
      else {
        for (const session of sessions) stdout.write(`${formatSession(session)}\n`);
      }
      return 0;
    }

    if (group === "session" && action === "show") {
      noExtraArgs(rest, 1, "session show");
      const id = requireArg(rest, 0, "<id>");
      const session = await client.getSession(id);
      if (flags.json) writeJson(stdout, session);
      else printSessionDetail(session, stdout);
      return 0;
    }

    if (group === "session" && action === "create") {
      noExtraArgs(rest, 0, "session create");
      const projectId = requireFlag(flags, "project");
      if (flags.prompt === undefined) throw new UsageError("缺少 --prompt");
      const prompt = await resolveText(flags.prompt, readStdin);
      if (!prompt.trim()) throw new UsageError("--prompt 不能为空");
      const run = await resolveRunOptions(client, {
        provider: flags.provider,
        model: flags.model,
        effort: flags.effort,
      });
      const payload = { prompt, ...run };
      if (flags.title) payload.title = flags.title;
      if (flags.workflow) payload.workflow = flags.workflow;
      const session = await client.createSession(projectId, payload);
      if (flags.json) writeJson(stdout, session);
      else stdout.write(`${formatSession(session)}\n`);
      return 0;
    }

    if (group === "session" && action === "send") {
      noExtraArgs(rest, 2, "session send");
      const id = requireArg(rest, 0, "<id>");
      const text = await resolveText(requireArg(rest, 1, "<文本|->"), readStdin);
      const payload = { prompt: text };
      if (flags.interject) payload.interject = true;
      const session = await client.sendMessage(id, payload);
      if (!flags.wait) {
        if (flags.json) writeJson(stdout, session);
        else stdout.write(`${formatSession(session)}\n`);
        return 0;
      }
      const result = await waitForSession({
        getSession: client.getSession,
        id,
        timeoutSec: readTimeout(flags),
        intervalMs: options.intervalMs,
        sleep: options.sleep,
        now: options.now,
      });
      return reportWait(result, flags, stdout, stderr);
    }

    if (group === "session" && action === "wait") {
      noExtraArgs(rest, 1, "session wait");
      const id = requireArg(rest, 0, "<id>");
      const result = await waitForSession({
        getSession: client.getSession,
        id,
        timeoutSec: readTimeout(flags),
        intervalMs: options.intervalMs,
        sleep: options.sleep,
        now: options.now,
      });
      return reportWait(result, flags, stdout, stderr);
    }

    if (group === "session" && action === "stop") {
      noExtraArgs(rest, 1, "session stop");
      const id = requireArg(rest, 0, "<id>");
      const session = await client.stopSession(id);
      if (flags.json) writeJson(stdout, session);
      else stdout.write(`${formatSession(session)}\n`);
      return 0;
    }

    if (group === "schedule" && action === "list") {
      noExtraArgs(rest, 0, "schedule list");
      const projectId = requireFlag(flags, "project");
      const schedules = await client.listSchedules(projectId);
      if (flags.json) writeJson(stdout, schedules);
      else {
        for (const schedule of schedules) {
          const state = schedule.enabled ? "on" : "off";
          stdout.write(
            `${schedule.id}\t${state}\t${schedule.intervalMinutes}m\t${oneLine(schedule.prompt, 60)}\n`,
          );
        }
      }
      return 0;
    }

    if (group === "schedule" && action === "run") {
      noExtraArgs(rest, 2, "schedule run");
      const projectId = requireArg(rest, 0, "<project>");
      const scheduleId = requireArg(rest, 1, "<schedule>");
      const result = await client.runSchedule(projectId, scheduleId);
      if (flags.json) writeJson(stdout, result);
      else {
        stdout.write(`ran ${result?.scheduleId ?? scheduleId} session ${result?.sessionId ?? "-"}\n`);
      }
      return 0;
    }

    throw new UsageError(`未知命令：${group} ${action}`);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`qubius: ${error.message}\n\n${USAGE}\n`);
      return 1;
    }
    if (error instanceof QubiusApiError) {
      const status = error.status ? ` (HTTP ${error.status})` : "";
      stderr.write(`qubius: ${error.message}${status}\n`);
      return 1;
    }
    stderr.write(`qubius: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`qubius: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
