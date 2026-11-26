import type { DiffComment, DiffCommentSide } from "./api-diff-comments";

/**
 * 可评论 diff 的纯解析与 prompt 组装。
 *
 * 输入是服务端 `getDiff` 返回的 unified patch：`已暂存` / `未暂存` 分段标签、
 * `diff --git`、`@@ -a,b +c,d @@`、`+`/`-`/context 行以及
 * `\ No newline at end of file`。这里只做纯函数，便于 node:test 直接覆盖。
 */

export type ReviewSection = "已暂存" | "未暂存";

export type ReviewLineKind = "add" | "del" | "context" | "hunk" | "meta" | "nonewline";

export interface ReviewLine {
  kind: ReviewLineKind;
  /** 原始行（含 +/-/空格前缀）。 */
  text: string;
  /** 去掉前缀后的代码内容；hunk/meta/nonewline 保留原文或提示文字。 */
  content: string;
  /** 旧文件行号；只有 hunk 内属于旧侧的行（删除/上下文）才有。 */
  oldLine?: number;
  /** 新文件行号；只有 hunk 内属于新侧的行（新增/上下文）才有。 */
  newLine?: number;
}

export interface ReviewFile {
  /** `diff --git a/x b/x` 的显示名；没有文件头时尽量从 ---/+++ 推导。 */
  name: string;
  /** 服务端插入的暂存分段；第一个分段之前为 undefined。 */
  section?: ReviewSection;
  added: number;
  removed: number;
  lines: ReviewLine[];
}

const SECTION_LABELS = new Set<string>(["已暂存", "未暂存"]);
/* 同时取出两侧的行数（缺省为 1），用来在 hunk 内容耗尽时结束 inHunk。 */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `diff --git a/x b/x` 的显示名；兼容带引号/空格的路径（重命名取目标名）。 */
function fileNameFromGitLine(line: string): string {
  const rest = line.slice("diff --git ".length).trim();
  const quoted = /"b\/(.+)"\s*$/.exec(rest);
  if (quoted) return quoted[1];
  const marker = rest.lastIndexOf(" b/");
  return marker >= 0 ? rest.slice(marker + 3) : rest;
}

/** `+++ b/x` / `--- a/x` 推导文件名（去掉时间戳、重命名前缀）。 */
function fileNameFromHeader(line: string, prefix: "a/" | "b/"): string {
  let path = line.slice(4).trim();
  const tab = path.indexOf("\t");
  if (tab >= 0) path = path.slice(0, tab);
  if (path === "/dev/null") return "";
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/**
 * 把 unified diff 解析成按文件分组、带 old/new 行号的行。
 *
 * 行号只在 hunk 内推进：`+` 属于 new，`-` 属于 old，context 两侧都推进。
 * hunk 外的 `---`/`+++`/`index` 等文件头只作为 meta 行保留，不参与计数，
 * 避免内容行以 `+++`/`---` 开头时被误当成文件头。
 */
export function parseReviewDiff(text: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let current: ReviewFile | null = null;
  let section: ReviewSection | undefined;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  /* 当前 hunk 还剩多少 old/new 行没读；两侧都归零即 hunk 结束。 */
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (SECTION_LABELS.has(line)) {
      section = line as ReviewSection;
      current = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      current = {
        name: fileNameFromGitLine(line),
        section,
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(current);
      current.lines.push({ kind: "meta", text: line, content: line });
      inHunk = false;
      oldNo = 0;
      newNo = 0;
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }

    /* 空行不是 hunk 内容时就丢弃：服务端用 "\n\n" 拼接已暂存/未暂存两段，
       分段之间会多出一个空行；它不能变成可评论的幻影 context 行。
       只有 hunk 还有两侧行数配额时才把（丢了前导空格的）空行当上下文。 */
    if (line === "") {
      if (current && inHunk && oldRemaining > 0 && newRemaining > 0) {
        current.lines.push({
          kind: "context",
          text: "",
          content: "",
          oldLine: oldNo++,
          newLine: newNo++,
        });
        oldRemaining -= 1;
        newRemaining -= 1;
        if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
      }
      continue;
    }

    if (!current) {
      current = { name: "", section, added: 0, removed: 0, lines: [] };
      files.push(current);
    }

    if (line.startsWith("@@")) {
      const match = HUNK_RE.exec(line);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[3]);
        oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
        newRemaining = match[4] === undefined ? 1 : Number(match[4]);
        inHunk = true;
      }
      current.lines.push({ kind: "hunk", text: line, content: line });
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      /* 无换行提示不影响任何一侧的行号。 */
      current.lines.push({ kind: "nonewline", text: line, content: "文件末尾没有换行" });
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) {
        current.added += 1;
        current.lines.push({
          kind: "add",
          text: line,
          content: line.slice(1),
          newLine: newNo++,
        });
        newRemaining = Math.max(0, newRemaining - 1);
      } else if (line.startsWith("-")) {
        current.removed += 1;
        current.lines.push({
          kind: "del",
          text: line,
          content: line.slice(1),
          oldLine: oldNo++,
        });
        oldRemaining = Math.max(0, oldRemaining - 1);
      } else if (line.startsWith(" ")) {
        current.lines.push({
          kind: "context",
          text: line,
          content: line.slice(1),
          oldLine: oldNo++,
          newLine: newNo++,
        });
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
      } else {
        /* 未知 hunk 行：不推进任何一侧的行号，也不消耗 hunk 配额。 */
        current.lines.push({ kind: "meta", text: line, content: line });
      }
      /* hunk 声明的 old/new 行都读完就结束，后面紧跟的分段空行不再算 context。 */
      if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
      continue;
    }

    /* hunk 外的 ---/+++ 头：没有 diff --git 时用来补文件名。 */
    if (!current.name && line.startsWith("+++ ")) {
      current.name = fileNameFromHeader(line, "b/");
    }
    if (!current.name && line.startsWith("--- ")) {
      current.name = fileNameFromHeader(line, "a/");
    }
    current.lines.push({ kind: "meta", text: line, content: line });
  }

  return files;
}

