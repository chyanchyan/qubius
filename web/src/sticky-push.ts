/**
 * 吸顶用户消息被下一条消息顶走时，需要向上推出的距离。
 *
 * 新消息从下方升上来，碰到吸顶气泡的下沿（pinnedTop + height）后开始把整条
 * 气泡往上推，而不是直接盖在它上面——两层都可见时文字会叠成一团。新消息越过
 * 下沿多少就推多少，推到它到达吸附线（nextTop <= pinnedTop）时旧气泡刚好整条
 * 让出，下一条无缝接替。
 *
 * 返回值：0 表示还没接触，正数表示整条气泡上移的像素数（最多一个自身高度）。
 * 坐标为同一个坐标系（getBoundingClientRect 的视口坐标即可）；没有下一条时
 * 传 Infinity。输入异常（NaN、高度非正）按不推处理，避免把气泡推飞。
 */
export function pinnedPushOffset(pinnedTop: number, height: number, nextTop: number): number {
  if (!(height > 0)) return 0;
  const overlap = pinnedTop + height - nextTop;
  if (!(overlap > 0)) return 0;
  return Math.min(overlap, height);
}
