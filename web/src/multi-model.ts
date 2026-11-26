import { EFFORTS, type Effort, type Phase, type Provider, type Session } from "./api";
import type { SessionUsage } from "./api-usage";
import type { MultiModelGroup, MultiModelGroupMember } from "./api-multi-model";
import type { RunSelection } from "./run-selection";

/**
 * 多模型并行对比的纯逻辑：选择组合校验、prompt 摘要、状态与成本聚合。
 * 分组记录由服务端持久化（见 api-multi-model），这里只处理纯函数，方便单独测试。
 */

export type { MultiModelGroup, MultiModelGroupMember };
/** 兼容旧名字：对比分组里的一个会话快照。 */
export type GroupMember = MultiModelGroupMember;

/** 一次对比至少选两个模型，最多 4 个。 */
export const MIN_SELECTIONS = 2;
export const MAX_SELECTIONS = 4;
/** 对比记录里显示的 prompt 摘要长度。 */
export const PROMPT_PREVIEW_LIMIT = 80;

/** provider + model + effort 的组合标识；用 NUL 分隔避免字段拼接歧义。 */
export function selectionKey(selection: RunSelection): string {
  return `${selection.providerId}\u0000${selection.model}\u0000${selection.effort}`;
}

/** 返回与前面某一行完全重复的行下标（从 0 开始），第一行不算重复。 */
export function duplicateSelectionIndexes(selections: readonly RunSelection[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  selections.forEach((selection, index) => {
    const key = selectionKey(selection);
    if (seen.has(key)) duplicates.push(index);
    else seen.add(key);
  });
  return duplicates;
}

export interface SelectionValidation {
  ok: boolean;
  error?: string;
}

/**
 * 提交前校验：行数在 2~4 之间，每行都选了接口和模型，且组合互不重复。
 * 返回用户可读的错误文案。
 */
export function validateSelections(selections: readonly RunSelection[]): SelectionValidation {
  if (selections.length < MIN_SELECTIONS) {
    return { ok: false, error: `至少选择 ${MIN_SELECTIONS} 个模型` };
  }
  if (selections.length > MAX_SELECTIONS) {
    return { ok: false, error: `最多选择 ${MAX_SELECTIONS} 个模型` };
  }
  if (selections.some((selection) => !selection.providerId)) {
    return { ok: false, error: "每一行都要选择接口" };
  }
  if (selections.some((selection) => !selection.model)) {
    return { ok: false, error: "每一行都要选择模型" };
  }
  const duplicates = duplicateSelectionIndexes(selections);
  if (duplicates.length > 0) {
    return {
      ok: false,
      error: `第 ${duplicates.map((index) => index + 1).join("、")} 行与前面的模型组合重复`,
    };
  }
  return { ok: true };
}

/**
 * 为新增行挑一个尚未使用的组合：优先沿用当前 effort，依次尝试各接口的模型；
 * 全部用过时退回 fallback。
 */
export function nextSelection(
  providers: readonly Provider[],
  used: readonly RunSelection[],
  fallback: RunSelection,
): RunSelection {
  const usedKeys = new Set(used.map(selectionKey));
  const efforts: Effort[] = [fallback.effort, ...EFFORTS.filter((effort) => effort !== fallback.effort)];
  for (const effort of efforts) {
    for (const provider of providers) {
      const models = provider.models.length > 0 ? provider.models : [""];
      for (const model of models) {
        const candidate: RunSelection = { providerId: provider.id, model, effort };
        if (!usedKeys.has(selectionKey(candidate))) return candidate;
      }
    }
  }
  return { ...fallback };
}

/** prompt 摘要：折叠空白、去掉首尾空格，超长时截断并加省略号。 */
export function promptPreview(text: string | null | undefined, limit = PROMPT_PREVIEW_LIMIT): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * 异步响应能否写回状态：组件仍挂载、请求仍是最新一次、且没有被中止。
 * 用于丢弃切项目/重复刷新后才到达的旧响应。
 */
export function isCurrentResponse(options: {
  mounted: boolean;
  seq: number;
  currentSeq: number;
  aborted: boolean;
}): boolean {
  return options.mounted && options.seq === options.currentSeq && !options.aborted;
}

/** 只看当前项目的分组（保持服务端返回的“最新在前”顺序）。 */
export function groupsForProject(
  groups: readonly MultiModelGroup[],
  projectId: string,
): MultiModelGroup[] {
  return groups.filter((group) => group.projectId === projectId);
}

/** 对比面板里一行的最新状态。 */
export interface GroupMemberStatus {
  id: string;
  title: string;
  providerName: string;
  model: string;
  effort: Effort;
  /** 会话已不在项目列表里（被删除）或尚未刷新时是 "unknown"。 */
  phase: Phase | "unknown";
  branch?: string;
  /** getUsage().bySession 里匹配到的成本；没有数据时缺省。 */
  cost?: number;
  /** 这次刷新能否在会话列表里找到它。 */
  present: boolean;
}

/**
 * 把分组快照和最新会话/用量合并成展示行。会话列表或用量还没加载时按快照显示，
 * 状态标为 unknown，present 为 false。
 */
export function groupMemberStatuses(
  group: MultiModelGroup,
  sessions: readonly Session[] | null | undefined,
  usage: readonly SessionUsage[] | null | undefined,
): GroupMemberStatus[] {
  const sessionsById = new Map<string, Session>();
  for (const session of sessions ?? []) sessionsById.set(session.id, session);
  const usageById = new Map<string, number>();
  for (const item of usage ?? []) usageById.set(item.id, item.cost);

  return group.sessions.map((member) => {
    const session = sessionsById.get(member.id);
    const cost = usageById.get(member.id);
    return {
      id: member.id,
      title: session?.title || member.title,
      providerName: session?.providerName || member.providerName,
      model: session?.model || member.model,
      effort: session?.effort || member.effort,
      phase: session?.phase ?? "unknown",
      branch: session?.branch,
      cost: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
      present: Boolean(session),
    };
  });
}

export interface GroupSummary {
  total: number;
  /** 所有能匹配到的会话成本之和。 */
  cost: number;
  running: number;
  completed: number;
  failed: number;
}

/** 分组头部用的聚合：总数、总成本、进行中/完成/失败数量。 */
export function summarizeMembers(statuses: readonly GroupMemberStatus[]): GroupSummary {
  let cost = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const status of statuses) {
    if (typeof status.cost === "number" && Number.isFinite(status.cost)) cost += status.cost;
    switch (status.phase) {
      case "queued":
      case "running":
      case "needs_input":
      case "setup":
        running += 1;
        break;
      case "completed":
        completed += 1;
        break;
      case "failed":
      case "stopped":
        failed += 1;
        break;
      default:
        break;
    }
  }
  return { total: statuses.length, cost, running, completed, failed };
}
