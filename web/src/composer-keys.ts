/**
 * 聊天输入框里 Enter 的语义：
 * - Enter / 发送按钮 → 排队（当前轮跑完后再执行）；
 * - Ctrl+Enter（macOS 上 Cmd+Enter）→ 插话，立刻交给正在跑的 agent；
 * - Shift+Enter 换行，输入法组词中的 Enter 交给输入法。
 */
export type SendMode = "queue" | "interject";

export interface EnterKeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** 优先用原生事件的 isComposing：IME 正在组词时不能提交。 */
  isComposing: boolean;
}

/** 返回这次 Enter 该怎么发送；不提交（换行/组词/其它键）返回 null。 */
export function enterSendMode(event: EnterKeyLike): SendMode | null {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  return event.ctrlKey || event.metaKey ? "interject" : "queue";
}
