import type { TokenUsage, Transcript } from "./api";
import {
  formatCompactTokens,
  hasTokenUsage,
  inputTokenTotal,
  safeTokenCount,
} from "./format";
import { estimateTokens } from "./thinking";

/**
 * 精简档运行指示里的实时 token 计数。
 *
 * 统计范围是「本轮」：最后一条用户消息之后的所有条目。
 * - 已完成的模型调用用服务端回传的真实 usage；
 * - 还没有 usage 的条目（流式中的思考/正文、工具输入）按字符估算输出。
 *
 * 估算只保留在最后一条 usage 之后：一次调用的 usage 已经包含同段里思考与
 * 工具输入产生的输出，把前面的估算继续留着会重复计算。代价是只有工具、没有
 * 文字输出的调用（服务端不落 usage）会被下一次调用覆盖掉，这里宁可少算也不
 * 重复算。
 */
export function currentTurnUsage(messages: readonly Transcript[]): TokenUsage | undefined {
  const start = turnStart(messages);
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let estimated = 0;
  for (let index = start; index < messages.length; index += 1) {
    const item = messages[index];
    if (item.role === "assistant" && hasTokenUsage(item.usage)) {
      usage.input += safeTokenCount(item.usage.input);
      usage.output += safeTokenCount(item.usage.output);
      usage.cacheRead += safeTokenCount(item.usage.cacheRead);
      usage.cacheWrite += safeTokenCount(item.usage.cacheWrite);
      // 这次调用的真实用量已经覆盖同一段里尚未落定的估算。
      estimated = 0;
      continue;
    }
    if (item.role === "user") continue;
    estimated += estimateTokens(item.text);
  }
  usage.output += estimated;
  if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
    return undefined;
  }
  return usage;
}

/** 本轮起点：最后一条用户消息之后；没有用户消息（旧数据/自动触发）从第一条算起。 */
function turnStart(messages: readonly Transcript[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index + 1;
  }
  return 0;
}

/**
 * 运行指示里的用量标签：还没有真实调用时输入为 0，只显示已经产生的输出，
 * 避免出现「↑0」。一旦有调用完成，就和消息元信息一样显示 ↑输入 ↓输出。
 */
export function formatTurnUsageLabel(usage: TokenUsage): string {
  const input = inputTokenTotal(usage);
  const output = safeTokenCount(usage.output);
  if (input > 0) return `↑${formatCompactTokens(input)} ↓${formatCompactTokens(output)}`;
  return `↓${formatCompactTokens(output)}`;
}
