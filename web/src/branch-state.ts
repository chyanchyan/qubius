/**
 * 会话分支灯的状态。分支标签用底色区分会话走到哪一步：
 *
 * - starting：已发言，当前正在首轮答复，还没有任何改动（灰）。
 * - dirty：有改动但还没有提交（橙）。
 * - unmerged：分支有提交，但还没合入基准分支（黄）。
 * - merged：分支已经合入基准分支（绿）。
 * - untouched：已经做过一轮答复，且没有任何代码改动（蓝）。
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
  /** 当前这一轮之前已经有过 agent 答复。 */
  earlierReply?: boolean;
}

export function branchLampState(input: BranchLampInput): BranchLamp | undefined {
  // 未提交的改动会随归档一起删除，优先级高于合入状态和蓝灯。
  if (input.dirty) return "dirty";
  if (input.untouched) {
    // 首轮答复中还没有任何结果，用灰灯；做过一轮答复再来判断蓝灯。
    // 旧服务端不返回 earlierReply，按已有答复处理，保持原来的蓝灯。
    return input.active && input.earlierReply === false ? "starting" : "untouched";
  }
  // 合入状态还没加载时不着色。
  if (input.merged === undefined) return undefined;
  return input.merged ? "merged" : "unmerged";
}
