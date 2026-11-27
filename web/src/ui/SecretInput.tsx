import { useState, type InputHTMLAttributes } from "react";

/**
 * 带「显示明文」按钮的密码/令牌输入框。
 *
 * 眼睛按钮绝对定位在输入框右侧，不改变外层 .field / .field-control 的布局；
 * 外层还有操作按钮（例如「重置密码」）时二者并排。切换只影响本地渲染，
 * 不会把明文写到任何地方。
 */
export function SecretInput({
  className,
  revealLabel,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
  /** 字段名，只用于按钮的无障碍文案，例如「显示局域网登录密码明文」。 */
  revealLabel?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? `隐藏${revealLabel ?? ""}明文` : `显示${revealLabel ?? ""}明文`;
  return (
    <span className="secret-input">
      <input {...props} type={revealed ? "text" : "password"} className={className} />
      <button
        type="button"
        className="secret-toggle"
        disabled={props.disabled}
        aria-label={label}
        title={label}
        aria-pressed={revealed}
        /* 按下时不让按钮抢走输入框焦点，切换后还能接着输入。 */
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="2" />
            <path d="M2.5 2.5l11 11" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="2" />
          </svg>
        )}
      </button>
    </span>
  );
}