/** 这一行可以挂在哪些侧上：新增=仅 new，删除=仅 old，上下文=两侧。 */
export function lineSides(line: ReviewLine): DiffCommentSide[] {
  const sides: DiffCommentSide[] = [];
  if (line.oldLine !== undefined) sides.push("old");
  if (line.newLine !== undefined) sides.push("new");
  return sides;
}

/**
 * 这一行默认的评论锚点：有 new 行号就挂 new（新增/上下文），否则挂 old
 * （删除行）。UI 在上下文行上创建的评论因此落在新文件一侧。
 */
export function commentAnchor(
  line: ReviewLine,
): { side: DiffCommentSide; line: number } | null {
  if (line.newLine !== undefined) return { side: "new", line: line.newLine };
  if (line.oldLine !== undefined) return { side: "old", line: line.oldLine };
  return null;
}

/** 把代码片段裁到 max 个字以内（含省略号）。 */
function clip(content: string, max: number): string {
  const text = content.trimEnd();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 按文件/侧/行号找到对应代码；找不到返回空串。 */
export function lineSnippet(
  files: ReviewFile[],
  file: string,
  side: DiffCommentSide,
  lineNo: number,
  max = 200,
): string {
  const target = files.find((item) => item.name === file);
  if (!target) return "";
  const match = target.lines.find((line) =>
    side === "new" ? line.newLine === lineNo : line.oldLine === lineNo,
  );
  return clip(match?.content ?? "", max);
}

export interface ReviewPromptOptions {
  /** 代码片段上限，默认 200 字。 */
  maxSnippet?: number;
}

/**
 * 把未解决评论拼成一条发给 agent 的 prompt。
 *
 * 排序：先按评论对应文件在 diff 里出现的顺序（未出现在本次 diff 里的文件排
 * 后面并按文件名排序），同一文件按行号升序，同一行 old 在 new 之前，最后按
 * id 保证稳定。已解决的评论会被忽略。
 */
export function buildReviewPrompt(
  comments: DiffComment[],
  files: ReviewFile[],
  options?: ReviewPromptOptions,
): string {
  const unresolved = comments.filter((comment) => !comment.resolved);
  if (unresolved.length === 0) return "";
  const maxSnippet = options?.maxSnippet ?? 200;

  const fileOrder = new Map<string, number>();
  files.forEach((file, index) => {
    if (!fileOrder.has(file.name)) fileOrder.set(file.name, index);
  });
  const orderOf = (file: string): number => fileOrder.get(file) ?? Number.MAX_SAFE_INTEGER;

  const sorted = [...unresolved].sort((a, b) => {
    const byFile = orderOf(a.file) - orderOf(b.file);
    if (byFile !== 0) return byFile;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.side !== b.side) return a.side === "old" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const blocks = sorted.map((comment) => {
    const parts = [
      `文件：${comment.file || "（未知文件）"}`,
      `位置：${comment.side === "old" ? "旧行" : "新行"} ${comment.line}`,
    ];
    const snippet = lineSnippet(files, comment.file, comment.side, comment.line, maxSnippet);
    if (snippet) parts.push(`代码：${snippet}`);
    parts.push(`意见：${comment.text.trim()}`);
    return parts.join("\n");
  });

  return ["请根据以下 diff 行级评论修改代码：", ...blocks].join("\n\n");
}
