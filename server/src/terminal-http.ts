import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  clampCols,
  clampRows,
  MAX_INPUT_CHARS,
  type PtyExit,
  type TerminalManager,
  type TerminalOpenInput,
  type TerminalServerMessage,
} from "./terminal.js";

/**
 * 开发机命令行的 HTTP 传输层。
 *
 * 不用 WebSocket：公网/局域网入口都套了一层 HTTP Basic 认证，而 Safari 在
 * WebSocket 握手时不会带缓存的 Basic 凭据，iPhone 上会直接连不上。改成
 * 「SSE 输出 + 普通 POST 输入」后，所有请求都是普通 HTTP，Basic 认证照常生效。
 *
 * 接口：
 * - POST   /api/terminal                 创建 PTY，返回 `{ id, shell, cwd }`
 * - GET    /api/terminal/<id>/stream     SSE 输出（data/exit）
 * - POST   /api/terminal/<id>/input      body `{ data }`
 * - POST   /api/terminal/<id>/resize     body `{ cols, rows }`
 * - DELETE /api/terminal/<id>            结束 PTY
 */

const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_KEEPALIVE_MS = 15_000;
/** 浏览器还没打开 SSE 时的缓冲上限；防止 shell 启动时刷屏占满内存。 */
const MAX_PENDING_CHARS = 256 * 1024;
/**
 * SSE 发送缓冲超过这个字节数就暂停读取 PTY，等 drain 再恢复。
 * 不设上限时，手机网络慢或标签页被节流，`yes`/`cat 大文件` 会把服务端内存撑爆。
 */
const DEFAULT_HIGH_WATER_BYTES = 1024 * 1024;

interface Entry {
  session: ReturnType<TerminalManager["open"]>;
  stream?: ServerResponse;
  pending: string[];
  pendingChars: number;
  exit?: PtyExit;
  attachTimer?: NodeJS.Timeout;
  /** 因背压暂停时记下等待 drain 的流，换流或关闭时据此恢复/解绑。 */
  pausedOn?: ServerResponse;
}

export interface TerminalControllerOptions {
  /** 创建后多久还没人订阅输出就回收，避免断网留下孤儿 PTY。 */
  createTimeoutMs?: number;
  /** SSE 心跳，防止中间代理因为长时间无数据而断开。 */
  keepAliveMs?: number;
  /** 发送缓冲超过多少字节时暂停 PTY 输出。 */
  highWaterBytes?: number;
}

export class TerminalController {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly manager: TerminalManager,
    private readonly options: TerminalControllerOptions = {},
  ) {}

  get size(): number {
    return this.entries.size;
  }

  create(input: TerminalOpenInput = {}): {
    id: string;
    shell: string;
    cwd: string;
  } {
    const session = this.manager.open(input);
    const id = randomUUID();
    const entry: Entry = { session, pending: [], pendingChars: 0 };
    this.entries.set(id, entry);

    // 监听在创建时就挂上：shell 的启动提示符可能早于浏览器打开 SSE。
    session.onData((data) => {
      if (entry.stream) {
        writeFrame(entry.stream, { type: "data", data });
        this.applyBackpressure(entry);
        return;
      }
      if (entry.pendingChars < MAX_PENDING_CHARS) {
        entry.pending.push(data);
        entry.pendingChars += data.length;
      }
    });
    session.onExit((exit) => {
      entry.exit = exit;
      if (entry.stream) {
        writeFrame(entry.stream, {
          type: "exit",
          exitCode: exit.exitCode,
          ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
        });
        entry.stream.end();
      }
    });

    entry.attachTimer = setTimeout(() => {
      this.close(id);
    }, this.options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS);
    entry.attachTimer.unref();

    return { id, shell: session.shell, cwd: session.cwd };
  }

  /** 浏览器开始读取 SSE；同一会话只保留最新的一条流。 */
  stream(id: string, _req: IncomingMessage, res: ServerResponse): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.attachTimer) {
      clearTimeout(entry.attachTimer);
      entry.attachTimer = undefined;
    }

    const previous = entry.stream;
    this.releaseBackpressure(entry);
    entry.stream = res;
    previous?.end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // 让 Caddy/nginx 之类不要缓冲；Caddy 对 sse 站点本身也会关缓冲。
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    for (const chunk of entry.pending) writeFrame(res, { type: "data", data: chunk });
    entry.pending = [];
    entry.pendingChars = 0;
    this.applyBackpressure(entry);

    if (entry.exit) {
      writeFrame(res, {
        type: "exit",
        exitCode: entry.exit.exitCode,
        ...(entry.exit.signal !== undefined ? { signal: entry.exit.signal } : {}),
      });
      res.end();
      this.close(id);
      return true;
    }

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, this.options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS);
    keepAlive.unref();

    // 浏览器断开（含页面刷新、切走、网络中断）时结束 PTY。
    res.on("close", () => {
      clearInterval(keepAlive);
      if (entry.stream === res) this.close(id);
    });
    return true;
  }

  input(id: string, data: string): boolean {
    if (!data || data.length > MAX_INPUT_CHARS) return false;
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.session.write(data);
    return true;
  }

  resize(id: string, cols: unknown, rows: unknown): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.session.resize(clampCols(cols), clampRows(rows));
    return true;
  }

  /** 结束一个终端；返回它是否存在。 */
  close(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    if (entry.attachTimer) clearTimeout(entry.attachTimer);
    this.releaseBackpressure(entry);
    const stream = entry.stream;
    entry.stream = undefined;
    if (stream && !stream.writableEnded) stream.end();
    entry.session.close();
    return true;
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  private applyBackpressure(entry: Entry): void {
    const stream = entry.stream;
    if (!stream || entry.pausedOn || stream.writableEnded) return;
    if (stream.writableLength <= (this.options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES)) return;
    entry.pausedOn = stream;
    entry.session.pause();
    stream.once("drain", this.drainHandler(entry, stream));
  }

  private drainHandler(entry: Entry, stream: ServerResponse): () => void {
    return () => {
      if (entry.pausedOn !== stream) return;
      entry.pausedOn = undefined;
      entry.session.resume();
    };
  }

  /** 换流或关闭时：暂停中的 PTY 恢复读取，旧流上等待的 drain 失效。 */
  private releaseBackpressure(entry: Entry): void {
    if (!entry.pausedOn) return;
    entry.pausedOn = undefined;
    entry.session.resume();
  }
}

function writeFrame(res: ServerResponse, message: TerminalServerMessage): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}
