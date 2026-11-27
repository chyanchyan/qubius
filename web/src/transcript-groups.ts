import type { Transcript } from "./api";

/**
 * 对话渲染分组：连续的「活动条目」（工具调用和思考）合成一组，用户消息和
 * assistant 正文各自独立成组。简要/精简视图把每组折成一行摘要（简要档进行中
 * 自动展开每一步），详细视图原样平铺。
 */
export interface ActivityGroup {
  kind: "activity";
  /** 稳定 key：组内第一条的 id（组只会从头部插入/整体消失，尾部落定时不变）。 */
  key: string;
  items: Transcript[];
  /** 组内工具调用条数（思考不计入）。 */
  toolCount: number;
  /** 组内思考条数。 */
  thinkingCount: number;
  /** 组内有失败的工具调用：汇总行标红，简要档还会自动展开失败项。 */
  failed: boolean;
  /** 组内还有流式中的条目：汇总行用运行色，简要档据此自动展开。 */
  active: boolean;
}

export type TranscriptGroup =
  | { kind: "user"; key: string; item: Transcript }
  | {
    kind: "assistant";
    key: string;
    item: Transcript;
    /** 本轮第一条可标模型的回答：在回答开头显示这一轮使用的模型。 */
    showModel: boolean;
  }
  | ActivityGroup;

/**
 * 空正文的条目现在不渲染，分组时一并跳过，避免它们把活动组切成两段。
 * 用户消息恒可渲染（可能只有图片没有文字），工具调用恒可渲染；
 * assistant 正文和思考只有正文为空时才跳过。
 */
function renders(item: Transcript): boolean {
  if (item.role === "user" || item.role === "tool") return true;
  return Boolean(item.text);
}

function isActivity(item: Transcript): boolean {
  return item.role === "tool" || item.kind === "thinking";
}

function activityGroup(items: Transcript[]): ActivityGroup {
  return {
    kind: "activity",
    key: items[0].id,
    items,
    toolCount: items.filter((item) => item.role === "tool").length,
    thinkingCount: items.filter((item) => item.kind === "thinking").length,
    failed: items.some((item) => item.toolStatus === "error"),
    active: items.some((item) => item.partial === true),
  };
}

/** 活动组折叠成一行时的标题和明细。 */
export interface ActivitySummary {
  /** 主标题，例如「执行 6 步」「思考 2 段」。 */
  title: string;
  /** 工具名直方图，例如「Bash ×3 · Read ×2 · 思考」。 */
  meta: string;
}

/** 折叠行的摘要：标题按工具/思考二选一，明细按工具名计数降序。 */
export function summarizeActivity(group: ActivityGroup): ActivitySummary {
  const counts = new Map<string, number>();
  for (const item of group.items) {
    if (item.role !== "tool") continue;
    const name = item.toolName || "工具";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  if (group.thinkingCount > 0) {
    parts.push(group.thinkingCount > 1 ? `思考 ×${group.thinkingCount}` : "思考");
  }
  return {
    title: group.toolCount > 0 ? `执行 ${group.toolCount} 步` : `思考 ${group.thinkingCount} 段`,
    meta: parts.join(" · "),
  };
}

/** 按顺序切成用户消息 / assistant 正文 / 连续活动三组。 */
export function groupTranscript(items: Transcript[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let run: Transcript[] = [];
  // 每条用户消息开启新一轮；本轮第一条带 model 的 assistant 正文负责显示模型，
  // 后面的正文（工具调用之间的补充说明）不重复占位。活动组不打断这个等待。
  // 初始就视为等待：历史分页/手机重连后可见窗口常常从一轮中间开始，用户消息
  // 已经翻到窗口之外，第一段正文仍要标出模型，否则长回合里永远看不到模型名。
  let awaitingTurnModel = true;
  const flush = () => {
    if (run.length > 0) groups.push(activityGroup(run));
    run = [];
  };
  for (const item of items) {
    if (!renders(item)) continue;
    if (isActivity(item)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.role === "user") {
      groups.push({ kind: "user", key: item.id, item });
      awaitingTurnModel = true;
      continue;
    }
    const showModel = awaitingTurnModel && Boolean(item.model);
    if (showModel) awaitingTurnModel = false;
    groups.push({ kind: "assistant", key: item.id, item, showModel });
  }
  flush();
  return groups;
}
