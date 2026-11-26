import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Pending } from "../api";
import { mergeAnswers } from "../answers";
import { formatCountdown } from "../format";
import { useNow } from "../useNow";

/** 确认内容如果是 JSON，格式化后更好读；解析失败就保持服务端给的原文。 */
function formatInputPreview(preview: string): string {
  try {
    return JSON.stringify(JSON.parse(preview), null, 2);
  } catch {
    return preview;
  }
}

export interface ApprovalProps {
  pending: Pending;
  busy: boolean;
  /** detail 会给标题自动聚焦并用 alert 播报；inline 用于会话列表，不抢焦点。 */
  variant?: "detail" | "inline";
  /** behavior 为 allow 时带上合并后的答案（仅问题）；remember 只对权限确认有意义。 */
  onAnswer: (
    behavior: "allow" | "deny",
    answers?: Record<string, string>,
    remember?: boolean,
  ) => void;
}

/**
 * 提问 / 工具授权的回答表单。详情页和会话列表共用；答案状态放在组件内部，
 * 换到新的 requestId 时清空，避免上一个请求的答案或「本对话记住」被沿用。
 */
export function Approval({ pending, busy, variant = "detail", onAnswer }: ApprovalProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(false);
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inline = variant === "inline";

  /* 新请求到达时把焦点移到标题，读屏和键盘用户不用在一堆消息里找确认框。
     列表里同时可能有好几个待回答项，自动聚焦会打断用户当前操作，所以跳过。 */
  useEffect(() => {
    if (!inline) headingRef.current?.focus();
  }, [inline, pending.requestId]);

  /* 新的确认请求不应继承上一次的答案或“本对话记住”。 */
  useEffect(() => {
    setAnswers({});
    setCustomAnswers({});
    setRemember(false);
  }, [pending.requestId]);

  const now = useNow(1_000);
  const preview = useMemo(() => formatInputPreview(pending.inputPreview), [pending.inputPreview]);
  const expiresAt = pending.expiresAt ? Date.parse(pending.expiresAt) : Number.NaN;
  const remaining = Number.isFinite(expiresAt) ? expiresAt - now : null;

  const submit = (behavior: "allow" | "deny") => {
    if (busy) return;
    onAnswer(
      behavior,
      behavior === "allow" && pending.kind === "question"
        ? mergeAnswers(pending.questions, answers, customAnswers)
        : undefined,
      behavior === "allow" ? remember : undefined,
    );
  };

  return (
    <section
      className={`permit${inline ? " permit-inline" : ""}`}
      role={inline ? "group" : "alert"}
      aria-live={inline ? undefined : "assertive"}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} ref={headingRef} tabIndex={inline ? undefined : -1} className="permit-title">
        {pending.kind === "question" ? "需要你回答" : "需要你确认"}
      </h2>
      <p>{pending.toolName}{pending.blockedPath ? ` · ${pending.blockedPath}` : ""}</p>
      {remaining !== null && (
        <p
          className={remaining > 0 ? "permit-countdown" : "permit-countdown expired"}
          /* 每秒更新但不该被读屏连续播报；用户仍可导航到这里读取。 */
          aria-live="off"
        >
          {remaining > 0 ? `自动拒绝倒计时 ${formatCountdown(remaining)}` : "已超时，等待服务端处理"}
        </p>
      )}
      {pending.kind === "question" && pending.questions?.map((question) => (
        <fieldset key={question.question}>
          <legend>{question.header || question.question}</legend>
          {question.header && <p>{question.question}</p>}
          {question.options.map((option) => (
            <label key={option.label} className="choice">
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.question}
                checked={question.multiSelect
                  ? (answers[question.question] || "").split(", ").includes(option.label)
                  : answers[question.question] === option.label}
                onChange={() => {
                  // 选了预设项就不再使用自定义答复。
                  if (customAnswers[question.question]) {
                    setCustomAnswers({ ...customAnswers, [question.question]: "" });
                  }
                  if (!question.multiSelect) {
                    setAnswers({ ...answers, [question.question]: option.label });
                    return;
                  }
                  const current = new Set((answers[question.question] || "").split(", ").filter(Boolean));
                  if (current.has(option.label)) current.delete(option.label);
                  else current.add(option.label);
                  setAnswers({ ...answers, [question.question]: [...current].join(", ") });
                }}
              />
              <span>{option.label}{option.description ? ` — ${option.description}` : ""}</span>
            </label>
          ))}
          <label className="custom-answer">
            <span>{question.options.length ? "其他（自定义答复）" : "自定义答复"}</span>
            <input
              value={customAnswers[question.question] || ""}
              placeholder={question.options.length ? "不在选项里？直接输入" : "输入你的答复"}
              onChange={(event) => {
                setCustomAnswers({ ...customAnswers, [question.question]: event.target.value });
                // 手写答复覆盖预设项，避免界面上还显示着已选项。
                if (answers[question.question]) {
                  setAnswers({ ...answers, [question.question]: "" });
                }
              }}
            />
          </label>
        </fieldset>
      ))}
      {pending.kind === "permission" && <pre className="tool-body">{preview}</pre>}
      {pending.kind === "permission" && (
        <label className="choice">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>本对话内允许这个工具（{pending.toolName}），不再逐次确认</span>
        </label>
      )}
      <div className="actions">
        <button className="btn-primary" disabled={busy} onClick={() => submit("allow")}>
          {pending.kind === "question" ? "提交回答" : "允许"}
        </button>
        <button className="btn" disabled={busy} onClick={() => submit("deny")}>拒绝</button>
      </div>
    </section>
  );
}
