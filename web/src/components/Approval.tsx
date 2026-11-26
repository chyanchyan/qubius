import { useEffect, useId, useRef, useState } from "react";
import type { Pending } from "../api";
import { canRememberTool } from "../api";
import { mergeAnswers } from "../answers";
import { formatCountdown } from "../format";
import { useNow } from "../useNow";

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
    approvedFull?: boolean,
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
  /* 需要展开的确认默认折叠，用户看过完整输入后才能允许。 */
  const [expanded, setExpanded] = useState(false);
  /* 完整输入被截断时，用户还要单独确认已看过截断内容。 */
  const [confirmedTruncated, setConfirmedTruncated] = useState(false);
  const titleId = useId();
  const inputId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inline = variant === "inline";

  /* 新请求到达时把焦点移到标题，读屏和键盘用户不用在一堆消息里找确认框。
     列表里同时可能有好几个待回答项，自动聚焦会打断用户当前操作，所以跳过。 */
  useEffect(() => {
    if (!inline) headingRef.current?.focus();
  }, [inline, pending.requestId]);

  /* 新的确认请求不应继承上一次的答案、"本对话记住"或展开状态。 */
  useEffect(() => {
    setAnswers({});
    setCustomAnswers({});
    setRemember(false);
    setExpanded(false);
    setConfirmedTruncated(false);
  }, [pending.requestId]);

  const now = useNow(1_000);
  const permission = pending.kind === "permission";
  const inputText = pending.inputText ?? pending.inputPreview;
  const requiresExpand = permission && pending.requiresExpand === true;
  const truncated = permission && pending.inputTruncated === true;
  const rememberable = permission && canRememberTool(pending.toolName);
  /* 默认折叠；没有需要展开的内容时始终完整显示。 */
  const collapsed = requiresExpand && !expanded;
  /* 不按客户端时钟禁用按钮：倒计时只做提示，是否超时由服务端决定。 */
  const allowDisabled = busy || collapsed || (truncated && !confirmedTruncated);
  const expiresAt = pending.expiresAt ? Date.parse(pending.expiresAt) : Number.NaN;
  const remaining = Number.isFinite(expiresAt) ? expiresAt - now : null;

  const submit = (behavior: "allow" | "deny") => {
    if (busy) return;
    if (behavior === "allow" && allowDisabled) return;
    onAnswer(
      behavior,
      behavior === "allow" && pending.kind === "question"
        ? mergeAnswers(pending.questions, answers, customAnswers)
        : undefined,
      behavior === "allow" ? remember : undefined,
      behavior === "allow" && requiresExpand ? expanded : undefined,
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
      {permission && (
        <>
          {/* 完整输入原样展示（保留换行）；需要展开时先折叠，避免长命令把按钮顶出屏幕。 */}
          <pre
            id={inputId}
            className={`tool-body permit-input${collapsed ? " collapsed" : ""}`}
          >{inputText}</pre>
          {requiresExpand && (
            <button
              type="button"
              className="btn permit-expand"
              aria-expanded={expanded}
              aria-controls={inputId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起完整输入" : "展开完整命令"}
            </button>
          )}
          {truncated && (
            <p className="permit-truncated">输入过大已截断，仅显示前 64 KiB。</p>
          )}
          {truncated && (
            <label className="choice">
              <input
                type="checkbox"
                checked={confirmedTruncated}
                onChange={(event) => setConfirmedTruncated(event.target.checked)}
              />
              <span>我已确认截断内容</span>
            </label>
          )}
          {/* 只有文件写入类工具能「本对话记住」；命令和子 agent 每次都要确认。 */}
          {rememberable && (
            <label className="choice">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>本对话内允许这个目录的写入，不再逐次确认</span>
            </label>
          )}
        </>
      )}
      <div className="actions">
        <button className="btn-primary" disabled={allowDisabled} onClick={() => submit("allow")}>
          {pending.kind === "question" ? "提交回答" : "允许"}
        </button>
        <button className="btn" disabled={busy} onClick={() => submit("deny")}>拒绝</button>
      </div>
    </section>
  );
}
