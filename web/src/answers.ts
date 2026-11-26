import type { Pending, PendingQuestion } from "./api";

/**
 * 把预设选项和自定义输入合成最终答案。
 * 每个问题以自定义输入为准（用户手写的内容覆盖已选项），没有再退回选项。
 */
export function mergeAnswers(
  questions: PendingQuestion[] | undefined,
  selected: Record<string, string>,
  custom: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const question of questions ?? []) {
    const key = question.question;
    const typed = (custom[key] ?? "").trim();
    if (typed) result[key] = typed;
    else if (selected[key]) result[key] = selected[key];
  }
  return result;
}

/** POST /api/sessions/:id/answer 的请求体。 */
export interface AnswerBody {
  requestId: string;
  behavior: "allow" | "deny";
  answers?: Record<string, string>;
  remember?: boolean;
}

/**
 * 按确认类型筛请求字段：问题只带 answers，工具授权只带 remember；
 * 拒绝时不携带答案，避免把界面上残留的选项发给服务端。
 */
export function answerBody(
  pending: Pick<Pending, "requestId" | "kind">,
  behavior: "allow" | "deny",
  answers?: Record<string, string>,
  remember?: boolean,
): AnswerBody {
  return {
    requestId: pending.requestId,
    behavior,
    ...(behavior === "allow" && pending.kind === "question" && answers ? { answers } : {}),
    ...(behavior === "allow" && pending.kind === "permission" && remember ? { remember: true } : {}),
  };
}
