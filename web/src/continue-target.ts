import type { Session } from "./api";

/** 「继续上次」实际要重跑的东西。 */
export type ContinueKind = "discussion" | "role" | "message";

/**
 * 选择「继续上次」的目标：
 * - 有参与者的讨论会话直接重跑讨论，不发「继续」正文；
 * - 当前工作流仍是 prl-role 且保留了团队时重跑整支团队；
 * - 其余情况发普通「继续」消息（沿用 workflow.skill）。
 *
 * 必须同时看 workflow.skill：角色团队跑完后用户切到普通/plan/ser，
 * roleRun 可能还留着上一轮的团队，点继续不能误触发改代码的角色运行。
 */
export function continueKind(session: Session): ContinueKind {
  if (session.discussion && session.discussion.participants.length > 0) return "discussion";
  if (session.workflow?.skill === "prl-role" && session.roleRun?.team) return "role";
  return "message";
}
