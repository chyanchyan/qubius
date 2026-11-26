import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { draftStore, hasDraftContent, type Draft } from "./drafts";
import type { TextAttachment } from "./text-attachments";

/**
 * 输入框草稿：进入页面恢复文本和文本附件，输入后防抖保存，
 * 发送成功或离开页面时清空/补存，避免刚输入就返回时丢字。
 * 图片附件不持久化（体积大且重新读取需要用户手势）。
 */

const SAVE_DEBOUNCE_MS = 400;

export interface DraftPersistence {
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  /** 本次进入页面时确实恢复了内容。 */
  restored: boolean;
  dismissRestored: () => void;
  /** 发送/创建成功后调用：清空本地草稿并同步清空输入框。 */
  clearDraft: () => void;
}

function readDraft(key: string): Draft | null {
  const draft = draftStore.load(key);
  return draft && hasDraftContent(draft) ? draft : null;
}

export function useDraftPersistence(
  storageKey: string,
  texts: TextAttachment[],
  restoreTexts: (texts: TextAttachment[]) => void,
): DraftPersistence {
  /* 首次挂载直接按当前 key 初始化，避免空输入框先渲染一帧再被草稿覆盖，
     也避免空值在恢复完成前把已存草稿清掉。项目/会话页都带 key 重新挂载，
     下面的 key 变化逻辑只是额外保护。 */
  const [initialDraft] = useState<Draft | null>(() => readDraft(storageKey));
  const initialRef = useRef(initialDraft);
  const [prompt, setPrompt] = useState(() => initialRef.current?.text ?? "");
  const [restored, setRestored] = useState(() => initialRef.current !== null);

  const latest = useRef({ text: prompt, texts });
  const hydratedKey = useRef(storageKey);
  const timer = useRef(0);
  const restoreRef = useRef(restoreTexts);

  useLayoutEffect(() => {
    restoreRef.current = restoreTexts;
  });

  /* 恢复文本附件只能发生在提交之后；图片不恢复。 */
  useLayoutEffect(() => {
    const draft = initialRef.current;
    if (draft && draft.texts.length > 0) restoreRef.current(draft.texts);
    // 只在首次挂载恢复一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 每次提交后记录最新值，供防抖保存和卸载前 flush 使用。 */
  useLayoutEffect(() => {
    latest.current = { text: prompt, texts };
  });

  const flushKey = useCallback((key: string, value: { text: string; texts: TextAttachment[] }) => {
    if (!key) return;
    draftStore.save(key, { text: value.text, texts: value.texts, savedAt: Date.now() });
  }, []);

  /* 同一个组件里切换 key 时（正常路由由 key 重新挂载），先补存旧 key，
     再恢复新 key；不能让旧草稿落到新会话上。 */
  useEffect(() => {
    if (hydratedKey.current === storageKey) return;
    const previousKey = hydratedKey.current;
    flushKey(previousKey, latest.current);
    const draft = readDraft(storageKey);
    hydratedKey.current = storageKey;
    latest.current = { text: draft?.text ?? "", texts: draft?.texts ?? [] };
    setPrompt(draft?.text ?? "");
    /* 新 key 没有草稿时必须清空旧 key 的文本附件，否则下一次防抖会把旧附件写进新 key。 */
    restoreRef.current(draft?.texts ?? []);
    setRestored(draft !== null);
  }, [storageKey, flushKey]);

  /* 输入或附件变化后防抖保存；空输入由 draftStore 视为清除。 */
  useEffect(() => {
    if (hydratedKey.current !== storageKey) return;
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = 0;
    }
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      if (hydratedKey.current !== storageKey) return;
      const value = latest.current;
      flushKey(storageKey, value);
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = 0;
      }
    };
  }, [storageKey, prompt, texts, flushKey]);

  /* 卸载（例如输入后马上返回列表）时用最新值补存一次。 */
  useEffect(() => {
    const key = storageKey;
    return () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = 0;
      }
      flushKey(key, latest.current);
    };
  }, [storageKey, flushKey]);

  /* 手机切到后台/被回收时不一定走 React 卸载；在 pagehide/隐藏时也补存，
     避免连续输入期间 debounce 还没落盘就丢掉最后一段。 */
  useEffect(() => {
    const flushNow = () => flushKey(storageKey, latest.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushNow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushNow);
    };
  }, [storageKey, flushKey]);

  const clearDraft = useCallback(() => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = 0;
    }
    /* 同步清空 ref：同一次事件里紧接着卸载时，flush 不能把刚发送的内容又存回去。 */
    latest.current = { text: "", texts: [] };
    draftStore.clear(storageKey);
    setPrompt("");
    setRestored(false);
  }, [storageKey]);

  const dismissRestored = useCallback(() => setRestored(false), []);

  return { prompt, setPrompt, restored, dismissRestored, clearDraft };
}
