import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
} from "react";
import type { OutgoingImage } from "./api";
import { MAX_ATTACHMENTS, prepareImage } from "./images";
import {
  isTextFile,
  MAX_TEXT_ATTACHMENTS,
  MAX_TEXT_TOTAL_CHARS,
  readTextAttachment,
  TEXT_ACCEPT,
  type TextAttachment,
} from "./text-attachments";

export type { TextAttachment } from "./text-attachments";

export interface AttachmentState {
  images: OutgoingImage[];
  texts: TextAttachment[];
  busy: boolean;
  error: string;
  add: (files: FileList | File[] | null | undefined) => Promise<void>;
  remove: (index: number) => void;
  removeText: (index: number) => void;
  /** 恢复本地草稿里的文本附件；图片不持久化。 */
  restoreTexts: (texts: TextAttachment[]) => void;
  /** 发送失败时把刚清空的图片放回输入区，便于直接重发。 */
  restoreImages: (images: OutgoingImage[]) => void;
  clear: () => void;
  setError: (message: string) => void;
}

export function useAttachments(): AttachmentState {
  const [images, setImages] = useState<OutgoingImage[]>([]);
  const [texts, setTexts] = useState<TextAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingAdds = useRef(0);

  /* add 要在并发批次间读到最新的已挂载数量，但把 lengths 写进依赖会让函数
     引用随附件变化而失效；用 ref 取最新值，函数本身保持稳定。 */
  const imagesRef = useRef(images);
  const textsRef = useRef(texts);
  imagesRef.current = images;
  /* texts 只通过 commitTexts 写 ref，不能在渲染期用可能较旧的 state 覆盖它。 */

  /* 文本增删都在同一 tick 内同步更新 ref 再 setState：并发 add 的第二批
     一定读到第一批刚提交的文本，总字符上限不会被两批同时用旧数据绕过。 */
  const commitTexts = useCallback((next: TextAttachment[]) => {
    textsRef.current = next;
    setTexts(next);
  }, []);

  /* 同一批里可能重复产生同一条上限提示（预检 + 提交时复检），统一去重。 */
  const reportMessages = useCallback((messages: string[]) => {
    const unique = [...new Set(messages)];
    if (unique.length > 0) setError(unique.join("；"));
  }, []);

  const add = useCallback(async (files: FileList | File[] | null | undefined): Promise<void> => {
    if (!files) return;
    const list = Array.from(files);
    const imageFiles = list.filter((file) => file.type.startsWith("image/"));
    const textFiles = list.filter((file) => !file.type.startsWith("image/") && isTextFile(file));
    if (imageFiles.length === 0 && textFiles.length === 0) return;

    const messages: string[] = [];
    const imageRoom = Math.max(0, MAX_ATTACHMENTS - imagesRef.current.length);
    const acceptedImages = imageFiles.slice(0, imageRoom);
    if (imageFiles.length > imageRoom) {
      messages.push(`最多 ${MAX_ATTACHMENTS} 张图片，多的已忽略`);
    }
    const textRoom = Math.max(0, MAX_TEXT_ATTACHMENTS - textsRef.current.length);
    const acceptedTexts = textFiles.slice(0, textRoom);
    if (textFiles.length > textRoom) {
      messages.push(`最多 ${MAX_TEXT_ATTACHMENTS} 个文本附件，多的已忽略`);
    }

    if (acceptedImages.length === 0 && acceptedTexts.length === 0) {
      setError(messages.join("；"));
      return;
    }

    pendingAdds.current += 1;
    setBusy(true);
    setError(messages.join("；"));
    try {
      const [imageResult, textResult] = await Promise.allSettled([
        prepareAll(acceptedImages),
        readAllText(acceptedTexts),
      ]);
      if (imageResult.status === "fulfilled") {
        const prepared = imageResult.value;
        // 并发 add 时在更新函数里重新算余量，避免用渲染期闭包把另一批挤掉。
        setImages((current) => {
          const roomNow = MAX_ATTACHMENTS - current.length;
          return roomNow > 0 ? [...current, ...prepared.slice(0, roomNow)] : current;
        });
      } else {
        messages.push(reasonMessage(imageResult.reason, "无法读取图片"));
      }
      if (textResult.status === "fulfilled") {
        const { attachments: read, errors } = textResult.value;
        messages.push(...errors);
        /* 读取是异步的，真正提交时才重新以 textsRef 为基准做总数/总长度裁剪；
           commitTexts 同步写 ref，因此并发批次不会同时通过同一条上限。 */
        const current = textsRef.current;
        const roomNow = Math.max(0, MAX_TEXT_ATTACHMENTS - current.length);
        let used = current.reduce((sum, item) => sum + item.content.length, 0);
        const fitted: TextAttachment[] = [];
        const skipped = new Set<string>();
        for (const item of read) {
          if (fitted.length >= roomNow) {
            skipped.add(`最多 ${MAX_TEXT_ATTACHMENTS} 个文本附件，多的已忽略`);
            continue;
          }
          if (used + item.content.length > MAX_TEXT_TOTAL_CHARS) {
            skipped.add(`${item.name} 让文本附件总长度超过上限，已忽略`);
            continue;
          }
          used += item.content.length;
          fitted.push(item);
        }
        messages.push(...skipped);
        if (fitted.length > 0) commitTexts([...current, ...fitted]);
      } else {
        messages.push(reasonMessage(textResult.reason, "无法读取文本文件"));
      }
      reportMessages(messages);
    } finally {
      pendingAdds.current -= 1;
      if (pendingAdds.current === 0) setBusy(false);
    }
  }, [commitTexts, reportMessages]);

  const remove = useCallback((index: number) => {
    setImages((current) => current.filter((_, item) => item !== index));
  }, []);

  const removeText = useCallback((index: number) => {
    commitTexts(textsRef.current.filter((_, item) => item !== index));
  }, [commitTexts]);

  /* 发送失败时恢复图片；仍按当前余量裁剪，避免并发修改突破上限。 */
  const restoreImages = useCallback((restored: OutgoingImage[]) => {
    if (restored.length === 0) return;
    setImages((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      return room > 0 ? [...current, ...restored.slice(0, room)] : current;
    });
  }, []);

  const restoreTexts = useCallback((restored: TextAttachment[]) => {
    /* 公开接口也要守住总长度；草稿层已裁剪，但直接调用时不能绕过。 */
    const fitted: TextAttachment[] = [];
    let used = 0;
    for (const item of restored) {
      if (fitted.length >= MAX_TEXT_ATTACHMENTS) break;
      if (used + item.content.length > MAX_TEXT_TOTAL_CHARS) continue;
      used += item.content.length;
      fitted.push(item);
    }
    commitTexts(fitted);
  }, [commitTexts]);

  const clear = useCallback(() => {
    imagesRef.current = [];
    setImages([]);
    commitTexts([]);
    setError("");
  }, [commitTexts]);

  const setErrorMessage = useCallback((message: string) => setError(message), []);

  /* 父组件把整个对象传给 Composer；只在附件/忙碌/错误真正变化时换引用，
     配合 Composer 的 memo 避免无关渲染。 */
  return useMemo(() => ({
    images,
    texts,
    busy,
    error,
    add,
    remove,
    removeText,
    restoreTexts,
    restoreImages,
    clear,
    setError: setErrorMessage,
  }), [images, texts, busy, error, add, remove, removeText, restoreTexts, restoreImages, clear, setErrorMessage]);
}

function reasonMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * 解码并发限制为 2：4 张手机原图同时解码的峰值内存可达数倍，
 * 低端移动端可能直接重载页面。结果顺序与输入保持一致。
 */
async function prepareAll(files: File[]): Promise<OutgoingImage[]> {
  const results = new Array<OutgoingImage>(files.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next;
      next += 1;
      results[index] = await prepareImage(files[index]);
    }
  }
  await Promise.all([worker(), worker()]);
  return results;
}

/**
 * 文本读取同样限制并发 2；单个文件失败只跳过它并汇总错误，
 * 不拖垮同批里的其他文件。
 */
async function readAllText(files: File[]): Promise<{ attachments: TextAttachment[]; errors: string[] }> {
  const results = new Array<TextAttachment | undefined>(files.length);
  const errors: string[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await readTextAttachment(files[index]);
      } catch (reason) {
        errors.push(reasonMessage(reason, `${files[index].name} 无法读取`));
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return {
    attachments: results.filter((item): item is TextAttachment => item !== undefined),
    errors,
  };
}

export function pastedImages(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
}

const textChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "calc(6px * var(--control-scale))",
  width: "auto",
  maxWidth: "14rem",
  height: "auto",
  padding:
    "calc(2px * var(--control-scale)) calc(4px * var(--control-scale)) calc(2px * var(--control-scale)) calc(8px * var(--control-scale))",
  border: "1px solid var(--line)",
  borderRadius: 5,
  background: "var(--elev)",
  color: "var(--muted)",
  fontSize: "var(--fs-12)",
};

const textNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const textSizeStyle: CSSProperties = { flex: "none", opacity: 0.7 };

const textRemoveStyle: CSSProperties = {
  position: "static",
  top: "auto",
  right: "auto",
  flex: "none",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, "")}MB`;
}

export const AttachmentStrip = memo(function AttachmentStrip({ images, texts, onRemove, onRemoveText }: {
  images: OutgoingImage[];
  texts: TextAttachment[];
  onRemove: (index: number) => void;
  onRemoveText: (index: number) => void;
}) {
  if (images.length === 0 && texts.length === 0) return null;
  return (
    <div className="attachments">
      {texts.map((text, index) => (
        <div className="attachment text-attachment" style={textChipStyle} key={`${text.name}-${index}`}>
          <span style={textNameStyle} title={text.name}>{text.name}</span>
          <span style={textSizeStyle}>{formatBytes(text.bytes)}</span>
          <button
            type="button"
            className="attachment-remove"
            style={textRemoveStyle}
            onClick={() => onRemoveText(index)}
            aria-label={`移除文本附件 ${index + 1}`}
          >
            ×
          </button>
        </div>
      ))}
      {images.map((image, index) => (
        <figure className="attachment" key={`${image.name || "image"}-${index}`}>
          <img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name || `图片 ${index + 1}`} />
          <button
            type="button"
            className="attachment-remove"
            onClick={() => onRemove(index)}
            aria-label={`移除图片 ${index + 1}`}
          >
            ×
          </button>
        </figure>
      ))}
    </div>
  );
});

export const AttachButton = memo(function AttachButton({ disabled, onFiles }: { disabled?: boolean; onFiles: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="attach-btn"
        disabled={disabled}
        title="添加图片或文本文件"
        aria-label="添加图片或文本文件"
        onClick={() => inputRef.current?.click()}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2.5" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={`image/*,${TEXT_ACCEPT}`}
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          if (files) onFiles(files);
          event.target.value = "";
        }}
      />
    </>
  );
});
