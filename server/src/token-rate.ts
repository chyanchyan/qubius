/**
 * 实时输出速度计（tokens/s）。
 *
 * 服务端的流式增量没有单独用量，只能按字符估算：CJK 约 1 字 1 token，
 * 其它字符约 4 字符 1 token（与前端 thinking.ts 的估算口径一致）。这里不做
 * 正文扫描，只在增量到达时往固定大小的分桶里累加一个浮点数，读取时汇总
 * 最近窗口的桶，单次成本与增量量级无关。
 */

/** 滑动窗口：速度按最近 2 秒的平均输出计算。 */
export const TOKEN_RATE_WINDOW_MS = 2_000;
const BUCKET_MS = 250;
const BUCKET_COUNT = TOKEN_RATE_WINDOW_MS / BUCKET_MS;

/** CJK 字符（中日韩）大约 1 字符 1 token，其它字符大约 4 字符 1 token。 */
const CJK_RE = /[㐀-鿿぀-ヿ가-힯]/gu;

/**
 * 估算一段流式增量产生的 token 数。
 * 返回小数，调用方在窗口内累加后统一取整；不要对单个片段做四舍五入，
 * 否则每来一个单字符增量都会至少记 1 个 token，把速度放大好几倍。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return cjk + (text.length - cjk) / 4;
}

interface Bucket {
  /** 对齐到 BUCKET_MS 的桶起点。 */
  at: number;
  tokens: number;
}

/** 单个会话的实时输出速度计；只存在内存里，不落盘。 */
export class TokenRateMeter {
  private readonly buckets: Array<Bucket | undefined> = new Array(BUCKET_COUNT).fill(undefined);

  /** 记录一段增量文本（正文、思考或工具输入）。 */
  note(text: string, now = Date.now()): void {
    const tokens = estimateTokens(text);
    if (tokens <= 0) return;
    const at = now - (now % BUCKET_MS);
    const index = Math.floor(at / BUCKET_MS) % BUCKET_COUNT;
    const bucket = this.buckets[index];
    if (bucket && bucket.at === at) bucket.tokens += tokens;
    else this.buckets[index] = { at, tokens };
  }

  /** 最近窗口的平均输出速度（tokens/s）；没有增量后随窗口滑出自然归零。 */
  rate(now = Date.now()): number {
    const cutoff = now - TOKEN_RATE_WINDOW_MS;
    let tokens = 0;
    for (const bucket of this.buckets) {
      if (bucket && bucket.at > cutoff) tokens += bucket.tokens;
    }
    return tokens / (TOKEN_RATE_WINDOW_MS / 1000);
  }
}
