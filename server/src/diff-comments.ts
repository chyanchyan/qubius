import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FeatureContext, FeatureResult } from "./feature-routes.js";
import { isSessionBusy } from "./session-lock.js";

/**
 * 会话 diff 的行级评论。
 *
 * 路由契约（由 web 端一起使用）：
 * - GET    /api/sessions/<id>/diff-comments
 * - POST   /api/sessions/<id>/diff-comments
 * - PATCH  /api/sessions/<id>/diff-comments/<commentId>
 * - DELETE /api/sessions/<id>/diff-comments/<commentId>
 * - DELETE /api/sessions/<id>/diff-comments
 *
 * 数据按会话保存在 <dataDir>/diff-comments/<sessionId>.json，写入走临时文件
 * + rename；同一会话的读改写用模块内的 promise 链串行化，避免并发覆盖。
 */

export type DiffCommentSide = "old" | "new";

export interface DiffComment {
  id: string;
  file: string;
  side: DiffCommentSide;
  line: number;
  text: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DiffCommentInput {
  file: unknown;
  side: unknown;
  line: unknown;
  text: unknown;
}

export interface DiffCommentPatch {
  text?: unknown;
  resolved?: unknown;
}

/** 每个会话最多保留的评论条数。 */
export const MAX_DIFF_COMMENTS = 200;

const MAX_FILE_LENGTH = 500;
const MAX_TEXT_LENGTH = 2_000;
const MAX_LINE = 1_000_000;

/** UUID 形态的安全 id；会话 id 和评论 id 都只允许这种形状，防止路径穿越。 */
const SAFE_ID = /^[0-9a-f-]{36}$/i;

/** file 不允许出现控制字符（含换行、制表符）；text 允许多行，只做 trim。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const ROUTE = /^\/api\/sessions\/([^/]+)\/diff-comments(?:\/([^/]+))?\/?$/;

/** 校验失败（对应 HTTP 400）；路由层统一转换成 FeatureResult。 */
export class DiffCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffCommentError";
  }
}

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

function commentsDir(dataDir: string): string {
  return path.join(dataDir, "diff-comments");
}

function commentsFile(dataDir: string, sessionId: string): string {
  return path.join(commentsDir(dataDir), `${sessionId}.json`);
}

/**
 * 某个会话评论文件的绝对路径。删除/归档会话时用它确认文件已清理，
 * 避免调用方各自硬编码 `<dataDir>/diff-comments/<id>.json`。
 */
export function diffCommentsFilePath(dataDir: string, sessionId: string): string {
  assertSessionId(sessionId);
  return commentsFile(dataDir, sessionId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertSessionId(sessionId: string): void {
  if (!isSafeId(sessionId)) throw new DiffCommentError("非法的对话 id");
}

function validateFile(value: unknown): string {
  if (typeof value !== "string") throw new DiffCommentError("file 必须是字符串");
  const file = value.trim();
  if (!file || file.length > MAX_FILE_LENGTH || CONTROL_CHARS.test(file)) {
    throw new DiffCommentError(`file 必须是 1 到 ${MAX_FILE_LENGTH} 个字符且不能包含控制字符`);
  }
  return file;
}

function validateSide(value: unknown): DiffCommentSide {
  if (value !== "old" && value !== "new") throw new DiffCommentError("side 必须是 old 或 new");
  return value;
}

function validateLine(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LINE) {
    throw new DiffCommentError(`line 必须是 1 到 ${MAX_LINE} 的整数`);
  }
  return value;
}

function validateText(value: unknown): string {
  if (typeof value !== "string") throw new DiffCommentError("text 必须是字符串");
  const text = value.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new DiffCommentError(`text 必须是 1 到 ${MAX_TEXT_LENGTH} 个字符`);
  }
  return text;
}

function validateResolved(value: unknown): boolean {
  if (typeof value !== "boolean") throw new DiffCommentError("resolved 必须是 true 或 false");
  return value;
}

