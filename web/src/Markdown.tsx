import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { classifyImageSrc } from "./markdown-images";
import { fenceKind } from "./markdown-fences";
import "./components/Markdown.css";

const remarkPlugins = [remarkGfm];

/* 只注册常用语言；全量 highlight.js 会把上百种语法塞进 chunk。
   按需 register 后未知语言回退纯文本。 */
const LANGUAGES: Array<[string, LanguageFn]> = [
  ["javascript", javascript],
  ["typescript", typescript],
  ["python", python],
  ["bash", bash],
  ["json", json],
  ["css", css],
  ["xml", xml],
  ["sql", sql],
  ["go", go],
  ["rust", rust],
  ["yaml", yaml],
  ["markdown", markdown],
  ["diff", diff],
  ["java", java],
  ["c", c],
  ["cpp", cpp],
  ["php", php],
  ["ruby", ruby],
  ["kotlin", kotlin],
];
for (const [name, language] of LANGUAGES) hljs.registerLanguage(name, language);

const REGISTERED = new Set(LANGUAGES.map(([name]) => name));

/* 代码围栏里的常见别名（js/ts/html/yml...）映射到已注册语言。 */
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  htm: "xml",
  html: "xml",
  svg: "xml",
  yml: "yaml",
  md: "markdown",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
};

/** 取出 code 子节点的语言与纯文本；不是代码块时返回 null，保持原有渲染。 */
function readCode(children: ReactNode): { language: string; code: string } | null {
  const first = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(first)) return null;
  const className = first.props.className ?? "";
  const match = /\blanguage-([\w+#.-]+)/.exec(className);
  return {
    language: match ? match[1].toLowerCase() : "",
    code: nodeText(first.props.children),
  };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

/** 复制成功返回 true；非安全上下文或权限拒绝时回退 textarea + execCommand。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 走下面的兜底。
  }
  let area: HTMLTextAreaElement | undefined;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area?.remove();
  }
}

const COPY_FEEDBACK_MS = 1600;

/* 围栏里的 Markdown 文档递归渲染时的最大层数；超出后按代码显示，异常输入也不会无限嵌套。 */
const MAX_MARKDOWN_DEPTH = 4;
const MarkdownDepth = createContext(0);

/** 复制按钮：状态只影响自己，点复制时不会连带重渲染整块正文（Markdown 文档会重新解析）。 */
function CopyButton({ text, kind }: { text: string; kind: "code" | "markdown" }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const copyRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const ok = await writeClipboard(text);
    /* 复制是异步的，期间消息可能已被卸载；不要再 setState。 */
    if (!mounted.current) return;
    /* execCommand 兜底会把焦点给临时 textarea，复制完把焦点还给按钮。 */
    copyRef.current?.focus();
    setCopyState(ok ? "copied" : "failed");
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (mounted.current) setCopyState("idle");
    }, COPY_FEEDBACK_MS);
  }

  const idle = kind === "markdown" ? "复制 Markdown 源码" : "复制代码";
  const copied = kind === "markdown" ? "Markdown 源码已复制" : "代码已复制";
  const failed = kind === "markdown" ? "复制 Markdown 源码失败" : "复制代码失败";
  const label = copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制";
  const ariaLabel = copyState === "copied" ? copied : copyState === "failed" ? failed : idle;
  const status = copyState === "copied" ? copied : copyState === "failed" ? failed : "";

  return (
    <>
      <button
        ref={copyRef}
        type="button"
        className="md-code-copy"
        data-state={copyState === "idle" ? undefined : copyState}
        onClick={() => void copy()}
        aria-label={ariaLabel}
      >
        {label}
      </button>
      <span className="md-code-status" role="status" aria-live="polite">
        {status}
      </span>
    </>
  );
}

