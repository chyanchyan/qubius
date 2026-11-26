import type { TranscriptItem, UsageTotals } from "./types.js";

/** 每百万 token 的美元价格；缺失表示该项不计算成本。 */
export interface Pricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 金额统一用美元，按每百万 token 的单价换算。 */
export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageSessionInput {
  id: string;
  title: string;
  projectId: string;
  providerId: string;
  providerName: string;
  messages?: TranscriptItem[];
  /**
   * 已缓存的会话汇总（由调用方维护，例如 Store 按会话缓存）。
   * 提供时不再扫描 messages；报告里会返回独立副本，不会泄露缓存对象。
   */
  totals?: UsageTotals;
}

export interface UsageProviderInput {
  id: string;
  name: string;
  pricing?: Pricing;
}

export interface ProviderUsage {
  providerId: string;
  providerName: string;
  totals: UsageTotals;
  cost: number;
}

export interface SessionUsage {
  id: string;
  title: string;
  projectId: string;
  totals: UsageTotals;
  cost: number;
}

export interface UsageReport {
  totals: UsageTotals;
  cost: number;
  byProvider: ProviderUsage[];
  bySession: SessionUsage[];
}

const TOKENS_PER_UNIT = 1_000_000;

export function emptyTotals(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * 汇总对话里的 token 用量。只统计带 usage 的 assistant 条目；
 * 每次调用（calls）按条目计，缓存 token 单独累计。
 */
export function summarizeMessages(messages: TranscriptItem[]): UsageTotals {
  const totals = emptyTotals();
  for (const item of messages) {
    if (item.role !== "assistant" || !item.usage) continue;
    totals.calls += 1;
    totals.input += tokenCount(item.usage.input);
    totals.output += tokenCount(item.usage.output);
    totals.cacheRead += tokenCount(item.usage.cacheRead);
    totals.cacheWrite += tokenCount(item.usage.cacheWrite);
  }
  return totals;
}

/** 按每百万 token 的美元单价换算成本；没有价格时所有成本为 0。 */
export function computeCost(totals: UsageTotals, pricing?: Pricing): Cost {
  if (!pricing) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  const input = (totals.input / TOKENS_PER_UNIT) * rate(pricing.input);
  const output = (totals.output / TOKENS_PER_UNIT) * rate(pricing.output);
  const cacheRead = (totals.cacheRead / TOKENS_PER_UNIT) * rate(pricing.cacheRead);
  const cacheWrite = (totals.cacheWrite / TOKENS_PER_UNIT) * rate(pricing.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * 生成用量报告：总会列出传入的每套接口（即使还没有用量），
 * 会话按传入顺序返回，由前端决定展示哪几条。
 */
export function usageReport(
  sessions: UsageSessionInput[],
  providers: UsageProviderInput[],
): UsageReport {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const totals = emptyTotals();
  const byProvider = new Map<string, ProviderUsage>();
  for (const provider of providers) {
    byProvider.set(provider.id, {
      providerId: provider.id,
      providerName: provider.name,
      totals: emptyTotals(),
      cost: 0,
    });
  }

  const bySession = sessions.map((session) => {
    // 缓存命中时复制一份，避免把调用方缓存里的可变对象直接暴露给报告使用方。
    const sessionTotals = session.totals
      ? { ...session.totals }
      : summarizeMessages(session.messages ?? []);
    const pricing = providerById.get(session.providerId)?.pricing;
    const sessionCost = computeCost(sessionTotals, pricing).total;
    addTotals(totals, sessionTotals);

    let group = byProvider.get(session.providerId);
    if (!group) {
      // 配置已经被删掉的旧会话也要有归属，用会话里记录的名字兜底。
      group = {
        providerId: session.providerId,
        providerName: session.providerName || session.providerId,
        totals: emptyTotals(),
        cost: 0,
      };
      byProvider.set(session.providerId, group);
    }
    addTotals(group.totals, sessionTotals);
    group.cost += sessionCost;

    return {
      id: session.id,
      title: session.title,
      projectId: session.projectId,
      totals: sessionTotals,
      cost: sessionCost,
    };
  });

  const cost = [...byProvider.values()].reduce((sum, group) => sum + group.cost, 0);
  return { totals, cost, byProvider: [...byProvider.values()], bySession };
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.calls += source.calls;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function rate(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
