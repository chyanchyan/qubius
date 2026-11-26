import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * 开发机命令行：每个浏览器连接对应一个真实的 PTY（node-pty）。
 * 页面上的输入原样写入 PTY，PTY 输出原样回传，因此 vim/top 之类的
 * 全屏交互程序也能正常工作。
 */

/** 同时最多几个终端；超出的连接在握手后立刻收到错误并关闭。 */
export const DEFAULT_MAX_TERMINALS = 4;
/** 浏览器一条 input 消息的最大字符数；超出视为异常客户端，直接丢弃。 */
export const MAX_INPUT_CHARS = 100_000;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
const MIN_DIMENSION = 2;
const MAX_COLS = 500;
const MAX_ROWS = 300;

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

/** node-pty 的 IPty 里我们实际用到的子集，测试可以注入假的实现。 */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: PtyExit) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** 暂停/恢复读取 PTY 输出；浏览器读得慢时靠它把背压传回 shell。 */
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type PtySpawner = (options: PtySpawnOptions) => PtyProcess;

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: "ready"; id: string; shell: string; cwd: string }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string };

/** 把任意输入收敛到合法尺寸；缺失或非数字时用 fallback。 */
export function normalizeDimension(
  value: unknown,
  fallback: number,
  max: number,
  min = MIN_DIMENSION,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function clampCols(value: unknown): number {
  return normalizeDimension(value, DEFAULT_COLS, MAX_COLS);
}

export function clampRows(value: unknown): number {
  return normalizeDimension(value, DEFAULT_ROWS, MAX_ROWS);
}

/**
 * 解析浏览器发来的 JSON 控制消息；格式不对时返回 undefined。
 * 只接受字符串帧，输入长度有上限，避免一条消息撑爆内存。
 */
export function parseTerminalClientMessage(raw: unknown): TerminalClientMessage | undefined {
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type === "input") {
    const data = record.data;
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      return undefined;
    }
    return { type: "input", data };
  }
  if (record.type === "resize") {
    return { type: "resize", cols: clampCols(record.cols), rows: clampRows(record.rows) };
  }
  return undefined;
}

/** 优先用登录 shell；配置或系统里没有时回退到 bash/sh。 */
export function resolveShell(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const comspec = env.COMSPEC?.trim();
    return comspec && comspec.length > 0 ? comspec : "cmd.exe";
  }
  const candidate = env.SHELL?.trim();
  if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  for (const fallback of ["/bin/bash", "/bin/sh"]) {
    if (fs.existsSync(fallback)) return fallback;
  }
  return "/bin/sh";
}

/** PTY 默认在用户主目录打开；主目录不可用时退回进程工作目录。 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir().trim();
  if (home && fs.existsSync(home)) return home;
  const fromEnv = env.HOME?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return process.cwd();
}

/** 只对这些前缀下的变量做凭据脱敏。 */
const SECRET_ENV_PREFIXES = ["QUBIUS_", "REMOTE_CODER_", "EDGECTL_"];

/** 前缀之后的名字包含任一片段就算凭据。 */
const SECRET_ENV_FRAGMENTS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "API_KEY",
  "CREDENTIALS",
  "COOKIE",
];

/**
 * 部署脚本会把 env 文件整体导出给服务进程，其中 QUBIUS_、REMOTE_CODER_、
 * EDGECTL_ 前缀下的令牌、密码和密钥不应该一条 `env` 就显示在浏览器屏幕上。
 * 只按前缀和名字片段判断，不认识的凭据变量也能覆盖；无前缀的
 * GITEA_TOKEN、ANTHROPIC_API_KEY 等则原样保留。
 */
function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  const prefix = SECRET_ENV_PREFIXES.find((candidate) => upper.startsWith(candidate));
  if (!prefix) return false;
  const rest = upper.slice(prefix.length);
  return SECRET_ENV_FRAGMENTS.some((fragment) => rest.includes(fragment));
}

/** 继承服务端环境（去掉凭据），并显式声明终端类型，避免程序输出 ANSI 能力降级。 */
export function terminalEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && !isSecretEnvName(key)) result[key] = value;
  }
  result.TERM = "xterm-256color";
  if (!result.COLORTERM) result.COLORTERM = "truecolor";
  return result;
}

let nodePtyModule: typeof import("node-pty") | undefined;

/**
 * 懒加载 node-pty：它是原生模块，加载失败（例如没编译成功）时只让终端功能
 * 报错，不能拖垮整个服务；单元测试注入假 spawner 时也不会碰它。
 */
function nodePty(): typeof import("node-pty") {
  if (!nodePtyModule) {
    try {
      nodePtyModule = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`终端不可用：无法加载 node-pty（${detail}）`);
    }
  }
  return nodePtyModule;
}

