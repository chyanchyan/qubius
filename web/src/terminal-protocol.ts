/**
 * 命令行页与服务端之间的消息格式。
 * 传输是普通 HTTP：输出用 SSE 流（`data: <json>\n\n`），输入用 POST。
 * 单独成文件方便在不引入 xterm 的情况下做纯逻辑测试。
 */

export type TerminalServerMessage =
  | { type: "ready"; id: string; shell: string; cwd: string }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string };

/** 解析一帧 JSON；格式不认识时返回 undefined（忽略即可）。 */
export function parseTerminalServerMessage(raw: unknown): TerminalServerMessage | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type === "ready") {
    return {
      type: "ready",
      id: typeof record.id === "string" ? record.id : "",
      shell: typeof record.shell === "string" ? record.shell : "",
      cwd: typeof record.cwd === "string" ? record.cwd : "",
    };
  }
  if (record.type === "data") {
    return typeof record.data === "string" ? { type: "data", data: record.data } : undefined;
  }
  if (record.type === "exit") {
    if (typeof record.exitCode !== "number" || !Number.isFinite(record.exitCode)) return undefined;
    return {
      type: "exit",
      exitCode: record.exitCode,
      ...(typeof record.signal === "number" ? { signal: record.signal } : {}),
    };
  }
  if (record.type === "error") {
    return typeof record.message === "string" ? { type: "error", message: record.message } : undefined;
  }
  return undefined;
}

/**
 * 增量解析 SSE 字节流：网络分块可能把一帧拆开，也可能一次带来多帧。
 * 注释/心跳帧（`: keepalive`）没有 data 行，直接忽略。
 */
export class TerminalStreamParser {
  private buffer = "";

  push(chunk: string): TerminalServerMessage[] {
    this.buffer += chunk;
    const messages: TerminalServerMessage[] = [];
    for (;;) {
      const index = this.buffer.indexOf("\n\n");
      if (index < 0) break;
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const message = parseTerminalServerMessage(data);
      if (message) messages.push(message);
    }
    return messages;
  }
}

/** 单条输入 POST 的最大字符数；大段粘贴由调用方切块。 */
export const MAX_INPUT_CHUNK = 32_000;

/** 把一段输入切成服务端能接受的大小。 */
export function chunkTerminalInput(data: string): string[] {
  if (data.length <= MAX_INPUT_CHUNK) return data ? [data] : [];
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += MAX_INPUT_CHUNK) {
    chunks.push(data.slice(offset, offset + MAX_INPUT_CHUNK));
  }
  return chunks;
}

function positiveDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

export function terminalCreateBody(cols: number, rows: number, project = ""): string {
  return JSON.stringify({
    cols: positiveDimension(cols),
    rows: positiveDimension(rows),
    ...(project ? { project } : {}),
  });
}

export function terminalInputBody(data: string): string {
  return JSON.stringify({ data });
}

export function terminalResizeBody(cols: number, rows: number): string {
  return JSON.stringify({
    cols: positiveDimension(cols),
    rows: positiveDimension(rows),
  });
}
