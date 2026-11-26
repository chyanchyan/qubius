/**
 * Edit / Write / MultiEdit 工具输入 → 行级 diff。
 *
 * 只用于展示：输入来自 SDK 记录的原始工具 JSON。解析失败（例如服务端把
 * 超长输入截断了）时返回 null，由调用方回退到普通工具行。
 */

import { toolInputRecord } from "./tool-summary";

export type DiffLineKind = "add" | "del" | "context" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface EditDiff {
  /** 相对 cwd 的路径；无法解析时为空字符串。 */
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** 展示内容不完整（输入被截断或超出展示上限）。 */
  truncated: boolean;
}

/** 改动卡里的一个文件：同一次回答中多次编辑同一文件时合并成一项。 */
export interface ChangeFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
  /** 合并了几次编辑调用（Edit / Write / MultiEdit）。 */
  edits: number;
}

/**
 * 把连续编辑的 diff 按文件合并，供简要档的改动卡使用。
 *
 * 同一文件被编辑多次时，后续 diff 前补一条「第 N 处编辑」分隔行，再拼上它
 * 自己的上下文；这样既保留每处的局部上下文，又不会出现多个同名文件块。
 * 路径解析不出来的 diff 不合并，各自成块，避免被误认为同一个文件。
 */
export function mergeChanges(diffs: readonly EditDiff[]): ChangeFile[] {
  const files: ChangeFile[] = [];
  const byPath = new Map<string, ChangeFile>();
  for (const diff of diffs) {
    const key = diff.path ? `path:${diff.path}` : `anonymous:${files.length}`;
    const existing = byPath.get(key);
    if (!existing) {
      const file: ChangeFile = {
        path: diff.path,
        added: diff.added,
        removed: diff.removed,
        lines: [...diff.lines],
        truncated: diff.truncated,
        edits: 1,
      };
      byPath.set(key, file);
      files.push(file);
      continue;
    }
    const edits = existing.edits + 1;
    if (existing.lines.length > 0 && diff.lines.length > 0) {
      existing.lines.push({ kind: "hunk", text: `第 ${edits} 处编辑` });
    }
    existing.lines.push(...diff.lines);
    existing.added += diff.added;
    existing.removed += diff.removed;
    existing.truncated = existing.truncated || diff.truncated;
    existing.edits = edits;
  }
  return files;
}

interface EditPair {
  oldText: string;
  newText: string;
}

/** 单次 diff 每侧最多比较的行数；超出时退化为整段删除 + 整段新增。 */
const MAX_DIFF_SIDE = 400;
/** 展示上限，避免一个巨型编辑占满滚动区。 */
const MAX_DISPLAY_LINES = 400;
/** 变更前后各保留的上下文行数。 */
const CONTEXT_RADIUS = 2;

/** 这些工具的行内 diff 值得单独展示。 */
export function isEditTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit";
}

export function buildEditDiff(toolName: string, input: string, cwd?: string): EditDiff | null {
  if (!isEditTool(toolName)) return null;
  const record = toolInputRecord(input);
  if (!record) return null;
  const path = relativePath(
    typeof record.file_path === "string" ? record.file_path : "",
    cwd,
  );

  if (toolName === "Edit") {
    const pair = readPair(record);
    return pair ? assemble(path, [pair], false) : null;
  }

  if (toolName === "MultiEdit") {
    if (!Array.isArray(record.edits)) return null;
    const pairs: EditPair[] = [];
    for (const edit of record.edits) {
      if (!isRecord(edit)) continue;
      const pair = readPair(edit);
      if (pair) pairs.push(pair);
    }
    return pairs.length > 0 ? assemble(path, pairs, false) : null;
  }

  // Write：没有旧内容可比较，按全部新增展示。
  if (typeof record.content !== "string") return null;
  const lines = splitLines(record.content).map((text) => ({ kind: "add" as const, text }));
  return finalize(path, lines, false);
}

function readPair(record: Record<string, unknown>): EditPair | null {
  if (typeof record.old_string !== "string" || typeof record.new_string !== "string") {
    return null;
  }
  return { oldText: record.old_string, newText: record.new_string };
}

function assemble(path: string, pairs: EditPair[], truncated: boolean): EditDiff {
  const lines: DiffLine[] = [];
  pairs.forEach((pair, index) => {
    if (index > 0) lines.push({ kind: "hunk", text: `第 ${index + 1} 处编辑` });
    const diff = diffLines(splitLines(pair.oldText), splitLines(pair.newText));
    lines.push(...diff);
  });
  return finalize(path, lines, truncated);
}

function finalize(path: string, lines: DiffLine[], truncated: boolean): EditDiff {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  const compacted = compactContext(lines);
  const clipped = compacted.length > MAX_DISPLAY_LINES;
  return {
    path,
    added,
    removed,
    lines: clipped ? compacted.slice(0, MAX_DISPLAY_LINES) : compacted,
    truncated: truncated || clipped,
  };
}

/** 把过长的未改动片段压成一行「… N 行未改动」，只保留变更附近的上下文。 */
function compactContext(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind !== "context") {
      out.push(line);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].kind === "context") end += 1;
    const run = end - index;
    if (run <= CONTEXT_RADIUS * 2 + 1) {
      out.push(...lines.slice(index, end));
    } else {
      out.push(...lines.slice(index, index + CONTEXT_RADIUS));
      const hidden = run - CONTEXT_RADIUS * 2;
      out.push({ kind: "hunk", text: `… ${hidden} 行未改动` });
      out.push(...lines.slice(end - CONTEXT_RADIUS, end));
    }
    index = end;
  }
  return out;
}

/** 行级 LCS diff；公共前后缀先裁掉，减少 DP 规模。 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start
    && endAfter > start
    && before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const out: DiffLine[] = before
    .slice(0, start)
    .map((text) => ({ kind: "context" as const, text }));
  if (a.length > MAX_DIFF_SIDE || b.length > MAX_DIFF_SIDE || a.length * b.length > 250_000) {
    out.push(...a.map((text) => ({ kind: "del" as const, text })));
    out.push(...b.map((text) => ({ kind: "add" as const, text })));
  } else {
    out.push(...lcsDiff(a, b));
  }
  out.push(...before.slice(endBefore).map((text) => ({ kind: "context" as const, text })));
  return out;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** 按行拆分；末尾换行不额外算一行。 */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function relativePath(value: string, cwd?: string): string {
  const trimmed = value.trim();
  if (!trimmed || !cwd) return trimmed;
  const base = cwd.replace(/\/+$/, "");
  if (!base) return trimmed;
  if (trimmed === base) return ".";
  const prefix = `${base}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
