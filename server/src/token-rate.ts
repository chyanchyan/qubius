/**
 * 实时输出速度计（tokens/s）。
 *
 * 服务端的流式增量没有单独用量，只能按字符估算：CJK 约 1 字 1 token，
 * 其它字符约 4 字符 1 token（与前端 thinking.ts 的估算口径一致）。这里不做
 * 正文扫描，只在增量（或子 agent 的整块输出）到达时往固定大小的分桶里累加
 * 一个浮点数，读取时汇总最近窗口的桶，单次成本与增量量级无关。
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
    this.add(estimateTokens(text), now);
  }

  /**
   * 记录一段在 (from, to] 期间生成、到 to 才整体到达的内容。
   *
   * 子 agent 没有流式增量（SDK 只下发完整消息），只能等一块内容完成才知道
   * 它生成了多少；如果整块都记到当前桶，速度会在到达瞬间冲出几十倍。这里按
   * 生成区间均摊，只把落在窗口内的比例记入对应桶：一块 60 秒写完的正文，
   * 现在读到的速度就是它的平均速度，而不是一次尖峰。
   */
  noteSpan(text: string, from: number, to = Date.now()): void {
    const tokens = estimateTokens(text);
    if (tokens <= 0) return;
    const span = to - from;
    if (!(span > 0)) {
      this.add(tokens, to);
      return;
    }
    const cutoff = to - TOKEN_RATE_WINDOW_MS;
    // 整块都在窗口内：直接记到当前桶。
    if (from >= cutoff) {
      this.add(tokens, to);
      return;
    }
    // 逐桶摊开窗口内的那部分。起点对齐到窗口内第一个完整桶：旧桶的键会和最新
    // 桶共用下标，写到窗口外反而会覆盖刚记下的数据。
    const first = (Math.floor(cutoff / BUCKET_MS) + 1) * BUCKET_MS;
    if (first >= to) {
      this.add(tokens * ((to - cutoff) / span), to);
      return;
    }
    const inWindow = tokens * ((to - first) / span);
    const window = to - first;
    for (let cursor = first; cursor < to; cursor += BUCKET_MS) {
      const bucketEnd = Math.min(cursor + BUCKET_MS, to);
      this.add(inWindow * ((bucketEnd - cursor) / window), cursor);
    }
  }

  private add(tokens: number, at: number): void {
    if (!(tokens > 0)) return;
    const bucketAt = at - (at % BUCKET_MS);
    const index = Math.floor(bucketAt / BUCKET_MS) % BUCKET_COUNT;
    const bucket = this.buckets[index];
    if (bucket && bucket.at === bucketAt) bucket.tokens += tokens;
    else this.buckets[index] = { at: bucketAt, tokens };
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
