/** 图片源的加载策略：直接显示 / 用户点击后加载 / 拒绝。 */
export type ImageSrcKind = "inline" | "external" | "blocked";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/* 浏览器解析 URL 时会吞掉制表符/换行，含控制字符的源一律不认。 */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * 把 Markdown 里的图片源分类：
 * - inline：同源/内联资源，打开即可安全显示。
 * - external：外部 http(s)，需要用户点击后才发起请求，避免提示词注入导致自动外传数据。
 * - blocked：其它协议（javascript:、非图片 data: 等），根本不渲染。
 *
 * 纯函数，不依赖 DOM。
 */
export function classifyImageSrc(src: string): ImageSrcKind {
  if (typeof src !== "string") return "blocked";
  const value = src.trim();
  if (!value || CONTROL.test(value)) return "blocked";
  /* 浏览器对 http(s) 等特殊 scheme 会把 \ 当作 /，因此 /\host、\\host 等
     写法实际是外部地址。允许的相对形式都不含反斜杠，一律拒绝。 */
  if (value.includes("\\")) return "blocked";
  /* 协议相对地址先于「/x 相对路径」判断：//host 是外部资源。 */
  if (value.startsWith("//")) return "external";
  if (/^https?:\/\//i.test(value)) return "external";
  if (/^data:image\//i.test(value)) return "inline";
  if (/^blob:/i.test(value)) return "inline";
  /* 其它任何带 scheme 的写法（javascript:、data:text/html、ftp: ...）都拒绝。 */
  if (SCHEME.test(value)) return "blocked";
  /* 剩下的按相对路径处理：foo.png、./x、../x、/x、?x、#x。 */
  return "inline";
}
