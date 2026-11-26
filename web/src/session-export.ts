import {
  getSession,
  imageUrl,
  PHASE_LABEL,
  type ImageRef,
  type Session,
  type Transcript,
} from "./api";
import { formatMessageFullTime } from "./format";

/**
 * 会话导出为 Markdown。纯函数部分（sessionToMarkdown）不触碰 DOM，测试可以直接跑；
 * downloadSessionMarkdown 负责在浏览器里生成 Blob 并触发下载。
 */

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Markdown 图片 alt 里的方括号/换行会让语法断掉，简单清掉。 */
function imageAlt(image: ImageRef): string {
  const name = oneLine(image.name ?? "");
  return (name || "图片").replace(/[[\]\r\n]/g, " ");
}

function imageLines(sessionId: string, images: ImageRef[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  return images.map((image) => `![${imageAlt(image)}](${imageUrl(sessionId, image)})`);
}

function heading(label: string, at?: string): string {
  const time = formatMessageFullTime(at);
  return time ? `## ${label} · ${time}` : `## ${label}`;
}

function transcriptToMarkdown(sessionId: string, item: Transcript): string[] {
  const images = imageLines(sessionId, item.images);

  if (item.kind === "thinking") {
    const time = formatMessageFullTime(item.at);
    return [
      "<details>",
      `<summary>思考过程${time ? ` · ${time}` : ""}</summary>`,
      "",
      item.text || "_（空）_",
      ...(images.length > 0 ? ["", ...images] : []),
      "",
      "</details>",
    ];
  }

  if (item.role === "tool") {
    const tool = item.toolName ? ` \`${item.toolName}\`` : "";
    return [
      heading(`工具${tool}`, item.at),
      "",
      item.text || "_（无输出）_",
      ...(images.length > 0 ? ["", ...images] : []),
    ];
  }

  if (item.role === "user") {
    return [
      heading("用户", item.at),
      "",
      item.text || "_（空消息）_",
      ...(images.length > 0 ? ["", ...images] : []),
    ];
  }

  return [
    heading("助手", item.at),
    "",
    item.text || "_（空消息）_",
    ...(images.length > 0 ? ["", ...images] : []),
  ];
}

export function sessionToMarkdown(session: Session): string {
  const title = oneLine(session.title) || "未命名对话";
  const lines: string[] = [`# ${title}`, "", "## 信息", ""];

  lines.push(`- 项目：\`${session.projectId}\``);
  if (session.branch) lines.push(`- 分支：\`${session.branch}\``);
  lines.push(`- 模型：${session.providerName} / ${session.model}`);
  lines.push(`- 推理强度：${session.effort}`);
  lines.push(`- 状态：${PHASE_LABEL[session.phase]}`);
  lines.push(`- 创建时间：${formatMessageFullTime(session.createdAt) || session.createdAt}`);
  lines.push(`- 更新时间：${formatMessageFullTime(session.updatedAt) || session.updatedAt}`);

  const messages = session.messages ?? [];
  if (messages.length === 0) {
    lines.push("", "---", "", "_这个对话还没有消息。_", "");
    return lines.join("\n");
  }

  for (const item of messages) {
    lines.push("", "---", "", ...transcriptToMarkdown(session.id, item));
  }
  lines.push("");
  return lines.join("\n");
}

/** 去掉跨平台文件名里的非法字符；空标题回退为「对话」。 */
export function safeFileName(title: string): string {
  const cleaned = oneLine(title)
    // Windows/POSIX 都不接受这些字符；控制字符一并清掉。
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || "对话";
}

/**
 * 本地只有最近一页历史时，导出前按需拉一次完整会话。
 * loadFull 可注入，测试不必真的走网络。
 */
export async function resolveExportSession(
  session: Session,
  loadFull: (id: string) => Promise<{ session: Session }> = getSession,
): Promise<Session> {
  const loaded = session.messages?.length ?? 0;
  if (session.messageCount === undefined || session.messageCount <= loaded) return session;
  const data = await loadFull(session.id);
  return data.session;
}

/**
 * 生成导出内容。首帧只带最近一页时先显式拉完整会话（一次性全量），
 * 否则导出的文件会缺掉更早的历史；拉取失败会向上抛，由调用方展示错误。
 */
export async function buildExportMarkdown(
  session: Session,
  loadFull: (id: string) => Promise<{ session: Session }> = getSession,
): Promise<{ markdown: string; title: string }> {
  const full = await resolveExportSession(session, loadFull);
  return { markdown: sessionToMarkdown(full), title: full.title };
}

/** 导出 Markdown；失败时抛错，调用方负责提示。 */
export async function downloadSessionMarkdown(session: Session): Promise<void> {
  const { markdown, title } = await buildExportMarkdown(session);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(title)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 等浏览器开始下载后再释放；同步 revoke 会让部分浏览器拿到空文件。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 供按钮使用：成功返回 undefined，失败返回可展示的文案（不吞掉 busy/提示状态）。 */
export async function runExport(
  session: Session,
  download: (session: Session) => Promise<void> = downloadSessionMarkdown,
): Promise<string | undefined> {
  try {
    await download(session);
    return undefined;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "导出失败";
  }
}
