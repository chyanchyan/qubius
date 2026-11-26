import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FeatureContext, FeatureResult } from "./feature-routes.js";
import { isEffort, type Effort } from "./types.js";

/**
 * 多模型并行对比的分组记录。
 *
 * 以前这些记录只存在于浏览器 localStorage，换设备或换浏览器就看不到；现在统一
 * 放在 <dataDir>/multi-model-groups.json，按项目读取。路由契约：
 * - GET    /api/projects/<projectId>/multi-model-groups
 * - POST   /api/projects/<projectId>/multi-model-groups
 * - DELETE /api/projects/<projectId>/multi-model-groups/<groupId>
 *
 * 文件里是一个数组，新记录在前；每个项目最多保留 MAX_GROUPS_PER_PROJECT 组，
 * 超出时丢弃最旧的。写入走临时文件 + rename，同一 dataDir 的读改写用模块内的
 * promise 链串行化，避免并发覆盖。
 */

/** 一次对比至少两个模型，最多 4 个，与 web 端一致。 */
export const MIN_GROUP_SESSIONS = 2;
export const MAX_GROUP_SESSIONS = 4;
/** 每个项目保留的分组数量上限。 */
export const MAX_GROUPS_PER_PROJECT = 20;
/** 提示摘要最多保留的字符数。 */
export const PROMPT_PREVIEW_LIMIT = 200;

/** 分组里的一个会话快照（不保存会话正文，只留对比需要的字段）。 */
export interface MultiModelGroupMember {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  title: string;
}

/** 同一 prompt 创建的一组会话。id / createdAt 由服务端生成。 */
export interface MultiModelGroup {
  id: string;
  projectId: string;
  createdAt: string;
  promptPreview: string;
  sessions: MultiModelGroupMember[];
}

/** 校验通过、等待落盘的内容。 */
export interface ValidatedGroupInput {
  promptPreview: string;
  sessions: MultiModelGroupMember[];
}

/** 按会话 id 查会话；只需要 projectId，便于注入测试替身。 */
export type GroupSessionLookup = (id: string) => { projectId?: string } | undefined;

/** 校验失败（对应 HTTP 400）；路由层统一转换成 FeatureResult。 */
export class MultiModelGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiModelGroupError";
  }
}

function groupsFile(dataDir: string): string {
  return path.join(dataDir, "multi-model-groups.json");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new MultiModelGroupError(`${label} 必须是字符串`);
  return value;
}

/** promptPreview 只做 trim 和截断；缺省时保存空串。 */
function normalizePromptPreview(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new MultiModelGroupError("promptPreview 必须是字符串");
  return value.trim().slice(0, PROMPT_PREVIEW_LIMIT);
}

function validateMember(
  value: unknown,
  projectId: string,
  lookup: GroupSessionLookup,
): MultiModelGroupMember {
  const record = asRecord(value);
  if (!record) throw new MultiModelGroupError("sessions 里的每一项必须是对象");
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new MultiModelGroupError("session id 必须是非空字符串");
  }
  const session = lookup(id);
  if (!session || session.projectId !== projectId) {
    throw new MultiModelGroupError(`会话 ${id} 不存在或不属于该项目`);
  }
  const providerId = requireString(record, "providerId", "providerId");
  const providerName = requireString(record, "providerName", "providerName");
  const model = requireString(record, "model", "model");
  const title = requireString(record, "title", "title");
  const effort = record.effort;
  if (!isEffort(effort)) {
    throw new MultiModelGroupError("effort 必须是 low、medium、high、xhigh 或 max");
  }
  return { id, providerId, providerName, model, effort, title };
}

/**
 * 校验 POST 请求体：sessions 2~4 条，会话必须存在且属于当前项目，字段类型正确，
 * 不允许重复会话；promptPreview 截断到 200 字。客户端带来的 id / createdAt 忽略。
 */
export function validateGroupInput(
  projectId: string,
  input: unknown,
  lookup: GroupSessionLookup,
): ValidatedGroupInput {
  const record = asRecord(input);
  if (!record) throw new MultiModelGroupError("请求体必须是对象");
  const rawSessions = record.sessions;
  if (!Array.isArray(rawSessions)) throw new MultiModelGroupError("sessions 必须是数组");
  if (rawSessions.length < MIN_GROUP_SESSIONS || rawSessions.length > MAX_GROUP_SESSIONS) {
    throw new MultiModelGroupError(
      `sessions 必须有 ${MIN_GROUP_SESSIONS} 到 ${MAX_GROUP_SESSIONS} 条`,
    );
  }

  const seen = new Set<string>();
  const sessions: MultiModelGroupMember[] = [];
  for (const raw of rawSessions) {
    const member = validateMember(raw, projectId, lookup);
    if (seen.has(member.id)) {
      throw new MultiModelGroupError(`重复的会话 ${member.id}`);
    }
    seen.add(member.id);
    sessions.push(member);
  }

  return { promptPreview: normalizePromptPreview(record.promptPreview), sessions };
}

/** 读取时过滤掉字段不完整或类型不对的条目，坏数据不影响其它分组。 */
function normalizeMember(value: unknown): MultiModelGroupMember | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.providerId !== "string") return null;
  if (typeof record.providerName !== "string") return null;
  if (typeof record.model !== "string") return null;
  if (typeof record.title !== "string") return null;
  if (!isEffort(record.effort)) return null;
  return {
    id: record.id,
    providerId: record.providerId,
    providerName: record.providerName,
    model: record.model,
    effort: record.effort,
    title: record.title,
  };
}

