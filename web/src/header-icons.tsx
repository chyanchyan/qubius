/* 顶栏的小图标：统一 16×16 视框，尺寸交给 CSS 跟随 --control-scale。
   描边图标用 currentColor，颜色由按钮/指示器决定。 */
import type { AccessMode } from "./access-mode";

const strokeIcon = {
  viewBox: "0 0 16 16",
  "aria-hidden": "true",
  focusable: "false",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 访问模式指示：本机是显示器，局域网是互联节点，公网是地球。 */
export function AccessModeIcon({ mode, className }: { mode: AccessMode; className?: string }) {
  if (mode === "local") {
    return (
      <svg {...strokeIcon} className={className}>
        <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.3" />
        <path d="M5.5 13.5h5M8 11v2.5" />
      </svg>
    );
  }
  if (mode === "lan") {
    return (
      <svg {...strokeIcon} className={className}>
        <circle cx="8" cy="8" r="2.1" />
        <circle cx="3" cy="3.5" r="1.2" />
        <circle cx="13" cy="3.5" r="1.2" />
        <circle cx="3" cy="12.5" r="1.2" />
        <circle cx="13" cy="12.5" r="1.2" />
        <path d="M4.1 4.6 6.4 6.6M11.9 4.6 9.6 6.6M4.1 11.4 6.4 9.4M11.9 11.4 9.6 9.4" />
      </svg>
    );
  }
  return (
    <svg {...strokeIcon} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.9 2.7 4 2.7 6S9.8 12.1 8 14c-1.8-1.9-2.7-4-2.7-6S6.2 3.9 8 2Z" />
    </svg>
  );
}

/** 字号按钮：字母 A 加一个减号/加号，窄屏时代替「小」「大」。 */
export function FontSizeIcon({ direction, className }: { direction: "down" | "up"; className?: string }) {
  return (
    <svg {...strokeIcon} className={className}>
      <path d="M2.5 12.5 6 3.5l3.5 9M3.8 9.5h4.4" />
      <path d={direction === "down" ? "M11 12.5h4" : "M11 12.5h4M13 10.5v4"} />
    </svg>
  );
}

/** 顶栏「更多」菜单。 */
export function MoreIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" className={className}>
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/** 顶栏「刷新」按钮。 */
export function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"
      />
      <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466" />
    </svg>
  );
}
