/**
 * 流式文本的 token 估算。
 *
 * 服务端不会为流式片段单独提供用量；这里按字符粗略估算，只用于
 * 「思考中… N tokens」和精简档的实时计数这类提示，不参与正式用量统计。
 */

/** CJK 字符（中日韩）大约 1 字符 1 token，其它字符大约 4 字符 1 token。 */
const CJK_RE = /[㐀-鿿぀-ヿ가-힯]/gu;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 4));
}

/** 思考耗时：不足 1 秒显示 <1s，之后按整秒，分钟级用 m分ss秒。 */
export function formatThinkingDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || (ms as number) < 0) return "";
  const value = ms as number;
  if (value < 1000) return "<1s";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const total = Math.round(value / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}
