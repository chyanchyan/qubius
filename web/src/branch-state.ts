import type { Phase } from "./api";
import { isActivePhase } from "./project-activity";

/**
 * 会话分支灯的状态。分支标签用底色区分会话走到哪一步：
 *
 * - starting：已发言，当前这一轮还在进行，还没有未提交改动（灰）。
 * - dirty：有改动但还没有提交（橙）。
 * - unmerged：分支有提交，但还没合入基准分支（黄）。
 * - merged：分支已经合入基准分支（绿）。
 * - untouched：已经做过一轮答复，且没有任何代码改动（浅绿）。
 *
 * 归档安全性和灯序无关：橙灯最需要提醒，归档会连同未提交的改动一起删掉。
 */
export type BranchLamp = "starting" | "dirty" | "unmerged" | "merged" | "untouched";

export interface BranchLampInput {
  /** 分支是否已合入基准分支；合入状态还没加载时为 undefined。 */
  merged?: boolean;
  /** 分支创建后从未提交过代码（tip 仍是创建时的提交）。 */
  untouched?: boolean;
  /** 分支所在的 worktree 里有未提交改动。 */
  dirty?: boolean;
  /** 当前这一轮还在进行（queued / running / needs_input）。 */
  active?: boolean;
}

export function branchLampState(input: BranchLampInput): BranchLamp | undefined {
  // 未提交的改动会随归档一起删除，优先级高于其它状态。
  if (input.dirty) return "dirty";
  // 消息刚发出去、这一轮还在推进：先显示灰灯，表明 agent 正在处理，
  // 还没有可判断的结果。合入状态是否加载都不影响这个反馈。
  if (input.active) return "starting";
  if (input.untouched) return "untouched";
  // 合入状态还没加载时不着色。
  if (input.merged === undefined) return undefined;
  return input.merged ? "merged" : "unmerged";
}

/** 项目列表里各灯色的优先级：橙 > 黄 > 浅绿 > 绿 > 灰。 */
const PROJECT_LAMP_ORDER: readonly BranchLamp[] = [
  "dirty",
  "unmerged",
  "untouched",
  "merged",
  "starting",
];

/** 项目里一个会话的灯相关信息；只关心分支和当前 phase。 */
export interface ProjectLampSession {
  branch?: string;
  phase: Phase;
}

/** 项目分支状态；找不到基准分支时 mergedKnown 为 false。 */
export interface ProjectBranchStatus {
  mergedKnown: boolean;
  merged: ReadonlySet<string>;
  untouched: ReadonlySet<string>;
  dirty: ReadonlySet<string>;
}

/**
 * 项目列表的灯：先算出项目里每个会话分支的灯色，再按 橙 > 黄 > 浅绿 > 绿 > 灰
 * 取第一个存在的状态。项目没有任何分支（包括还没有会话）时返回 undefined，
 * 界面显示空心灯。
 */
export function projectLampState(
  sessions: readonly ProjectLampSession[],
  status: ProjectBranchStatus,
): BranchLamp | undefined {
  const present = new Set<BranchLamp>();
  for (const session of sessions) {
    if (!session.branch) continue;
    const state = branchLampState({
      merged: status.mergedKnown ? status.merged.has(session.branch) : undefined,
      untouched: status.untouched.has(session.branch),
      dirty: status.dirty.has(session.branch),
      active: isActivePhase(session.phase),
    });
    if (state) present.add(state);
  }
  return PROJECT_LAMP_ORDER.find((state) => present.has(state));
}
