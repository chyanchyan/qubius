export interface TextAttachment {
  name: string;
  content: string;
  bytes: number;
}

export const MAX_TEXT_ATTACHMENTS = 3;
export const MAX_TEXT_FILE_BYTES = 100_000;
export const MAX_TEXT_TOTAL_CHARS = 150_000;

/** 常见的纯文本 / 代码扩展名（不带点）。无扩展名的文件名也按小写文件名匹配。 */
export const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log",
  "yml", "yaml", "toml", "ini", "conf", "cfg", "xml", "html", "css",
  "scss", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go",
  "rs", "java", "kt", "kts", "c", "cc", "cpp", "h", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "prisma", "env",
  "gitignore", "dockerfile", "makefile",
] as const;

const TEXT_EXTENSION_SET = new Set<string>(TEXT_EXTENSIONS);

/** 浏览器给代码文件常见的非 text/* MIME 类型。 */
const TEXT_MIME_TYPES = new Set<string>([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-toml",
  "application/graphql",
  "application/sql",
  "application/x-sh",
  "application/x-shellscript",
]);

/** 文件选择框的 accept，供 AttachButton 和 image/* 拼接使用。 */
export const TEXT_ACCEPT = ["text/*", ...TEXT_EXTENSIONS.map((ext) => `.${ext}`)].join(",");

export function isTextFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith("text/") || TEXT_MIME_TYPES.has(type)) return true;
  const base = file.name.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : base;
  return TEXT_EXTENSION_SET.has(ext);
}

/** 只保留 basename，去掉会破坏附件标记的引号、尖括号和换行。 */
export function textAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/["'<>\r\n]/g, "").trim();
  return cleaned || "附件";
}

export async function readTextAttachment(file: File): Promise<TextAttachment> {
  if (!isTextFile(file)) throw new Error(`${file.name} 不是文本文件`);
  if (file.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`${file.name} 超过 ${Math.round(MAX_TEXT_FILE_BYTES / 1000)}KB`);
  }
  const content = await file.text();
  return { name: textAttachmentName(file.name), content, bytes: file.size };
}

/**
 * 把文本附件包成一段标记，放在用户输入后面。用户输入在前，服务端用
 * 第一行生成标题/摘要时不会变成 `<attachments>`；prompt 为空时补一句
 * “（见附件）”作为可见的占位。
 */
export function mergeTextAttachments(prompt: string, texts: TextAttachment[]): string {
  if (texts.length === 0) return prompt;
  const userPrompt = prompt.trim();
  // 按转义后的实际长度校验，避免内容里大量结束标签让合并结果超过服务端上限。
  const escaped = texts.map((text) => ({ ...text, content: escapeClosingTags(text.content) }));
  const totalChars = escaped.reduce((sum, text) => sum + text.content.length, 0) + userPrompt.length;
  if (totalChars > MAX_TEXT_TOTAL_CHARS) {
    throw new Error(`附件和输入合计不能超过 ${MAX_TEXT_TOTAL_CHARS} 字符`);
  }
  const files = escaped
    .map((text) => `<file name="${textAttachmentName(text.name)}">\n${text.content}\n</file>`)
    .join("\n");
  const block = `<attachments>\n${files}\n</attachments>`;
  return `${userPrompt || "（见附件）"}\n\n${block}`;
}

/** 文件内容里的结束标签会截断附件块，转义成可见文本。 */
function escapeClosingTags(content: string): string {
  return content
    .replace(/<\/attachments>/gi, "&lt;/attachments&gt;")
    .replace(/<\/file>/gi, "&lt;/file&gt;");
}

/**
 * 展示用：只折叠位于消息末尾、由本客户端生成的附件块。用户正文中间
 * 讨论 `<attachments>` 时保持原样。
 */
export function splitTextAttachments(text: string): { text: string; files: string[] } {
  if (!text.includes("<attachments>")) return { text, files: [] };
  const match = text.match(/(?:^|\n\n)(<attachments>[\s\S]*?<\/attachments>)\s*$/);
  if (!match) return { text, files: [] };
  const files = [...(match[1] ?? "").matchAll(/<file name="([^"]*)">/g)]
    .map((item) => item[1] || "附件");
  return { text: text.slice(0, match.index).trim(), files };
}
