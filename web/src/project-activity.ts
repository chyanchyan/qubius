import type { Phase, Session } from "./api";

/**
 * 项目活动灯的逻辑。只关心「哪些会话仍在推进」以及每个项目有几个这样的会话，
 * 不依赖 React/DOM，方便单独测试。
 */

/** 活跃会话 id → 所属项目 id；项目 id → 活跃会话数（只保留 > 0）。 */
export interface ProjectActivity {
  readonly sessions: ReadonlyMap<string, string>;
  readonly counts: ReadonlyMap<string, number>;
}

/** queued / running / needs_input 视为仍在推进。 */
export function isActivePhase(phase: Phase): boolean {
  return phase === "queued" || phase === "running" || phase === "needs_input";
}

export function emptyActivity(): ProjectActivity {
  return { sessions: new Map(), counts: new Map() };
}

/**
 * 对一条会话事件做增量更新。removed 或 phase 不再活跃时移除该会话；
 * 活跃时按当前项目计数（id 换项目要先从旧项目减掉）。
 * 状态没有变化时返回原对象（引用相等），方便调用方跳过重渲染。
 */
export function applyActivity(
  state: ProjectActivity,
  event: Pick<Session, "id" | "projectId" | "phase" | "updatedAt" | "removed">,
): ProjectActivity {
  const previous = state.sessions.get(event.id);
  const active = !event.removed && isActivePhase(event.phase);

  if (!active) {
    if (previous === undefined) return state;
    const sessions = new Map(state.sessions);
    sessions.delete(event.id);
    const counts = new Map(state.counts);
    const left = (counts.get(previous) ?? 1) - 1;
    if (left > 0) counts.set(previous, left);
    else counts.delete(previous);
    return { sessions, counts };
  }

  // 已经在同一项目里活跃，phase 在活跃态之间变化不影响灯。
  if (previous === event.projectId) return state;

  const sessions = new Map(state.sessions);
  const counts = new Map(state.counts);
  if (previous !== undefined) {
    const left = (counts.get(previous) ?? 1) - 1;
    if (left > 0) counts.set(previous, left);
    else counts.delete(previous);
  }
  sessions.set(event.id, event.projectId);
  counts.set(event.projectId, (counts.get(event.projectId) ?? 0) + 1);
  return { sessions, counts };
}

/**
 * 用整表快照重建状态，再重放请求期间收到的 SSE 事件。
 * 事件可能比快照旧（HTTP 响应与 SSE 通道到达顺序不保证）：
 * - removed 事件一律应用；
 * - 非 removed 事件只在该 id 不在快照里、或 event.updatedAt 严格大于快照里的 updatedAt 时应用，
 *   避免旧事件把较新的快照状态改回去。
 */
export function mergeActivity(
  snapshot: Iterable<Pick<Session, "id" | "projectId" | "phase" | "updatedAt">>,
  events: Iterable<Pick<Session, "id" | "projectId" | "phase" | "updatedAt" | "removed">>,
): ProjectActivity {
  // 快照可能是一次性迭代器，先物化一份并记录 updatedAt 供事件比对。
  const known = new Map<string, Pick<Session, "id" | "projectId" | "phase" | "updatedAt">>();
  const sessions = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const item of snapshot) {
    if (known.has(item.id)) continue;
    known.set(item.id, item);
    if (!isActivePhase(item.phase)) continue;
    sessions.set(item.id, item.projectId);
    counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  }

  let state: ProjectActivity = { sessions, counts };
  for (const event of events) {
    const previous = known.get(event.id);
    // ISO 8601 时间串按字典序比较与时间先后一致。
    if (!event.removed && previous && event.updatedAt <= previous.updatedAt) continue;
    state = applyActivity(state, event);
  }
  return state;
}

/** 当前有活跃会话的项目 id 集合。 */
export function activeProjectIds(state: ProjectActivity): Set<string> {
  return new Set(state.counts.keys());
}
