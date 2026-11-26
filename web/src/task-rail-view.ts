/**
 * 后台任务栏的展示截断逻辑。
 *
 * 任务栏最多默认展示 MAX_TASKS 条，其余任务通过「显示全部」展开。排序和轮询
 * 由调用方负责，这里只决定当前应该渲染哪些任务，方便单独测试。
 */

/**
 * 返回当前应展示的任务。
 *
 * showAll 为 true 时返回全部任务的副本；否则取前 max 条。max 为负按 0 处理，
 * 始终返回新数组，不修改入参。
 */
export function taskRailTasks<T>(
  tasks: readonly T[],
  showAll: boolean,
  max: number,
): T[] {
  if (showAll) return [...tasks];
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : tasks.length;
  return tasks.slice(0, limit);
}
