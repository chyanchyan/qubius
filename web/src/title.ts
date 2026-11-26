/** 页面标题的唯一来源：路由名 + 全局待处理计数。
 *  页面直接改 document.title 会互相覆盖，统一走这里。 */

let baseTitle = "";
let basePriority = 0;
let attentionCount = 0;

/** 有等待确认或失败的会话时在标签页标题前加计数。 */
export function composeTitle(base: string, attention: number): string {
  if (!base) return "";
  return attention > 0 ? `(${attention}) ${base}` : base;
}

/** 路由级标题优先级低于页面加载后细化出来的标题（如项目名/会话标题）。 */
export function shouldApplyTitle(current: number, next: number, force: boolean): boolean {
  return force || next >= current;
}

/**
 * @param priority 0=路由兜底标题，1=页面数据细化后的标题
 * @param force 路由变化时强制重置优先级，允许新的兜底标题覆盖旧页面
 */
export function setBaseTitle(title: string, priority = 0, force = false): void {
  if (!shouldApplyTitle(basePriority, priority, force)) return;
  baseTitle = title;
  basePriority = priority;
  apply();
}

export function setAttentionCount(count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (next === attentionCount) return;
  attentionCount = next;
  apply();
}

function apply(): void {
  if (typeof document === "undefined") return;
  document.title = composeTitle(baseTitle, attentionCount);
}
