import type { ReactNode } from "react";

/** 页面内提示、连接状态和加载占位。所有组件都用 ui.css 里的变量/样式。 */

export type NoticeTone = "error" | "warn" | "info" | "success";

export interface NoticeAction {
  label: string;
  onClick: () => void;
  busy?: boolean;
}

export function Notice({
  tone = "error",
  children,
  action,
  onDismiss,
  className,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  action?: NoticeAction;
  onDismiss?: () => void;
  className?: string;
}) {
  const urgent = tone === "error" || tone === "warn";
  return (
    <div
      className={`notice notice-${tone}${className ? ` ${className}` : ""}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <div className="notice-text">{children}</div>
      {action && (
        <button
          type="button"
          className="text-btn notice-action"
          disabled={action.busy}
          onClick={action.onClick}
        >
          {action.busy ? "处理中…" : action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="notice-close"
          aria-label="关闭提示"
          onClick={onDismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

/**
 * EventSource 没有状态 API，这里按连接事件维护一个粗略状态：
 * 首次连接时保持安静，断线后提示重连，长时间连不上则给出手动重试。
 */
export function ConnectionBanner({
  status,
  onRetry,
}: {
  status: LiveStatus;
  onRetry?: () => void;
}) {
  if (status === "live" || status === "connecting") return null;
  if (status === "reconnecting") {
    return (
      <Notice tone="warn" className="connection-banner">
        连接中断，正在重连；这期间的进度可能不是最新的…
      </Notice>
    );
  }
  return (
    <Notice
      tone="error"
      className="connection-banner"
      action={onRetry ? { label: "重新连接", onClick: onRetry } : undefined}
    >
      与服务器的连接已断开，页面暂时收不到新消息。
    </Notice>
  );
}

export function Skeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`skeleton${className ? ` ${className}` : ""}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton-line" />
      ))}
    </div>
  );
}

export function PageLoading({ label = "正在加载" }: { label?: string }) {
  return (
    <section className="page center-note" role="status" aria-live="polite">
      <p className="muted">{label}</p>
      <Skeleton lines={3} className="skeleton-page" />
    </section>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = "重试",
}: {
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <section className="page center-note" role="alert">
      <p className="error">{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </section>
  );
}

/** 列表/区块级别的加载占位；保留当前内容时不要用。 */
export function InlineLoading({ label }: { label: string }) {
  return (
    <p className="muted inline-loading" role="status" aria-live="polite">
      <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>
      {label}
    </p>
  );
}