export const spawnWithNodePty: PtySpawner = (options) => nodePty().spawn(options.shell, [], {
  name: "xterm-256color",
  cols: options.cols,
  rows: options.rows,
  cwd: options.cwd,
  env: options.env,
});

export class TerminalLimitError extends Error {}

/** 一个已启动的 PTY 会话；数据/退出事件可以注册多个监听者。 */
export class TerminalSession {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exit: PtyExit) => void>();
  private subscriptions: { dispose(): void }[] | undefined;
  private exitEvent: PtyExit | undefined;
  private finished = false;

  constructor(
    readonly id: string,
    readonly shell: string,
    readonly cwd: string,
    private readonly pty: PtyProcess,
    private readonly onFinished: () => void,
  ) {
    this.subscriptions = [
      pty.onData((data) => {
        if (this.finished) return;
        for (const listener of this.dataListeners) listener(data);
      }),
      pty.onExit((event) => this.handleExit(event)),
    ];
  }

  get pid(): number {
    return this.pty.pid;
  }

  get exited(): boolean {
    return this.exitEvent !== undefined;
  }

  onData(listener: (data: string) => void): () => void {
    if (this.finished) return () => {};
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    if (this.exitEvent) {
      const event = this.exitEvent;
      queueMicrotask(() => listener(event));
      return () => {};
    }
    if (this.finished) return () => {};
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  write(data: string): void {
    if (this.finished) return;
    try {
      this.pty.write(data);
    } catch {
      // PTY 可能在写入瞬间退出；由 exit 事件统一收尾。
    }
  }

  resize(cols: number, rows: number): void {
    if (this.finished) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // 已退出或尺寸不被接受；保持旧尺寸即可。
    }
  }

  pause(): void {
    if (this.finished) return;
    try {
      this.pty.pause();
    } catch {
      // 已退出。
    }
  }

  resume(): void {
    if (this.finished) return;
    try {
      this.pty.resume();
    } catch {
      // 已退出。
    }
  }

  /** 主动结束（浏览器断开、服务退出）。幂等。 */
  close(): void {
    if (this.finished) return;
    this.finished = true;
    this.disposeSubscriptions();
    this.dataListeners.clear();
    this.exitListeners.clear();
    try {
      this.pty.kill();
    } catch {
      // 已经退出。
    }
    this.onFinished();
  }

  private handleExit(event: PtyExit): void {
    if (this.finished) return;
    this.exitEvent = {
      exitCode: event.exitCode,
      ...(event.signal !== undefined ? { signal: event.signal } : {}),
    };
    this.finished = true;
    this.disposeSubscriptions();
    this.dataListeners.clear();
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    for (const listener of listeners) listener(this.exitEvent);
    this.onFinished();
  }

  private disposeSubscriptions(): void {
    const subscriptions = this.subscriptions;
    this.subscriptions = undefined;
    for (const subscription of subscriptions ?? []) {
      try {
        subscription.dispose();
      } catch {
        // 原生对象已释放。
      }
    }
  }
}

export interface TerminalManagerOptions {
  maxSessions?: number;
  shell?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: PtySpawner;
}

export interface TerminalOpenInput {
  cols?: unknown;
  rows?: unknown;
  /** 指定工作目录（例如项目仓库路径）；未指定时用管理器配置的 cwd 或主目录。 */
  cwd?: string;
}

/** 管理本实例的所有 PTY，限制并发数，并在退出时统一清理。 */
export class TerminalManager {
  private readonly sessions = new Set<TerminalSession>();
  private seq = 0;

  constructor(private readonly options: TerminalManagerOptions = {}) {}

  get size(): number {
    return this.sessions.size;
  }

  get maxSessions(): number {
    return this.options.maxSessions ?? DEFAULT_MAX_TERMINALS;
  }

  open(input: TerminalOpenInput = {}): TerminalSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new TerminalLimitError(`同时最多 ${this.maxSessions} 个命令行，请先关闭一个`);
    }
    const cols = clampCols(input.cols);
    const rows = clampRows(input.rows);
    const shell = this.options.shell ?? resolveShell(this.options.env);
    const cwd = input.cwd ?? this.options.cwd ?? resolveHome(this.options.env);
    const spawn = this.options.spawn ?? spawnWithNodePty;
    const pty = spawn({
      shell,
      cwd,
      env: terminalEnv(this.options.env),
      cols,
      rows,
    });
    const session = new TerminalSession(
      `t${++this.seq}`,
      shell,
      cwd,
      pty,
      () => {
        this.sessions.delete(session);
      },
    );
    this.sessions.add(session);
    return session;
  }

  closeAll(): void {
    for (const session of [...this.sessions]) session.close();
    this.sessions.clear();
  }
}
