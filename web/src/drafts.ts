import { MAX_TEXT_ATTACHMENTS, MAX_TEXT_TOTAL_CHARS, type TextAttachment } from "./text-attachments";

/**
 * 未发送输入的本地草稿。切走会话、刷新或被手机回收后恢复文本和文本附件；
 * 图片附件体积大且重新读取需要用户手势，不写入存储。
 */

export const DRAFT_VERSION = 1;
export const DRAFT_PREFIX = "qcoder:draft:";
const MAX_DRAFT_BYTES = 1_000_000;

export interface Draft {
  text: string;
  texts: TextAttachment[];
  savedAt: number;
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredDraft {
  v: number;
  text: string;
  texts: Array<{ name: string; content: string; bytes: number }>;
  savedAt: number;
}

export function projectDraftKey(projectId: string): string {
  return `${DRAFT_PREFIX}project:${projectId}`;
}

export function sessionDraftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}session:${sessionId}`;
}

/** 只接受结构完整的草稿；损坏或被手动改过的条目直接丢弃，不阻塞页面。 */
export function parseDraft(raw: string | null | undefined): Draft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const stored = parsed as Partial<StoredDraft>;
  if (stored.v !== DRAFT_VERSION || typeof stored.text !== "string") return null;
  if (!Array.isArray(stored.texts)) return null;
  if (typeof stored.savedAt !== "number" || !Number.isFinite(stored.savedAt)) return null;

  const texts: TextAttachment[] = [];
  let totalChars = 0;
  for (const item of stored.texts.slice(0, MAX_TEXT_ATTACHMENTS)) {
    if (!item || typeof item !== "object") continue;
    const { name, content, bytes } = item as { name?: unknown; content?: unknown; bytes?: unknown };
    if (typeof name !== "string" || typeof content !== "string") continue;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) continue;
    if (totalChars + content.length > MAX_TEXT_TOTAL_CHARS) continue;
    totalChars += content.length;
    texts.push({ name, content, bytes });
  }
  return { text: stored.text, texts, savedAt: stored.savedAt };
}

export function serializeDraft(draft: Draft): string {
  const stored: StoredDraft = {
    v: DRAFT_VERSION,
    text: draft.text,
    texts: draft.texts.slice(0, MAX_TEXT_ATTACHMENTS).map(({ name, content, bytes }) => ({ name, content, bytes })),
    savedAt: draft.savedAt,
  };
  return JSON.stringify(stored);
}

export function hasDraftContent(draft: Pick<Draft, "text" | "texts">): boolean {
  return draft.text.trim().length > 0 || draft.texts.length > 0;
}

export function createDraftStore(storage: DraftStorage | null) {
  function load(key: string): Draft | null {
    if (!storage) return null;
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      return null;
    }
    const draft = parseDraft(raw);
    if (raw && !draft) {
      try {
        storage.removeItem(key);
      } catch {
        // 清理失败不影响使用。
      }
    }
    return draft;
  }

  function save(key: string, draft: Draft): boolean {
    if (!storage) return false;
    if (!hasDraftContent(draft)) {
      clear(key);
      return true;
    }
    try {
      const raw = serializeDraft(draft);
      if (raw.length > MAX_DRAFT_BYTES) return false;
      storage.setItem(key, raw);
      return true;
    } catch {
      // 隐私模式或配额已满：草稿只是辅助功能，失败不影响发送。
      return false;
    }
  }

  function clear(key: string): void {
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      // 忽略。
    }
  }

  return { load, save, clear };
}

function browserStorage(): DraftStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export const draftStore = createDraftStore(browserStorage());
