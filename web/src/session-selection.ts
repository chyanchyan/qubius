import type { Session } from "./api";
import { isActivePhase } from "./project-activity";

/**
 * 会话列表的多选与「继续」判定。
 *
 * 选中状态用 id 集合保存：列表刷新、SSE 更新会替换 Session 对象本身，
 * 引用比较不可靠；id 才是稳定标识。集合按不可变方式更新，方便 React 跳过
 * 未变化的渲染。
 */

/** 中断或失败后可以「继续上次」的会话。 */
export function canContinue(session: Pick<Session, "phase">): boolean {
  return session.phase === "failed" || session.phase === "stopped";
}

/** 切换单个会话的选中态，返回新集合。 */
export function toggleSelected(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * 丢弃列表里已经不存在的选中项；全部仍存在时返回原集合，
 * 避免每次列表刷新都触发一次无意义的重渲染。
 */
export function pruneSelected(
  current: ReadonlySet<string>,
  sessions: readonly Session[],
): ReadonlySet<string> {
  if (current.size === 0) return current;
  const live = new Set(sessions.map((session) => session.id));
  const next = new Set<string>();
  for (const id of current) {
    if (live.has(id)) next.add(id);
  }
  return next.size === current.size ? current : next;
}

/** 按列表顺序返回选中且仍存在的会话，供批量操作使用。 */
export function pickSelected(
  current: ReadonlySet<string>,
  sessions: readonly Session[],
): Session[] {
  return current.size === 0 ? [] : sessions.filter((session) => current.has(session.id));
}

/** 「全部归档」始终跳过的会话：运行中（queued / running / needs_input）归档会打断正在进行的轮次。 */
export function clearAllCandidates(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => !isActivePhase(session.phase));
}

/**
 * 「全部归档」的目标会话。开关打开时只归档分支已经合入基准分支、且没有
 * 未提交改动的会话：未合入的分支、没有分支的会话以及橙灯（有改动没提交）
 * 都保留，避免删掉 main 里还没有的改动、或删掉还没提交的文件。
 * 从未改过代码的分支（浅绿灯）同样算已合入，归档它不会丢掉任何代码，因此
 * 也会被归档。关掉开关时归档所有非运行中的会话。
 */
export function pickArchiveTargets(
  sessions: readonly Session[],
  onlyMerged: boolean,
  mergedBranches: ReadonlySet<string>,
  dirtyBranches: ReadonlySet<string> = new Set(),
): Session[] {
  const candidates = clearAllCandidates(sessions);
  if (!onlyMerged) return candidates;
  return candidates.filter((session) => Boolean(
    session.branch
      && mergedBranches.has(session.branch)
      && !dirtyBranches.has(session.branch),
  ));
}