/**
 * 围栏块：语言标签 + 复制按钮 + highlight.js 高亮。
 * `markdown` 围栏，以及内容明显是文档的无语言围栏，默认渲染成 Markdown（仍在同一个
 * 可复制容器里，可切回源码）；高亮失败的未知语言只渲染纯文本节点，不注入 HTML。
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const info = readCode(children);
  const language = info?.language ?? "";
  const code = info?.code ?? "";
  const kind = info ? fenceKind(language, code) : "code";
  const depth = useContext(MarkdownDepth);
  const [showSource, setShowSource] = useState(false);
  const canRenderDoc = kind === "markdown" && depth < MAX_MARKDOWN_DEPTH;
  const doc = canRenderDoc && !showSource;

  /* 源码视图里，无语言但按文档识别的内容也用 markdown 语法高亮。
     预览态不跑高亮：整篇文档交给 Markdown 渲染，没必要再高亮一遍源码。 */
  const hljsLanguage = ALIASES[language] ?? (language || (kind === "markdown" ? "markdown" : ""));
  const supported = Boolean(info) && !doc && REGISTERED.has(hljsLanguage);

  const highlighted = useMemo(() => {
    if (!supported) return null;
    try {
      return hljs.highlight(code, { language: hljsLanguage, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [supported, code, hljsLanguage]);

  if (!info) return <pre>{children}</pre>;
  if (kind === "hidden") return null;

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{kind === "markdown" ? "markdown" : language || "代码"}</span>
        <div className="md-code-actions">
          {canRenderDoc && (
            <button
              type="button"
              className="md-code-toggle"
              aria-pressed={showSource}
              title={showSource ? "按 Markdown 渲染" : "查看 Markdown 源码"}
              onClick={() => setShowSource((value) => !value)}
            >
              {showSource ? "预览" : "源码"}
            </button>
          )}
          <CopyButton text={code} kind={kind === "markdown" ? "markdown" : "code"} />
        </div>
      </div>
      {doc ? (
        <div className="md-code-doc">
          <MarkdownDepth.Provider value={depth + 1}>
            <MarkdownDocument text={code} />
          </MarkdownDepth.Provider>
        </div>
      ) : highlighted !== null ? (
        <pre className="md-code-pre">
          <code
            className={`hljs language-${hljsLanguage}`}
            /* 仅注入 highlight.js 转义后的输出，原文绝不走 innerHTML。 */
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      ) : (
        <pre className="md-code-pre">
          <code className={language ? `language-${language}` : undefined}>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** 围栏里的 Markdown 文档：共用同一套 components，嵌套代码块仍有高亮和复制。 */
const MarkdownDocument = memo(function MarkdownDocument({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});

/** 外部图片按钮上的 host；解析失败不回显原文，避免带出敏感 query。 */
function imageHost(src: string): string {
  try {
    return new URL(src, "https://markdown.invalid").host || "未知来源";
  } catch {
    return "未知来源";
  }
}

/**
 * 图片：同源/内联资源直接显示；外部 http(s) 先显示占位按钮，用户点击后
 * 才发起请求，避免被提示词注入的 Markdown 借图片 URL 自动外传数据。
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const source = (src ?? "").trim();
  const kind = classifyImageSrc(source);
  /* 记住用户点过的具体地址：流式内容换成别的外链时要重新确认。 */
  const [approved, setApproved] = useState<string | null>(null);

  if (kind === "blocked") return null;
  if (kind === "inline") return <img src={source} alt={alt ?? ""} loading="lazy" />;
  if (approved === source) {
    return <img src={source} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
  }

  const host = imageHost(source);
  const description = `外部图片 · ${host}（点击加载）`;
  const label = alt?.trim() ? `${alt.trim()} · ${description}` : description;
  return (
    <button
      type="button"
      title={source}
      onClick={() => setApproved(source)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        maxWidth: "100%",
        padding: "calc(2px * var(--control-scale)) calc(8px * var(--control-scale))",
        border: "1px dashed var(--line)",
        borderRadius: 6,
        background: "transparent",
        color: "var(--muted)",
        fontSize: "var(--fs-12)",
        cursor: "pointer",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    return (
      <a href={safe} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

/**
 * 流式输出时历史消息的内容不变，按 text 跳过重渲染，避免每次都重解析
 * 整段 Markdown。
 */
export const Markdown = memo(
  function Markdown({ text }: { text: string }) {
    return (
      <div className="md">
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    );
  },
  (previous, next) => previous.text === next.text,
);