function normalizeGroup(value: unknown): MultiModelGroup | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.projectId !== "string" || record.projectId.length === 0) return null;
  if (typeof record.createdAt !== "string") return null;
  if (typeof record.promptPreview !== "string") return null;
  if (!Array.isArray(record.sessions)) return null;
  const sessions = record.sessions
    .map(normalizeMember)
    .filter((member): member is MultiModelGroupMember => member !== null);
  if (sessions.length === 0) return null;
  return {
    id: record.id,
    projectId: record.projectId,
    createdAt: record.createdAt,
    promptPreview: record.promptPreview,
    sessions,
  };
}

async function readGroupsFile(file: string): Promise<MultiModelGroup[]> {
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
    // 损坏的 JSON 视为空数组，后续写入会覆盖成合法内容。
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const groups: MultiModelGroup[] = [];
  for (const item of parsed) {
    const group = normalizeGroup(item);
    if (group) groups.push(group);
  }
  return groups;
}

/** 原子写：先写同目录临时文件，再 rename 覆盖目标。 */
async function writeGroupsFile(file: string, groups: MultiModelGroup[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(groups, null, 2)}\n`;
  await fs.promises.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 按项目保留最新的 MAX_GROUPS_PER_PROJECT 组；输入按“新记录在前”排列。 */
function capPerProject(groups: readonly MultiModelGroup[]): MultiModelGroup[] {
  const counts = new Map<string, number>();
  const kept: MultiModelGroup[] = [];
  for (const group of groups) {
    const count = counts.get(group.projectId) ?? 0;
    if (count >= MAX_GROUPS_PER_PROJECT) continue;
    counts.set(group.projectId, count + 1);
    kept.push(group);
  }
  return kept;
}

/** 同一 dataDir 的写操作串行化；不同 dataDir 之间互不影响。 */
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

function queueKey(dataDir: string): string {
  return path.resolve(dataDir);
}

/** 读取某个项目的分组（保持文件里的“最新在前”顺序）。 */
export async function listMultiModelGroups(
  dataDir: string,
  projectId: string,
): Promise<MultiModelGroup[]> {
  const groups = await readGroupsFile(groupsFile(dataDir));
  return groups
    .filter((group) => group.projectId === projectId)
    .slice(0, MAX_GROUPS_PER_PROJECT);
}

/** 新增一组对比记录；id / createdAt 由服务端生成，超出上限时丢弃最旧的。 */
export async function createMultiModelGroup(
  dataDir: string,
  projectId: string,
  input: ValidatedGroupInput,
): Promise<MultiModelGroup> {
  const target = groupsFile(dataDir);
  return runExclusive(queueKey(dataDir), async () => {
    const groups = await readGroupsFile(target);
    const group: MultiModelGroup = {
      id: randomUUID(),
      projectId,
      createdAt: new Date().toISOString(),
      promptPreview: input.promptPreview,
      sessions: input.sessions,
    };
    const next = capPerProject([group, ...groups]);
    await writeGroupsFile(target, next);
    return group;
  });
}

/** 删除一组记录；返回是否真的删除了（项目不匹配也视为没找到）。 */
export async function deleteMultiModelGroup(
  dataDir: string,
  projectId: string,
  groupId: string,
): Promise<boolean> {
  const target = groupsFile(dataDir);
  return runExclusive(queueKey(dataDir), async () => {
    const groups = await readGroupsFile(target);
    const next = groups.filter(
      (group) => !(group.id === groupId && group.projectId === projectId),
    );
    if (next.length === groups.length) return false;
    await writeGroupsFile(target, next);
    return true;
  });
}

const ROUTE = /^\/api\/projects\/([^/]+)\/multi-model-groups(?:\/([^/]+))?\/?$/;

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function projectExists(ctx: FeatureContext, projectId: string): boolean {
  return (ctx.config.projects ?? []).some((project) => project.id === projectId);
}

function failure(error: unknown): FeatureResult {
  if (error instanceof MultiModelGroupError) {
    return { status: 400, body: { error: error.message } };
  }
  throw error;
}

export async function handleMultiModelGroupRoutes(
  ctx: FeatureContext,
): Promise<FeatureResult | null> {
  const match = ROUTE.exec(ctx.url.pathname);
  if (!match) return null;
  const projectId = decodeSegment(match[1] ?? "");
  const groupId = match[2] === undefined ? undefined : decodeSegment(match[2]);
  const isCollection = groupId === undefined;

  const supported = isCollection
    ? ctx.method === "GET" || ctx.method === "POST"
    : ctx.method === "DELETE";
  if (!supported) {
    return { status: 405, body: { error: "不支持的方法" } };
  }

  if (!projectId || !projectExists(ctx, projectId)) {
    return { status: 404, body: { error: "找不到项目" } };
  }
  const dataDir = ctx.config.dataDir;

  try {
    if (isCollection) {
      if (ctx.method === "GET") {
        return { status: 200, body: { groups: await listMultiModelGroups(dataDir, projectId) } };
      }
      // POST：先校验请求体，再落盘。
      const body = await ctx.readJson(ctx.req);
      const input = validateGroupInput(projectId, body, (id) => ctx.store.get(id));
      const group = await createMultiModelGroup(dataDir, projectId, input);
      return { status: 201, body: { group } };
    }

    if (!groupId) return { status: 404, body: { error: "找不到对比记录" } };
    const removed = await deleteMultiModelGroup(dataDir, projectId, groupId);
    if (!removed) return { status: 404, body: { error: "找不到对比记录" } };
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return failure(error);
  }
}