/** 读取时过滤掉字段不完整或类型不对的条目，损坏数据不影响其它评论。 */
function normalizeComment(value: unknown): DiffComment | null {
  const record = asRecord(value);
  if (typeof record.id !== "string" || !isSafeId(record.id)) return null;
  if (typeof record.file !== "string" || !record.file) return null;
  if (record.side !== "old" && record.side !== "new") return null;
  if (
    typeof record.line !== "number" ||
    !Number.isInteger(record.line) ||
    record.line < 1 ||
    record.line > MAX_LINE
  ) {
    return null;
  }
  if (typeof record.text !== "string" || !record.text) return null;
  if (typeof record.resolved !== "boolean") return null;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return null;
  return {
    id: record.id,
    file: record.file,
    side: record.side,
    line: record.line,
    text: record.text,
    resolved: record.resolved,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function compareComments(a: DiffComment, b: DiffComment): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function readCommentsFile(file: string): Promise<DiffComment[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 损坏的 JSON 视为空数组，不影响后续写入。
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const comments: DiffComment[] = [];
  for (const item of parsed) {
    const comment = normalizeComment(item);
    if (comment) comments.push(comment);
  }
  return comments;
}

/** 原子写：先写同目录临时文件，再 rename 覆盖目标。 */
async function writeCommentsFile(file: string, comments: DiffComment[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(comments, null, 2)}\n`;
  await fs.promises.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 同一会话的写操作串行化；不同 dataDir/会话之间互不影响。 */
const writeQueues = new Map<string, Promise<unknown>>();

function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  writeQueues.set(key, tail);
  void tail.finally(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}

function queueKey(dataDir: string, sessionId: string): string {
  return `${path.resolve(dataDir)}\u0000${sessionId}`;
}

/** 列出某个会话的全部评论，按 file、line、createdAt 排序。 */
export async function listDiffComments(dataDir: string, sessionId: string): Promise<DiffComment[]> {
  assertSessionId(sessionId);
  const comments = await readCommentsFile(commentsFile(dataDir, sessionId));
  return comments.sort(compareComments);
}

/** 新增一条评论；超出上限或字段非法时抛 DiffCommentError。 */
export async function addDiffComment(
  dataDir: string,
  sessionId: string,
  input: DiffCommentInput,
): Promise<DiffComment> {
  assertSessionId(sessionId);
  const file = validateFile(input.file);
  const side = validateSide(input.side);
  const line = validateLine(input.line);
  const text = validateText(input.text);

  const target = commentsFile(dataDir, sessionId);
  return runExclusive(queueKey(dataDir, sessionId), async () => {
    const comments = await readCommentsFile(target);
    if (comments.length >= MAX_DIFF_COMMENTS) {
      throw new DiffCommentError(`评论数量已达上限（${MAX_DIFF_COMMENTS} 条）`);
    }
    const now = new Date().toISOString();
    const comment: DiffComment = {
      id: randomUUID(),
      file,
      side,
      line,
      text,
      resolved: false,
      createdAt: now,
      updatedAt: now,
    };
    comments.push(comment);
    comments.sort(compareComments);
    await writeCommentsFile(target, comments);
    return comment;
  });
}

/**
 * 更新评论的 text / resolved；只有显式出现的字段才会改，未知字段忽略。
 * 评论不存在时返回 undefined。字段非法时抛 DiffCommentError。
 */
export async function updateDiffComment(
  dataDir: string,
  sessionId: string,
  commentId: string,
  patch: DiffCommentPatch,
): Promise<DiffComment | undefined> {
  assertSessionId(sessionId);
  if (!isSafeId(commentId)) return undefined;
  const hasText = Object.prototype.hasOwnProperty.call(patch, "text");
  const hasResolved = Object.prototype.hasOwnProperty.call(patch, "resolved");
  const text = hasText ? validateText(patch.text) : undefined;
  const resolved = hasResolved ? validateResolved(patch.resolved) : undefined;

  const target = commentsFile(dataDir, sessionId);
  return runExclusive(queueKey(dataDir, sessionId), async () => {
    const comments = await readCommentsFile(target);
    const index = comments.findIndex((comment) => comment.id === commentId);
    if (index < 0) return undefined;
    const current = comments[index];
    if (!current) return undefined;
    const updated: DiffComment = {
      ...current,
      ...(text === undefined ? {} : { text }),
      ...(resolved === undefined ? {} : { resolved }),
    };
    if (!hasText && !hasResolved) return updated;
    updated.updatedAt = new Date().toISOString();
    comments[index] = updated;
    comments.sort(compareComments);
    await writeCommentsFile(target, comments);
    return updated;
  });
}

/** 删除一条评论；返回是否真的删除了。 */
export async function removeDiffComment(
  dataDir: string,
  sessionId: string,
  commentId: string,
): Promise<boolean> {
  assertSessionId(sessionId);
  if (!isSafeId(commentId)) return false;
  const target = commentsFile(dataDir, sessionId);
  return runExclusive(queueKey(dataDir, sessionId), async () => {
    const comments = await readCommentsFile(target);
    const next = comments.filter((comment) => comment.id !== commentId);
    if (next.length === comments.length) return false;
    await writeCommentsFile(target, next);
    return true;
  });
}

/** 清空某个会话的全部评论。 */
export async function clearDiffComments(dataDir: string, sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  const target = commentsFile(dataDir, sessionId);
  await runExclusive(queueKey(dataDir, sessionId), async () => {
    await writeCommentsFile(target, []);
  });
}

/**
 * 删除某个会话的评论文件（会话被删除/归档/retention 清理时使用）。
 * 不写空数组，直接移除文件；文件本来就不存在视为成功。与写入共用同一个
 * 队列，避免和并发的评论写操作互相覆盖。
 */
export async function removeDiffComments(dataDir: string, sessionId: string): Promise<void> {
  const target = diffCommentsFilePath(dataDir, sessionId);
  await runExclusive(queueKey(dataDir, sessionId), async () => {
    try {
      await fs.promises.rm(target, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  });
}

function notFoundSession(): FeatureResult {
  return { status: 404, body: { error: "找不到对话" } };
}

function notFoundComment(): FeatureResult {
  return { status: 404, body: { error: "找不到评论" } };
}

/** 把存储层的校验错误转换成 400；其它异常继续向上抛，由 HTTP 层兜底。 */
function failure(error: unknown): FeatureResult {
  if (error instanceof DiffCommentError) {
    return { status: 400, body: { error: error.message } };
  }
  throw error;
}

export async function handleDiffCommentRoutes(ctx: FeatureContext): Promise<FeatureResult | null> {
  const match = ROUTE.exec(ctx.url.pathname);
  if (!match) return null;
  const sessionId = match[1];
  if (!sessionId) return null;
  const commentId = match[2];
  const isCollection = commentId === undefined;

  const supported = isCollection
    ? ctx.method === "GET" || ctx.method === "POST" || ctx.method === "DELETE"
    : ctx.method === "PATCH" || ctx.method === "DELETE";
  if (!supported) {
    return { status: 405, body: { error: "不支持的方法" } };
  }

  // 先校验 id 形状再查 store，避免用非法路径去访问其它文件。
  if (!isSafeId(sessionId) || !ctx.store.get(sessionId)) return notFoundSession();
  // 删除/归档/retention 清理期间会话持锁；此时不能再接受写操作，否则一个
  // 已经通过 store 检查的并发请求可能在评论文件删除后把它重新写回来。
  if (ctx.method !== "GET" && isSessionBusy(sessionId)) {
    return { status: 409, body: { error: "对话正在归档或清理，请稍后再试" } };
  }
  const dataDir = ctx.config.dataDir;

  try {
    if (isCollection) {
      if (ctx.method === "GET") {
        return { status: 200, body: { comments: await listDiffComments(dataDir, sessionId) } };
      }
      if (ctx.method === "POST") {
        const body = asRecord(await ctx.readJson(ctx.req));
        const comment = await addDiffComment(dataDir, sessionId, {
          file: body.file,
          side: body.side,
          line: body.line,
          text: body.text,
        });
        return { status: 201, body: { comment } };
      }
      // DELETE 集合：清空。
      await clearDiffComments(dataDir, sessionId);
      return { status: 200, body: { ok: true } };
    }

    if (!commentId || !isSafeId(commentId)) return notFoundComment();

    if (ctx.method === "PATCH") {
      const body = asRecord(await ctx.readJson(ctx.req));
      const comment = await updateDiffComment(dataDir, sessionId, commentId, {
        ...(Object.prototype.hasOwnProperty.call(body, "text") ? { text: body.text } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "resolved") ? { resolved: body.resolved } : {}),
      });
      if (!comment) return notFoundComment();
      return { status: 200, body: { comment } };
    }

    // DELETE 单条。
    const removed = await removeDiffComment(dataDir, sessionId, commentId);
    if (!removed) return notFoundComment();
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return failure(error);
  }
}
